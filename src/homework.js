const http = require('./http');
const api = require('./api');
const courses = require('./video');
const store = require('./answer-store');
const { concurrency: getConcurrency, workers } = require('./tasks');

function createHomeworkService({ transport = http, answers = store, courseService = courses, exerciseApi = api } = {}) {
  async function scan(courseUrl, cookie, { signal } = {}) {
    const target = courses.parseCourseUrl(courseUrl);
    const enrolled = await courseService.listCourses(cookie, signal);
    const course = enrolled.find(item => item.classroomId === target.classroomId && item.sign === target.sign && item.courseSign === target.courseSign);
    if (!course) throw new Error('所选课程不在当前账号的已选课程中');
    const database = await answers.read(target.classroomId);
    if (!database) throw new Error('该课程没有本地答案，请先采集答案');
    const sets = Object.values(database.exercises).filter(item => item.active !== false);
    const sections = [];
    await workers(sets, 3, async exercise => {
      signal?.throwIfAborted();
      const section = { name: exercise.section, leafId: Number(exercise.leaf_id), total: exercise.questions?.length || 0, done: 0, right: 0, jobs: [] };
      try {
        const response = await transport.get(`/api/v1/lms/learn/leaf_info/${course.classroomId}/${section.leafId}/?sign=${encodeURIComponent(course.sign)}`, cookie, { signal, headers: { xtbz: 'xt' } });
        if (response.status !== 200 || response.json?.success !== true) throw new Error(http.responseError(response, '查询作业详情'));
        const leaf = response.json.data;
        if (Number(leaf?.id) !== section.leafId || Number(leaf.classroom_id) !== course.classroomId || ![5, 6].includes(Number(leaf.leaf_type))) throw new Error('作业与所选课程不匹配');
        if (leaf.is_locked || leaf.locked_reason || leaf.upgrade_sku_id || leaf.is_deleted) throw new Error('当前账号无法访问这套作业');
        const exerciseId = Number(leaf.content_info?.leaf_type_id), skuId = Number(leaf.sku_id);
        if (!Number.isSafeInteger(exerciseId) || exerciseId <= 0 || !Number.isSafeInteger(skuId) || skuId <= 0) throw new Error('作业参数不完整');
        if (Number(exercise.exercise_id) !== exerciseId) throw new Error('题集已更新，请重新采集答案');
        const problems = await exerciseApi.getProblems(exerciseId, cookie, { skuId, signal });
        if (!Array.isArray(problems)) throw new Error(problems.error || '无法查询作答状态');
        section.total = problems.length;
        section.done = problems.filter(problem => problem.my_count > 0).length;
        section.right = problems.filter(problem => problem.is_right === true).length;
        const known = new Map((exercise.questions || []).map(question => [Number(question.problem_id), question]));
        section.missing = 0;
        for (const problem of problems) {
          if (problem.my_count > 0) continue;
          const question = known.get(Number(problem.problem_id));
          const type = { SingleChoice: 'choice', MultipleChoice: 'multi', MultiChoice: 'multi', Judgement: 'judge', FillBlank: 'fill' }[problem.type];
          const validAnswer = type === 'choice' ? problem.optionKeys.includes(String(question?.answer))
            : type === 'judge' ? ['正确', '错误'].includes(question?.answer)
            : type === 'multi' ? Array.isArray(question?.answers) && question.answers.length > 0 && question.answers.every(value => problem.optionKeys.includes(String(value)))
            : type === 'fill' ? Array.isArray(question?.answers) && question.answers.length === problem.blankCount : false;
          if (!question || question.error || question.answer_status !== 'captured' || question.type !== type || !validAnswer) { section.missing++; continue; }
          section.jobs.push({ name: section.name, leafId: section.leafId, classroomId: course.classroomId, sign: course.sign, skuId, exerciseId,
            problemId: problem.problem_id, body: api.buildSubmitBody(question) });
        }
      } catch (error) { if (signal?.aborted) throw error; section.err = error.message; }
      sections.push(section);
    }, { signal });
    sections.sort((a, b) => a.leafId - b.leafId);
    return { course, sections, totalQ: sections.reduce((n, s) => n + s.total, 0), doneQ: sections.reduce((n, s) => n + s.done, 0), rightQ: sections.reduce((n, s) => n + s.right, 0) };
  }
  async function complete({ courseUrl, targets, concurrency = 3 }, cookie, { signal, onProgress = () => {} } = {}) {
    concurrency = getConcurrency(concurrency);
    onProgress({ type: 'phase', msg: '从所选课程答案库读取习题，并核对当前账号的作答状态…' });
    const inventory = await scan(courseUrl, cookie, { signal });
    if (targets != null && (!Array.isArray(targets) || targets.some(value => typeof value !== 'string'))) throw new Error('作业选择格式无效');
    const selected = targets?.length ? inventory.sections.filter(section => targets.includes(section.name)) : inventory.sections;
    if (!selected.length) throw new Error('所选课程没有匹配的作业');
    for (const section of selected) onProgress({ type: 'section', ...section, jobs: undefined, todo: section.jobs.length });
    const errors = selected.filter(section => section.err);
    if (errors.length) throw new Error(`作答状态查询失败，未提交：${errors.map(section => `${section.name}：${section.err}`).join('；')}`);
    const jobs = selected.flatMap(section => section.jobs);
    const result = { course: inventory.course, concurrency, total: jobs.length, done: 0, correct: 0, failed: 0,
      skipped: selected.reduce((n, s) => n + s.done, 0), missing: selected.reduce((n, s) => n + s.missing, 0) };
    onProgress({ type: 'start', ...result, sets: selected.length });
    await workers(jobs, concurrency, async job => {
      const response = await exerciseApi.submit({ ...job, signal }, cookie).catch(error => { if (signal?.aborted) throw error; return { ok: false, msg: error.message }; });
      result.done++;
      if (response.ok && response.data?.is_correct === true) result.correct++;
      else result.failed++;
      onProgress({ type: 'progress', ...result, name: job.name, problemId: job.problemId,
        mark: response.ok ? response.data?.is_correct ? 'ok' : 'wrong' : 'fail', msg: response.ok ? undefined : response.msg });
    }, { signal });
    return result;
  }
  return { scan, complete };
}
module.exports = { createHomeworkService, ...createHomeworkService() };
