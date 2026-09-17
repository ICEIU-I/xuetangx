const { createSubmissions } = require('./submissions');
const { isRateLimited } = require('./server-limits');
const errorOf = (message, code) => Object.assign(new Error(message), { code });
function createOperations({ accounts, bank, catalog, effects, call, now, waiting, report }) {
  const { submitQuestion } = createSubmissions({ bank, catalog, effects, call, now, waiting, report, isRateLimited });
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
