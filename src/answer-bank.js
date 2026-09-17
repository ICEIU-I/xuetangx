const { createHash } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const http = require('./http');
const courseService = require('./video');
const defaultStore = require('./answer-store');

function id(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label}无效`);
  return number;
}
const typeOf = type => ({ SingleChoice: 'choice', MultipleChoice: 'multi', MultiChoice: 'multi', Judgement: 'judge', FillBlank: 'fill' }[type] || 'reference');
const textValue = value => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && String(value).length > 0;

// 只使用服务器标准答案字段；my_answer / my_answers 从不作为标准答案。
function extractAnswer(problem, source, sourceName) {
  if (!source || source.is_show_answer !== true) return null;
  const type = typeOf(problem.content.Type);
  const values = Array.isArray(source.answer) ? source.answer : source.answer != null ? [source.answer] : [];
  const keys = (problem.content.Options || []).map(option => String(option.key));
  let answer;
  if (type === 'choice' || type === 'multi') {
    if (!values.length || !values.every(value => textValue(value) && keys.includes(String(value))) || (type === 'choice' && values.length !== 1)) return null;
    answer = type === 'choice' ? { answer: String(values[0]) } : { answers: [...new Set(values.map(String))] };
  } else if (type === 'judge') {
    const value = String(values[0]);
    if (!['true', 'false', '1', '0', '正确', '错误'].includes(value)) return null;
    answer = { answer: ['true', '1', '正确'].includes(value) ? '正确' : '错误' };
  } else if (type === 'fill') {
    const blanks = source.answers;
    if (!blanks || typeof blanks !== 'object' || !Object.keys(blanks).length) return null;
    const entries = Object.keys(blanks).sort((a, b) => Number(a) - Number(b)).map(key => Array.isArray(blanks[key]) ? blanks[key] : [blanks[key]]);
    const count = problem.content.Blanks?.length || problem.content.blanks?.length;
    if ((count && entries.length !== count) || !entries.every(entry => entry.length && entry.every(textValue))) return null;
    answer = { answers: entries.map(entry => String(entry[0])), accepted_answers: blanks };
  } else {
    const raw = source.answer ?? source.answers;
    if (raw == null || raw === '' || (typeof raw === 'object' && !Object.keys(raw).length)) return null;
    answer = { reference_answer: raw, error: '参考答案题型，暂不支持自动提交' };
  }
  return { type, ...answer, answer_status: 'captured', source: sourceName };
}

function probeAnswer(problem) {
  const type = typeOf(problem.content.Type);
  const first = problem.content.Options?.[0]?.key;
  if ((type === 'choice' || type === 'multi') && first != null) return { answer: [String(first)], answers: {} };
  if (type === 'judge') return { answer: ['true'], answers: {} };
  const count = problem.content.Blanks?.length || problem.content.blanks?.length;
  if (type === 'fill' && count) return { answer: '', answers: Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), '0'])) };
  return null;
}

function summary(database) {
  const exercises = Object.values(database.exercises).filter(exercise => exercise.active !== false);
  const questions = exercises.flatMap(exercise => exercise.questions || []);
  const capturedAnswers = questions.filter(question => question.answer_status === 'captured').length;
  const failedExercises = exercises.filter(exercise => exercise.error).length;
  const processedExercises = exercises.filter(exercise => exercise.scanned || exercise.error).length;
  const complete = processedExercises === exercises.length && !failedExercises && capturedAnswers === questions.length;
  return { course: database.course, totalExercises: exercises.length, processedExercises, totalQuestions: questions.length,
    capturedAnswers, missingAnswers: questions.length - capturedAnswers, failedExercises, complete,
    exercises: exercises.map(exercise => ({ leafId: exercise.leaf_id, title: exercise.section, total: exercise.questions?.length || 0,
      captured: (exercise.questions || []).filter(question => question.answer_status === 'captured').length, error: exercise.error || null })) };
}

function createAnswerService({ transport = http, courses = courseService, store = defaultStore, sleep = wait, now = Date.now, requestInterval = 1500, submitInterval = 3500, maxRetries = 3 } = {}) {
  let nextRequest = 0, nextSubmission = 0;
  async function call(method, endpoint, body, cookie, context) {
    for (let attempt = 0; ; attempt++) {
      context.signal?.throwIfAborted();
      const delay = Math.max(0, nextRequest - now(), method === 'POST' ? nextSubmission - now() : 0);
      if (delay) await sleep(delay, undefined, { signal: context.signal });
      context.signal?.throwIfAborted();
      nextRequest = now() + requestInterval;
      if (method === 'POST') nextSubmission = now() + submitInterval;
      const opts = { signal: context.signal, headers: { xtbz: 'xt', Referer: context.courseUrl, 'X-Requested-With': 'XMLHttpRequest' } };
      const response = await (method === 'GET' ? transport.get(endpoint, cookie, opts) : transport.post(endpoint, body, cookie, opts));
      if (response.status === 429 && attempt < maxRetries) {
        const seconds = response.retryAfter != null ? Number(response.retryAfter) : Number(/(\d+(?:\.\d+)?)\s*seconds?/.exec(response.json?.detail || '')?.[1]);
        const ms = Number.isFinite(seconds) ? Math.max(1000, seconds * 1000 + 1000) : 60000;
        context.onProgress({ stage: 'waiting', message: `平台限速，等待 ${Math.ceil(ms / 1000)} 秒后继续` });
        await sleep(ms, undefined, { signal: context.signal });
        continue;
      }
      const json = response.json;
      if (response.status !== 200 || !json || json.success === false || (json.code != null && ![0, '0'].includes(json.code))) {
        const error = new Error(`接口请求失败（HTTP ${response.status}${json?.error_code ? `，code ${json.error_code}` : ''}）`);
        error.stopCollection = [401, 403, 429].includes(response.status);
        error.definitelyRejected = [401, 403, 429].includes(response.status);
        throw error;
      }
      return json.data;
    }
  }

  async function discover(courseUrl, cookie, context) {
    const target = courseService.parseCourseUrl(courseUrl);
    const list = await courses.listCourses(cookie, context.signal, context.onProgress);
    const course = list.find(item => item.classroomId === target.classroomId && item.sign === target.sign && item.courseSign === target.courseSign);
    if (!course) throw new Error('指定课程不在当前账号的已选课程中');
    const query = new URLSearchParams({ cid: course.classroomId, sign: course.sign });
    const data = await call('GET', `/api/v1/lms/learn/course/chapter?${query}`, null, cookie, context);
    if (!Array.isArray(data?.course_chapter)) throw new Error('课程目录格式无法识别');
    const exercises = new Map();
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if ([5, 6].includes(Number(node.leaf_type)) && node.id) {
        const leafId = id(node.id, '练习 ID');
        exercises.set(leafId, { leaf_id: leafId, section: node.name || `练习 ${leafId}`, leaf_type: Number(node.leaf_type), locked: !!node.is_locked });
      }
      for (const child of Object.values(node)) walk(child);
    }
    walk(data.course_chapter);
    return { course, exercises: [...exercises.values()] };
  }

  async function collect({ courseUrl, submitUnanswered = false }, cookie, { signal, onProgress = () => {} } = {}) {
    if (typeof submitUnanswered !== 'boolean') throw new Error('采集模式无效');
    const target = courseService.parseCourseUrl(courseUrl);
    return store.withLock(target.classroomId, async () => {
      const context = { courseUrl: target.url, signal, onProgress };
      onProgress({ stage: 'discovering', message: '扫描指定课程的作业、章节测试及练习…' });
      const inventory = await discover(courseUrl, cookie, context);
      const database = await store.read(target.classroomId) || { version: 1, course: inventory.course, exercises: {} };
      database.course = inventory.course;
      for (const exercise of Object.values(database.exercises)) exercise.active = false;
      for (const exercise of inventory.exercises) database.exercises[exercise.leaf_id] = { ...database.exercises[exercise.leaf_id], ...exercise, active: true, scanned: false, error: null };
      let submitted = 0;
      const checkpoint = async message => {
        database.updatedAt = new Date(now()).toISOString();
        database.lastRun = { ...summary(database), submitted, mode: submitUnanswered ? 'submit' : 'visible' };
        await store.save(database);
        onProgress({ ...database.lastRun, stage: 'collecting', message });
      };
      await checkpoint(`发现 ${inventory.exercises.length} 套练习`);
      for (const unit of inventory.exercises) {
        signal?.throwIfAborted();
        const exercise = database.exercises[unit.leaf_id];
        try {
          if (unit.locked) throw new Error('练习尚未开放或被锁定');
          const leaf = await call('GET', `/api/v1/lms/learn/leaf_info/${target.classroomId}/${unit.leaf_id}/?sign=${encodeURIComponent(target.sign)}`, null, cookie, context);
          if (Number(leaf?.id) !== unit.leaf_id || Number(leaf.classroom_id) !== target.classroomId || ![5, 6].includes(Number(leaf.leaf_type))) throw new Error('练习详情与选定课程不匹配');
          if (leaf.is_locked || leaf.locked_reason || leaf.upgrade_sku_id) throw new Error('当前账号无法访问该练习');
          exercise.exercise_id = id(leaf.content_info?.leaf_type_id, '练习题集 ID');
          exercise.sku_id = id(leaf.sku_id, 'SKU ID');
          exercise.classroom_id = target.classroomId;
          exercise.sign = target.sign;
          const list = await call('GET', `/api/v1/lms/exercise/get_exercise_list/${exercise.exercise_id}/${exercise.sku_id}/`, null, cookie, context);
          if (!Array.isArray(list?.problems)) throw new Error('题目列表格式无法识别');
          const old = new Map((exercise.questions || []).map(question => [question.problem_id, question]));
          exercise.questions = list.problems.map(problem => {
            const problemId = id(problem.problem_id, '题目 ID');
            if (!problem.content?.Type) throw new Error('题目内容格式无法识别');
            const fingerprint = createHash('sha256').update(JSON.stringify(problem.content)).digest('hex');
            const previous = old.get(problemId);
            return { ...(previous?.fingerprint === fingerprint ? previous : {}), problem_id: problemId, index: problem.index,
              type: typeOf(problem.content.Type), platform_type: problem.content.Type, body_html: problem.content.Body || '',
              options: problem.content.Options || [], fingerprint,
              ...(previous?.fingerprint === fingerprint && previous.answer_status === 'captured' ? {} : { answer_status: 'missing', error: '后端尚未公开标准答案' }) };
          });
          exercise.scanned = true;
          await checkpoint(`${exercise.section}：读取 ${exercise.questions.length} 道题`);
          for (let index = 0; index < list.problems.length; index++) {
            signal?.throwIfAborted();
            const problem = list.problems[index], question = exercise.questions[index];
            const available = extractAnswer(problem, problem.user, 'exercise_list');
            if (available) { delete question.error; Object.assign(question, available); }
            if (question.answer_status === 'captured') { await checkpoint(`${exercise.section} 第 ${index + 1} 题：已保存标准答案`); continue; }
            if (submitUnanswered && Number(problem.user?.my_count || 0) === 0 && (!question.submission || question.submission.state === 'rejected')) {
              const body = probeAnswer(problem);
              if (!body) question.error = '该题型暂不支持提交采集，可稍后读取公开答案';
              else {
                question.submission = { state: 'pending', at: new Date(now()).toISOString() };
                await checkpoint(`${exercise.section} 第 ${index + 1} 题：提交后采集答案`);
                try {
                  const answer = await call('POST', '/api/v1/lms/exercise/problem_apply/', { leaf_id: unit.leaf_id, classroom_id: target.classroomId,
                    exercise_id: exercise.exercise_id, problem_id: question.problem_id, sign: target.sign, ...body }, cookie, context);
                  submitted++;
                  question.submission.state = 'done';
                  const correct = extractAnswer(problem, answer, 'submission_response');
                  if (correct) { delete question.error; Object.assign(question, correct); }
                  else question.error = '已提交，但后端未返回标准答案';
                } catch (error) {
                  question.submission.state = error.definitelyRejected ? 'rejected' : 'unknown';
                  question.error = `提交结果需核对，避免重复消耗作答机会：${error.message}`;
                  await checkpoint(`${exercise.section} 第 ${index + 1} 题：已保存待核对状态`);
                  throw error;
                }
              }
            } else if (Number(problem.user?.my_count || 0) > 0) question.error = '已作答，但后端尚未公开标准答案';
            else if (question.submission) question.error = '上次提交结果不确定，先在课程页面核对；本次未重复提交';
            await checkpoint(`${exercise.section} 第 ${index + 1} 题：${question.answer_status === 'captured' ? '已保存标准答案' : question.error}`);
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error.code || error.stopCollection) {
            database.lastRun.stoppedReason = error.message;
            await store.save(database);
            throw error;
          }
          exercise.error = error.message;
          await checkpoint(`${exercise.section}：${error.message}`);
        }
      }
      await checkpoint('采集结束，答案已写入本地 JSON 数据库');
      return { ...database.lastRun, file: store.filePath(target.classroomId) };
    });
  }
  return { collect, read: store.read, summary };
}

module.exports = { extractAnswer, probeAnswer, summary, createAnswerService, ...createAnswerService() };
