const { fingerprint, storedAnswer, submitBody, probeBody } = require('./questions');
const { SUBMIT } = require('./broker');
const { isRateLimited } = require('./server-limits');
const errorOf = (message, code) => Object.assign(new Error(message), { code });
function createOperations({ accounts, bank, catalog, effects, call, now, waiting }) {
  const submissions = new Map();
  async function submitQuestion(job, actor, args) {
    const exercise = actor.input.exercises.find(item => item.leafId === args.leafId);
    const problem = exercise?.problems.find(item => Number(item.problem_id) === args.problemId);
    if (!problem || exercise.error || !exercise.skuId) throw errorOf('题目不属于当前任务', 'INVALID_METADATA');
    if (actor.kind === 'homework') {
      if (actor.account.role !== 'primary') throw errorOf('正式答题账号角色错误', 'INVALID_ROLE');
      const db = await bank.read(job.course), record = db.exercises[exercise.leafId]?.questions?.find(item => Number(item.problem_id) === args.problemId);
      const answer = storedAnswer(problem, record);
      if (!answer || JSON.stringify(submitBody(answer)) !== JSON.stringify(args.body)) throw errorOf('正式账号仅允许提交匹配题库的标准答案', 'ANSWER_MISMATCH');
    } else if (actor.kind !== 'collector' || actor.account.role !== 'test' || JSON.stringify(probeBody(problem)) !== JSON.stringify(args.body)) throw errorOf('采集提交必须使用测试账号', 'INVALID_ROLE');
    const key = `question-${actor.account.userId}-${job.course.classroomId}-${args.problemId}-${fingerprint(problem).slice(0, 16)}`;
    if (submissions.has(key)) return submissions.get(key);
    const operation = (async () => {
      const prior = await effects.read(key);
      const readCurrent = async () => {
        const list = await catalog.data(actor.account, `/api/v1/lms/exercise/get_exercise_list/${exercise.exerciseId}/${exercise.skuId}/`, actor.controller.signal);
        return list.problems?.find(item => Number(item.problem_id) === args.problemId)?.user;
      };
      if (prior && !['rejected', 'not_sent'].includes(prior.state)) {
        const user = await readCurrent();
        if (Number(user?.my_count || 0) > 0) return { ...user, is_correct: user.is_right };
        throw errorOf('上次作答结果尚未确认，未重复提交；请在官网核对', 'REVIEW_REQUIRED');
      }
      const record = { state: 'pending', userId: actor.account.userId, classroomId: job.course.classroomId, leafId: args.leafId, problemId: args.problemId, fingerprint: fingerprint(problem), at: now() };
      for (let attempt = 0; attempt < 4; attempt++) {
        actor.controller.signal.throwIfAborted(); await effects.save(key, record);
        try {
          const response = await call(actor.account, 'POST', SUBMIT, { leaf_id: args.leafId, classroom_id: job.course.classroomId, exercise_id: exercise.exerciseId,
            problem_id: args.problemId, sign: job.course.sign, ...args.body }, { signal: actor.controller.signal, onWait: state => waiting(job, actor, state) });
          if (isRateLimited(response)) {
            await effects.save(key, { ...record, state: 'rejected' });
            if (attempt < 3) continue;
            throw errorOf('多次达到平台提交限速，请稍后继续', 'RATE_LIMITED');
          }
          if (response.status !== 200 || response.json?.success !== true || !response.json.data) throw errorOf(`作答提交未成功（HTTP ${response.status}）`, 'REMOTE_ERROR');
          await effects.save(key, { ...record, state: 'posted' }); return response.json.data;
        } catch (error) {
          const notSent = error.connectionEstablished === false;
          await effects.save(key, { ...record, state: notSent ? 'not_sent' : ['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(error.code) ? 'rejected' : 'unknown' });
          if (notSent && attempt < 2 && !actor.controller.signal.aborted) continue;
          if (!actor.controller.signal.aborted && !notSent && !['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(error.code)) {
            try { const user = await readCurrent(); if (Number(user?.my_count || 0) > 0) return { ...user, is_correct: user.is_right }; } catch {}
          }
          throw error;
        }
      }
    })();
    submissions.set(key, operation); try { return await operation; } finally { submissions.delete(key); }
  }
  function allowedRequest(actor, args) {
    const { method, endpoint, body } = args, course = actor.input.course;
    const url = new URL(endpoint, 'https://www.xuetangx.com');
    if (url.origin !== 'https://www.xuetangx.com') return false;
    const knownUnit = id => actor.input.units?.some(unit => unit.id === Number(id));
    if (method === 'GET') {
      const leaf = /^\/api\/v1\/lms\/learn\/leaf_info\/(\d+)\/(\d+)\/$/.exec(url.pathname);
      if (leaf) return Number(leaf[1]) === course.classroomId && knownUnit(leaf[2]) && url.searchParams.get('sign') === course.sign;
      if (actor.kind === 'video') return (url.pathname === '/video-log/get_video_watch_progress/' && Number(url.searchParams.get('classroom_id')) === course.classroomId && knownUnit(url.searchParams.get('video_id'))) || /^\/api\/v1\/lms\/service\/playurl\/[\w-]+\/$/.test(url.pathname);
      if (actor.kind === 'article') return /^\/api\/v1\/lms\/learn\/user_article_finish\/\d+\/$/.test(url.pathname) && knownUnit(url.pathname.split('/').at(-2)) && Number(url.searchParams.get('cid')) === course.classroomId;
      if (actor.kind === 'discussion') return url.pathname === '/api/v1/lms/forum/unit/discussion/' && Number(url.searchParams.get('classroom_id')) === course.classroomId && knownUnit(url.searchParams.get('leaf_id'));
      const list = /^\/api\/v1\/lms\/exercise\/get_exercise_list\/(\d+)\/(\d+)\/$/.exec(url.pathname);
      return !!list && actor.input.exercises?.some(exercise => exercise.exerciseId === Number(list[1]) && exercise.skuId === Number(list[2]));
    }
    if (method === 'POST' && actor.kind === 'video' && url.pathname === '/video-log/heartbeat/') return Array.isArray(body?.heart_data) && body.heart_data.length <= 50 && body.heart_data.every(item => Number(item.classroomid) === course.classroomId && item.u === actor.account.userId && knownUnit(item.v));
    return method === 'POST' && actor.kind === 'discussion' && url.pathname === '/api/v1/lms/learn/chapter/schedule' && body.classroom_id === course.classroomId && knownUnit(body.leaf_id);
  }
  async function handleRpc(job, actor, method, args) {
    actor.controller.signal.throwIfAborted(); accounts.get(actor.account.role, actor.account.userId);
    if (method === 'request') {
      if (!allowedRequest(actor, args)) throw errorOf('子进程请求超出任务范围', 'INVALID_REQUEST');
      return call(actor.account, args.method, args.endpoint, args.body, { signal: actor.controller.signal });
    }
    if (method === 'submit-question') return submitQuestion(job, actor, args);
    if (method === 'save-answer' && actor.kind === 'collector') {
      const exercise = actor.input.exercises.find(item => item.leafId === args.leafId), problem = exercise?.problems.find(item => Number(item.problem_id) === args.problemId);
      return bank.save(job.inventory, exercise, problem, args.source, { source: args.sourceName, role: actor.account.role, userId: actor.account.userId });
    }
    if (method === 'publish-discussion' && actor.kind === 'discussion') {
      if (!actor.input.units.some(unit => unit.id === args.leafId)) throw errorOf('讨论不属于当前任务', 'INVALID_METADATA');
      const key = `discussion-${actor.account.userId}-${job.course.classroomId}-${args.leafId}`;
      const previous = await effects.read(key); if (previous && previous.state !== 'rejected') return { posted: false };
      await effects.save(key, { state: 'pending', content: '1', topicId: args.topicId });
      try {
        const response = await call(actor.account, 'POST', `/api/v1/lms/forum/comment/?classroom_id=${job.course.classroomId}&leaf_id=${args.leafId}`,
          { to_user: args.toUser, topic_id: args.topicId, content: { text: '1', upload_images: [] } }, { signal: actor.controller.signal });
        if (response.status !== 200 || response.json?.success !== true) { await effects.save(key, { state: response.status === 429 ? 'rejected' : 'unknown' }); throw new Error('讨论发布未确认'); }
        await effects.save(key, { state: 'posted', content: '1', topicId: args.topicId, commentId: response.json.data?.data?.id }); return { posted: true };
      } catch (error) { if (['ACCOUNT_REQUIRED', 'ACCESS_DENIED'].includes(error.code) || error.connectionEstablished === false) await effects.save(key, { state: 'rejected' }); throw error; }
    }
    throw errorOf('未知子进程操作', 'INVALID_REQUEST');
  }
  return { handleRpc };
}
module.exports = { createOperations };
