// 子进程只计算任务和通过 IPC 请求主进程；不加载配置、Cookie、HTTP 或文件存储。
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { workers } = require('../../src/tasks');
const { fingerprint, standardAnswer, submitBody, probeBody } = require('./questions');
const completeValue = value => value === true || value === 1 || value === '1';
function failure(message, code) { return Object.assign(new Error(message), { code }); }
function requireId(value) { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw failure('课程参数不完整', 'INVALID_METADATA'); return id; }
function createWorkerActions({ rpc, progress, signal, subscribe = () => () => {}, verificationDelays = [0, 1000, 2000] }) {
  async function request(method, endpoint, body) {
    signal.throwIfAborted();
    const response = await rpc('request', { method, endpoint, body });
    const json = response.json;
    if (response.status !== 200 || !json || json.success === false || (json.code != null && ![0, '0'].includes(json.code))) {
      throw failure(`接口未成功（HTTP ${response.status}）${json?.msg ? '：' + String(json.msg).slice(0, 100) : ''}`, response.status === 401 ? 'ACCOUNT_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : response.status === 429 ? 'RATE_LIMITED' : 'REMOTE_ERROR');
    }
    return json.data ?? json;
  }
  async function leaf(course, unit) {
    const data = await request('GET', `/api/v1/lms/learn/leaf_info/${course.classroomId}/${unit.id}/?sign=${encodeURIComponent(course.sign)}`);
    if (Number(data.id) !== unit.id || Number(data.classroom_id) !== course.classroomId || Number(data.leaf_type) !== unit.leafType) throw failure('学习单元与任务不匹配', 'INVALID_METADATA');
    if (data.is_deleted || data.is_locked || data.locked_reason || data.upgrade_sku_id) throw failure('学习单元不可访问或未开放', 'LOCKED');
    return data;
  }
  async function verify(check) {
    for (const delay of verificationDelays) {
      signal.throwIfAborted(); if (delay) await sleep(delay, undefined, { signal });
      if (await check()) return true;
    }
    return false;
  }
  async function video(course, unit) {
    const data = await leaf(course, unit), media = data.content_info?.media;
    if (!media?.ccid || (media.type && media.type !== 'video')) throw failure('暂不支持该视频类型', 'UNSUPPORTED');
    const query = new URLSearchParams({ cid: requireId(data.course_id), user_id: requireId(data.user_id), classroom_id: course.classroomId, video_type: 'video', vtype: 'rate', video_id: unit.id });
    const getProgress = async () => (await request('GET', `/video-log/get_video_watch_progress/?${query}`))[unit.id];
    const before = await getProgress(); if (completeValue(before?.completed)) return { status: 'skipped' };
    const play = await request('GET', `/api/v1/lms/service/playurl/${encodeURIComponent(media.ccid)}/?appid=10000`);
    const duration = Math.ceil(Number(before?.video_length || media.duration || play.duration || play.m3u8?.duration));
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw failure('无法获取视频时长', 'INVALID_METADATA');
    const source = Object.values(play.sources || play.m3u8?.sources || {}).flat().find(value => typeof value === 'string' && /^https?:\/\//.test(value));
    const base = { i: 5, p: 'web', n: source ? new URL(source).hostname : 'other', lob: 'plat2', fp: 0, tp: 0, sp: 1,
      u: requireId(data.user_id), uip: '', c: requireId(data.course_id), v: unit.id, skuid: requireId(data.sku_id), classroomid: String(course.classroomId), cc: media.ccid, d: duration,
      pg: `${unit.id}_${randomUUID().slice(0, 8)}`, t: 'video', cards_id: 0, slide: 0, v_url: '' };
    const records = []; let sequence = 0, timestamp = Date.now();
    const add = (et, cp) => records.push({ ...base, et, cp, ts: String(timestamp++), sq: ++sequence });
    ['loadstart', 'loadeddata', 'play', 'playing'].forEach(type => add(type, 0));
    for (let point = 5; point < duration; point += 5) add('heartbeat', point);
    add('videoend', duration);
    while (records.length) await request('POST', '/video-log/heartbeat/', { heart_data: records.splice(0, 50) });
    if (!await verify(async () => completeValue((await getProgress())?.completed))) throw failure('后端尚未确认视频完成', 'UNCONFIRMED');
    return { status: 'completed' };
  }
  async function article(course, unit) {
    const data = await leaf(course, unit); if (completeValue(data.finish)) return { status: 'skipped' };
    await request('GET', `/api/v1/lms/learn/user_article_finish/${unit.id}/?${new URLSearchParams({ cid: course.classroomId, sid: requireId(data.sku_id) })}`);
    if (!await verify(async () => completeValue((await leaf(course, unit)).finish))) throw failure('后端尚未确认图文完成', 'UNCONFIRMED');
    return { status: 'completed' };
  }
  async function discussion(course, unit) {
    const data = await leaf(course, unit);
    const query = new URLSearchParams({ product_sign: course.sign, leaf_id: unit.id, classroom_id: course.classroomId, topic_type: 4, channel: 'xt' });
    const topic = await request('GET', `/api/v1/lms/forum/unit/discussion/?${query}`);
    if (Number(topic.classroom_id) !== course.classroomId || Number(topic.chapter_id) !== unit.id || !Number.isInteger(Number(topic.user_comment_num))) throw failure('无法确认讨论身份或发言记录', 'INVALID_METADATA');
    let posted = false;
    if (Number(topic.user_comment_num) === 0) {
      const response = await rpc('publish-discussion', { leafId: unit.id, topicId: requireId(topic.id), toUser: requireId(topic.user_id) });
      posted = response.posted;
    }
    if (!await verify(async () => completeValue((await request('POST', '/api/v1/lms/learn/chapter/schedule', { leaf_id: unit.id, classroom_id: course.classroomId, sku_id: requireId(data.sku_id) })).leaf_schedule))) throw failure('已发表或待核对，后端尚未确认讨论完成；不会重复发帖', 'UNCONFIRMED');
    return { status: posted ? 'completed' : 'skipped' };
  }
  async function media(input) {
    const units = input.units, result = { total: units.length, processed: 0, completed: 0, skipped: 0, failed: 0, results: [] };
    const emit = message => progress({ ...result, message });
    await workers(units, input.concurrency || 3, async unit => {
      signal.throwIfAborted(); emit(`处理：${unit.title}`); let outcome;
      try {
        if (completeValue(unit.progress)) outcome = { status: 'skipped' };
        else if (unit.locked) throw failure('学习单元尚未开放', 'LOCKED');
        else outcome = await ({ video, article, discussion }[input.kind])(input.course, unit);
      } catch (error) {
        if (signal.aborted || ['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(error.code)) throw error;
        outcome = { status: 'failed', error: error.message };
      }
      result.processed++; result[outcome.status === 'failed' ? 'failed' : outcome.status === 'skipped' ? 'skipped' : 'completed']++;
      result.results.push({ unitId: unit.id, title: unit.title, ...outcome }); emit(`${result.processed}/${result.total}`);
    }, { signal });
    return result;
  }
  async function collect(input) {
    const result = { total: input.missing.length, processed: 0, captured: 0, failed: 0, results: [] };
    const wanted = new Map(input.missing.map(item => [`${item.leafId}:${item.problemId}`, item]));
    const seen = new Set(), unavailable = new Map();
    await workers(input.exercises, input.concurrency || 3, async exercise => {
      if (exercise.error) { unavailable.set(exercise.leafId, exercise.error); return; }
      for (const problem of exercise.problems) {
        signal.throwIfAborted(); const item = wanted.get(`${exercise.leafId}:${problem.problem_id}`); if (!item) continue;
        seen.add(`${exercise.leafId}:${problem.problem_id}`);
        let error;
        if (fingerprint(problem) !== item.fingerprint) error = '测试账号题目版本与正式账号不匹配';
        else {
          let source = problem.user, sourceName = 'exercise_list';
          if (!standardAnswer(problem, source) && input.submitUnanswered !== false && Number(problem.user?.my_count || 0) === 0) {
            const body = probeBody(problem);
            if (!body) error = '不支持该题型的采集提交';
            else {
              try { source = await rpc('submit-question', { leafId: exercise.leafId, problemId: Number(problem.problem_id), body }); sourceName = 'submission_response'; }
              catch (e) { if (signal.aborted || ['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(e.code)) throw e; error = e.message; }
            }
          }
          if (!error) {
            if (!standardAnswer(problem, source)) error = '后端未公开标准答案或作答机会已用尽';
            else await rpc('save-answer', { leafId: exercise.leafId, problemId: Number(problem.problem_id), source, sourceName });
          }
        }
        result.processed++; result[error ? 'failed' : 'captured']++;
        result.results.push({ unitId: exercise.leafId, problemId: Number(problem.problem_id), status: error ? 'missing' : 'captured', ...(error ? { error } : {}) });
        progress({ ...result, message: error || `已采集 ${result.captured}/${result.total} 条答案` });
      }
    }, { signal });
    for (const item of input.missing) if (!seen.has(`${item.leafId}:${item.problemId}`)) {
      result.failed++; result.processed++; result.results.push({ unitId: item.leafId, problemId: item.problemId, status: 'missing', error: unavailable.get(item.leafId) || '测试账号未返回对应题目' });
    }
    return result;
  }
  async function homework(input) {
    const entries = input.exercises.flatMap(exercise => exercise.problems.map(problem => ({ exercise, problem, key: `${exercise.leafId}:${problem.problem_id}` })));
    const answers = new Map(input.ready.map(item => [`${item.leafId}:${item.problemId}`, item]));
    const done = new Set(), inFlight = new Set(), sleepers = new Set(); let producerFinished = !!input.producerFinished, fatal;
    const result = { total: entries.length, processed: 0, completed: 0, skipped: 0, failed: 0, wrongExisting: 0, results: [] };
    const wake = () => { sleepers.forEach(resolve => resolve()); sleepers.clear(); };
    const unsubscribe = subscribe(message => {
      if (message.type === 'answer-ready') answers.set(`${message.answer.leafId}:${message.answer.problemId}`, message.answer);
      if (message.type === 'answers-complete') producerFinished = true;
      wake();
    });
    signal.addEventListener('abort', wake);
    for (const entry of entries) if (Number(entry.problem.user?.my_count || 0) > 0) {
      const wrong = entry.problem.user.is_right === false;
      done.add(entry.key); result.processed++; result.skipped++; if (wrong) result.wrongExisting++;
      result.results.push({ unitId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), status: wrong ? 'wrong_existing' : 'skipped', ...(wrong ? { error: '已作答但判错；不自动消耗重答机会' } : {}) });
    }
    async function worker() {
      for (;;) {
        signal.throwIfAborted();
        if (fatal) throw fatal;
        const entry = entries.find(item => !done.has(item.key) && !inFlight.has(item.key) && answers.get(item.key)?.fingerprint === fingerprint(item.problem));
        if (!entry) {
          if (done.size === entries.length || (producerFinished && !inFlight.size)) return;
          progress({ ...result, stage: 'waiting_answers', message: '等待缺失答案；已获取的答案会自动开始作答' });
          await new Promise(resolve => sleepers.add(resolve)); continue;
        }
        inFlight.add(entry.key);
        try {
          const answer = answers.get(entry.key).answer;
          const response = await rpc('submit-question', { leafId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), body: submitBody(answer) });
          const correct = response.is_correct === true || response.is_right === true;
          result[correct ? 'completed' : 'failed']++;
          result.results.push({ unitId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), status: correct ? 'completed' : 'failed', ...(!correct ? { error: '服务器未判定作答正确' } : {}) });
        } catch (error) {
          if (signal.aborted || ['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(error.code)) throw error;
          result.failed++; result.results.push({ unitId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), status: 'failed', error: error.message });
        } finally { done.add(entry.key); inFlight.delete(entry.key); result.processed++; wake(); }
        progress({ ...result, stage: 'answering', message: `已处理 ${result.processed}/${result.total} 题` });
      }
    }
    try {
      const outcomes = await Promise.allSettled(Array.from({ length: input.concurrency || 3 }, async () => {
        try { return await worker(); } catch (error) { fatal = error; wake(); throw error; }
      }));
      const error = outcomes.find(outcome => outcome.status === 'rejected'); if (error) throw error.reason;
      for (const entry of entries) if (!done.has(entry.key)) { result.failed++; result.processed++; result.results.push({ unitId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), status: 'missing', error: '缺少匹配的标准答案' }); }
      for (const exercise of input.exercises) {
        if (exercise.error) { result.failed++; result.results.push({ unitId: exercise.leafId, status: 'blocked', error: exercise.error }); continue; }
        const fresh = await request('GET', `/api/v1/lms/exercise/get_exercise_list/${exercise.exerciseId}/${exercise.skuId}/`);
        const problems = new Map((fresh.problems || []).map(problem => [Number(problem.problem_id), problem]));
        for (const item of result.results.filter(item => item.unitId === exercise.leafId && item.status === 'completed')) {
          const user = problems.get(item.problemId)?.user;
          if (!(Number(user?.my_count) > 0 && user.is_right === true)) { item.status = 'failed'; item.error = '最终回查未确认作答正确'; result.completed--; result.failed++; }
        }
      }
      return result;
    } finally { unsubscribe(); signal.removeEventListener('abort', wake); wake(); }
  }
  return { run: input => input.kind === 'homework' ? homework(input) : input.kind === 'collector' ? collect(input) : media(input) };
}
module.exports = { createWorkerActions };
