const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { createStorage } = require('./storage');
const { createAccounts } = require('./accounts');
const { createQuota } = require('./quota');
const { createBroker, SUBMIT } = require('./broker');
const { createCatalog } = require('./catalog');
const { createBank } = require('./bank');
const { fingerprint, storedAnswer, standardAnswer, submitBody, probeBody } = require('./questions');
const { parseCourseUrl } = require('../../src/video');
const { concurrency: getConcurrency } = require('../../src/tasks');
const { ROOT, ANSWER_DB_DIR } = require('../../config');
const KINDS = ['video', 'article', 'discussion', 'homework', 'collector'];
const ACTIVE = new Set(['running', 'queued', 'waiting_answers', 'waiting_quota', 'scanning']);
const errorOf = (message, code) => Object.assign(new Error(message), { code });

function createRuntime({ directory = path.join(ROOT, 'data/workflow'), bankDirectory = ANSWER_DB_DIR, accounts = createAccounts(), transport, interval = 750, now = Date.now, quotaOptions = {}, forkImpl = fork } = {}) {
  const events = new EventEmitter(); events.setMaxListeners(100);
  const jobsStore = createStorage(path.join(directory, 'jobs')), effects = createStorage(path.join(directory, 'effects'));
  const quota = createQuota({ storage: createStorage(path.join(directory, 'quota')), now, ...quotaOptions });
  const broker = createBroker({ accounts, quota, ...(transport ? { transport } : {}), interval, now });
  const jobs = new Map(), actors = new Map(), preparing = new Map(), collecting = new Map(), submissions = new Map();
  const exits = new Set(), bankUpdates = new Set(), settling = new Map();
  function beginOperation(id) {
    let finish; const promise = new Promise(resolve => { finish = resolve; });
    if (!settling.has(id)) settling.set(id, new Set()); settling.get(id).add(promise);
    return () => { finish(); settling.get(id)?.delete(promise); if (!settling.get(id)?.size) settling.delete(id); };
  }
  const catalog = createCatalog({ request: (account, method, endpoint, body, options) => call(account, method, endpoint, body, options) });
  const bank = createBank({ directory: bankDirectory }); let closed = false;
  const ready = jobsStore.list().then(values => {
    for (const value of values) {
      if (!value?.id || !value.course?.classroomId) continue;
      if (!['done', 'partial', 'stopped'].includes(value.status)) {
        value.status = 'paused'; value.message = '服务已重启；重新连接账号后可继续';
        for (const module of Object.values(value.modules)) if (ACTIVE.has(module.status) || module.status.startsWith('waiting_')) module.status = 'paused';
      }
      jobs.set(value.id, value);
    }
  });
  function view(job) {
    const { inventory, ...publicState } = job;
    const modules = Object.fromEntries(Object.entries(publicState.modules).map(([kind, value]) => [kind, { ...value }]));
    return structuredClone({ ...publicState, modules });
  }
  function aggregate(job) {
    const states = Object.values(job.modules).map(module => module.status);
    if (job.control === 'paused' || job.control === 'stopped') { job.status = job.control; return; }
    if (states.some(status => ['running', 'scanning', 'queued', 'waiting_quota'].includes(status))) job.status = 'running';
    else if (states.some(status => status.startsWith('waiting_'))) job.status = 'waiting_input';
    else if (states.some(status => ['partial', 'blocked', 'error', 'paused', 'stopped'].includes(status))) job.status = 'partial';
    else job.status = 'done';
  }
  async function publish(job) {
    aggregate(job); job.updatedAt = now();
    await jobsStore.save(job.id, job);
    events.emit('event', { type: 'workflow', job: view(job), ts: now() });
  }
  async function call(account, method, endpoint, body, { signal, onWait } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await broker.request(account.role, account.userId, method, endpoint, body, { signal, onWait });
        if (response.status === 401) throw errorOf('账号登录已失效，请重新连接', 'ACCOUNT_REQUIRED');
        if (response.status === 403) throw errorOf('平台拒绝访问（HTTP 403），请检查官网或稍后继续', 'ACCESS_DENIED');
        return response;
      } catch (error) {
        // Generic write results are never replayed. Quota-requiring writes are retried explicitly below.
        const safe = error.connectionEstablished === false || (method === 'GET' && !/user_article_finish|forum\/unit\/discussion/.test(endpoint));
        if (signal?.aborted || !safe || !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code) || attempt >= 2 || endpoint === SUBMIT) throw error;
        await sleep(1000 * (attempt + 1), undefined, { signal });
      }
    }
  }
  function actorKey(job, kind) { return `${job.id}:${kind}`; }
  function log(job, kind, message) {
    if (!message) return;
    job.logs ||= []; const last = job.logs.at(-1);
    if (last?.kind === kind && last.message === message) return;
    job.logs.push({ ts: now(), kind, message }); if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
  }
  function send(actor, value) {
    if (!actor?.child?.connected) return;
    if (!actor.initialized && ['answer-ready', 'answers-complete'].includes(value.type)) { (actor.mailbox ||= []).push(value); return; }
    actor.child.send(value);
    if (value.type === 'init') { actor.initialized = true; for (const queued of actor.mailbox || []) actor.child.send(queued); actor.mailbox = []; }
  }
  async function stopActors(job, kinds, status) {
    const waits = [];
    for (const kind of kinds) {
      if (job.modules[kind]) job.modules[kind].status = status;
      const actor = actors.get(actorKey(job, kind));
      if (actor) { actor.stopping = true; actor.controller.abort(); send(actor, { type: 'cancel' }); waits.push(actor.exited); }
    }
    const primaryKinds = job.requested.filter(kind => kind !== 'collector');
    const controller = preparing.get(job.id), stoppedPreparation = !!controller && primaryKinds.every(kind => kinds.includes(kind));
    if (stoppedPreparation) controller.abort();
    if (kinds.includes('collector')) collecting.get(job.id)?.abort();
    await publish(job); await Promise.allSettled(waits);
    if (job.control || stoppedPreparation) await Promise.allSettled([...(settling.get(job.id) || [])]);
  }
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
          if (response.status === 429) {
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
  function waiting(job, actor, state) {
    const module = job.modules[actor.kind]; module.status = 'waiting_quota'; module.readyAt = state.readyAt; module.message = '本周期提交额度已用完，等待下一周期';
    log(job, actor.kind, module.message);
    publish(job).catch(() => {});
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
  function spawn(job, kind, input, role = 'primary', restart = 0) {
    if (closed || job.control || actors.has(actorKey(job, kind))) return;
    const account = accounts.get(role, role === 'primary' ? job.primaryId : undefined);
    const actor = { kind, account: { role, userId: account.userId }, input: { ...input, kind, concurrency: job.concurrency }, controller: new AbortController(), restart, stopping: false, finalized: false, operations: new Set() };
    let exited; actor.exited = new Promise(resolve => { exited = resolve; });
    exits.add(actor.exited);
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'LANG', 'NODE_ENV'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = actor.child = forkImpl(path.join(__dirname, 'worker.js'), [], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    actors.set(actorKey(job, kind), actor);
    job.modules[kind] = { ...job.modules[kind], status: 'running', role, userId: account.userId, pid: child.pid, message: '执行中' };
    publish(job).catch(() => {});
    child.on('message', message => {
      if (message.type === 'ready') send(actor, { type: 'init', input: actor.input });
      if (message.type === 'rpc') {
        const operation = handleRpc(job, actor, message.method, message.args).then(value => send(actor, { type: 'rpc-result', requestId: message.requestId, value }), error => send(actor, { type: 'rpc-result', requestId: message.requestId, error: { message: error.message, code: error.code } }));
        actor.operations.add(operation); operation.finally(() => actor.operations.delete(operation));
      }
      if (message.type === 'progress' && !actor.stopping) { Object.assign(job.modules[kind], message.data, { status: message.data.stage === 'waiting_answers' ? 'waiting_answers' : 'running' }); log(job, kind, message.data.message); publish(job).catch(() => {}); }
      if (message.type === 'result' && !actor.stopping) {
        actor.finalized = true;
        Object.assign(job.modules[kind], message.result, { status: message.result.failed || message.result.wrongExisting ? 'partial' : 'done', message: message.result.failed ? '存在未完成项' : '已回查完成' });
        log(job, kind, job.modules[kind].message);
        if (kind === 'collector') send(actors.get(actorKey(job, 'homework')), { type: 'answers-complete' });
        publish(job).catch(() => {});
      }
      if (message.type === 'failed' && !actor.stopping) {
        actor.finalized = true;
        job.modules[kind].status = message.error.code === 'ACCOUNT_REQUIRED' ? 'waiting_account' : 'blocked';
        job.modules[kind].message = message.error.message;
        log(job, kind, message.error.message);
        if (kind === 'collector' && message.error.code !== 'ACCOUNT_REQUIRED') send(actors.get(actorKey(job, 'homework')), { type: 'answers-complete' });
        publish(job).catch(() => {});
      }
    });
    child.on('error', error => { job.modules[kind].message = error.message; });
    child.on('exit', async () => {
      actor.controller.abort(); await Promise.allSettled([...actor.operations]);
      actors.delete(actorKey(job, kind)); delete job.modules[kind].pid;
      if (!actor.finalized && !actor.stopping && !closed && !job.control) {
        if (restart < 1) {
          job.modules[kind].message = '执行进程退出，正在回查后恢复';
          // Refresh only the failed module; durable side-effect journals suppress duplicate writes.
          try { await restartModule(job, kind, restart + 1); } catch (error) { job.modules[kind].status = 'blocked'; job.modules[kind].message = error.message; }
        } else { job.modules[kind].status = 'blocked'; job.modules[kind].message = '子进程反复退出，请检查后重试'; }
      }
      await publish(job).catch(() => {});
      exited(); exits.delete(actor.exited);
    });
    actor.killTimer = null;
    actor.controller.signal.addEventListener('abort', () => { send(actor, { type: 'cancel' }); actor.killTimer = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 2000); actor.killTimer.unref(); });
    child.once('exit', () => clearTimeout(actor.killTimer));
  }
  async function refreshCoverage(job) {
    job.coverage = await bank.coverage(job.inventory);
    const { ready: answers, missingItems, ...counts } = job.coverage;
    job.coverage = counts;
    return { ready: answers, missing: missingItems };
  }
  async function launchCollector(job, restart = 0) {
    if (collecting.has(job.id) || actors.has(actorKey(job, 'collector')) || job.control) return;
    const controller = new AbortController(); collecting.set(job.id, controller);
    const finishOperation = beginOperation(job.id);
    try {
      const coverage = await refreshCoverage(job);
      if (!coverage.missing.length) { job.modules.collector = { status: 'done', role: 'test', total: 0, captured: 0, message: '已有完整题库，无需采集' }; send(actors.get(actorKey(job, 'homework')), { type: 'answers-complete' }); return; }
      const account = accounts.get('test');
      job.testId = account.userId;
      const testInventory = await catalog.discover({ role: 'test', userId: account.userId }, job.course.url, controller.signal);
      testInventory.exercises = await catalog.exercises({ role: 'test', userId: account.userId }, testInventory, controller.signal);
      // A different exercise binding is not an answer source, even if its title looks identical.
      for (const exercise of testInventory.exercises) {
        const primary = job.inventory.exercises.find(item => item.leafId === exercise.leafId);
        if (primary?.exerciseId !== exercise.exerciseId) { exercise.error = '两账号的题集标识不匹配'; exercise.problems = []; }
      }
      spawn(job, 'collector', { course: job.course, exercises: testInventory.exercises, missing: coverage.missing, submitUnanswered: job.submitUnanswered }, 'test', restart);
    } catch (error) {
      if (!controller.signal.aborted) { job.modules.collector = { status: error.code === 'ENROLLMENT_REQUIRED' ? 'waiting_enrollment' : error.code === 'ACCOUNT_REQUIRED' ? 'waiting_account' : 'blocked', role: 'test', message: error.message }; log(job, 'collector', error.message); }
    } finally { collecting.delete(job.id); try { await publish(job); } finally { finishOperation(); } }
  }
  async function prepare(job) {
    if (preparing.has(job.id) || job.control) return;
    const controller = new AbortController(); preparing.set(job.id, controller);
    const finishOperation = beginOperation(job.id);
    try {
      const account = { role: 'primary', userId: job.primaryId }; accounts.get('primary', job.primaryId);
      const inventory = await catalog.discover(account, job.course.url, controller.signal); job.course = inventory.course; job.inventory = inventory;
      controller.signal.throwIfAborted();
      for (const kind of ['video', 'article', 'discussion']) if (job.requested.includes(kind) && !actors.has(actorKey(job, kind)) && !['paused', 'stopped'].includes(job.modules[kind].status)) {
        const units = inventory.units.filter(unit => unit.kind === kind && (kind !== 'video' || !job.unitId || unit.id === job.unitId));
        if (kind === 'video' && job.unitId && !units.length) throw new Error('所选视频不属于该课程');
        spawn(job, kind, { course: job.course, units });
      }
      if (job.requested.some(kind => ['homework', 'collector'].includes(kind))) {
        inventory.exercises = await catalog.exercises(account, inventory, controller.signal);
        if (job.targets?.length) inventory.exercises = inventory.exercises.filter(exercise => job.targets.includes(exercise.title));
        for (const exercise of inventory.exercises) for (const problem of exercise.problems) {
          controller.signal.throwIfAborted();
          if (standardAnswer(problem, problem.user)) await bank.save(inventory, exercise, problem, problem.user, { source: 'exercise_list', role: 'primary', userId: job.primaryId });
        }
        const coverage = await refreshCoverage(job);
        if (job.requested.length === 1 && job.requested[0] === 'collector' && !job.submitUnanswered) {
          job.modules.collector = { status: coverage.missing.length ? 'partial' : 'done', role: 'primary', total: job.coverage.total, captured: job.coverage.captured, failed: job.coverage.missing, message: '已读取并保存正式账号公开答案，未提交作答' };
          await publish(job); return;
        }
        if (job.requested.includes('homework') && !actors.has(actorKey(job, 'homework')) && !['paused', 'stopped'].includes(job.modules.homework.status)) spawn(job, 'homework', { course: job.course, exercises: inventory.exercises, ready: coverage.ready, producerFinished: coverage.missing.length === 0 });
        if (coverage.missing.length || job.requested.includes('collector')) { job.modules.collector ||= { status: 'queued', role: 'test', message: '准备补齐题库' }; await launchCollector(job); }
      }
      await publish(job);
    } catch (error) {
      if (!controller.signal.aborted) {
        for (const kind of job.requested) if (!actors.has(actorKey(job, kind))) Object.assign(job.modules[kind], { status: error.code === 'ACCOUNT_REQUIRED' ? 'waiting_account' : 'blocked', message: error.message });
        await publish(job);
      }
    } finally { preparing.delete(job.id); finishOperation(); }
  }
  async function restartModule(job, kind, restart = 0) {
    if (kind === 'collector') return launchCollector(job, restart);
    if (kind === 'homework') {
      const coverage = await refreshCoverage(job);
      return spawn(job, kind, { course: job.course, exercises: job.inventory.exercises, ready: coverage.ready, producerFinished: !coverage.missing.length || ['done', 'partial', 'blocked'].includes(job.modules.collector?.status) }, 'primary', restart);
    }
    const account = { role: 'primary', userId: job.primaryId };
    const fresh = await catalog.discover(account, job.course.url); return spawn(job, kind, { course: job.course, units: fresh.units.filter(unit => unit.kind === kind) }, 'primary', restart);
  }
  async function start({ courseUrl, modules = ['video', 'article', 'discussion', 'homework'], concurrency = 3, submitUnanswered = true, targets, unitId } = {}) {
    await ready; if (closed) throw new Error('调度器已关闭');
    concurrency = getConcurrency(concurrency); const target = parseCourseUrl(courseUrl), primary = accounts.get('primary');
    if (!Array.isArray(modules) || !modules.length || modules.some(kind => !KINDS.includes(kind))) throw new Error('任务模块无效');
    if (typeof submitUnanswered !== 'boolean' || (targets != null && (!Array.isArray(targets) || targets.some(value => typeof value !== 'string')))) throw new Error('任务参数无效');
    if (unitId != null && (!Number.isSafeInteger(unitId) || unitId <= 0 || modules.length !== 1 || modules[0] !== 'video')) throw new Error('单视频任务参数无效');
    let job = [...jobs.values()].find(item => item.primaryId === primary.userId && item.course.classroomId === target.classroomId && ['running', 'waiting_input'].includes(item.status));
    if (job) {
      const extra = modules.filter(kind => !job.requested.includes(kind));
      if (extra.length) { job.requested.push(...extra); extra.forEach(kind => { job.modules[kind] = { status: 'queued', message: '等待执行' }; }); if (!preparing.has(job.id)) prepare(job).catch(() => {}); }
      if (extra.length && preparing.has(job.id)) {
        (async () => { while (preparing.has(job.id) && !closed) await sleep(20); if (!closed && !job.control) for (const kind of extra) if (job.modules[kind]?.status === 'queued') await restartModule(job, kind); })().catch(() => {});
      }
      return view(job);
    }
    job = { id: randomUUID(), course: target, primaryId: primary.userId, concurrency, submitUnanswered, targets: targets || null, unitId: unitId || null,
      requested: [...new Set(modules)], modules: {}, logs: [], status: 'running', control: null, createdAt: now(), updatedAt: now(), coverage: null };
    for (const kind of job.requested) job.modules[kind] = { status: 'queued', message: '等待扫描课程' };
    jobs.set(job.id, job); await publish(job); prepare(job).catch(() => {}); return view(job);
  }
  async function control(id, action, kind) {
    await ready; const job = jobs.get(id); if (!job) throw new Error('任务不存在');
    if (accounts.summary('primary').userId !== job.primaryId) throw new Error('请连接此任务的正式账号');
    if (kind && !KINDS.includes(kind)) throw new Error('模块无效');
    if (['pause', 'stop'].includes(action)) {
      const status = action === 'pause' ? 'paused' : 'stopped'; if (!kind) job.control = status;
      log(job, kind || 'course', status === 'paused' ? '任务已暂停' : '任务已停止');
      await stopActors(job, kind ? [kind] : Object.keys(job.modules), status);
    } else if (['resume', 'retry'].includes(action)) {
      job.control = null;
      if (!job.inventory || !kind) {
        await stopActors(job, Object.keys(job.modules), 'paused'); job.control = null;
        job.requested.forEach(name => { job.modules[name] = { status: 'queued', message: '回查并继续' }; }); prepare(job).catch(() => {});
      } else { job.modules[kind].status = 'queued'; restartModule(job, kind).catch(error => { job.modules[kind].status = 'blocked'; job.modules[kind].message = error.message; publish(job).catch(() => {}); }); }
      await publish(job);
    } else throw new Error('任务操作无效');
    return view(job);
  }
  const offBank = bank.onAnswer(answer => {
    for (const job of jobs.values()) if (job.course.classroomId === answer.classroomId && job.inventory && !job.control) {
      send(actors.get(actorKey(job, 'homework')), { type: 'answer-ready', answer });
      const update = refreshCoverage(job).then(() => publish(job)).catch(() => {});
      bankUpdates.add(update); update.finally(() => bankUpdates.delete(update));
    }
  });
  const offQuota = broker.onQuota(state => events.emit('event', { type: 'quota', ...state, ts: now() }));
  const offAccounts = accounts.onChange(change => {
    events.emit('event', { type: 'accounts', accounts: { primary: accounts.summary('primary'), test: accounts.summary('test') }, ts: now() });
    for (const job of jobs.values()) {
      if (job.control) continue;
      if (change.role === 'test') {
        if (!change.connected || (job.testId && job.testId !== change.userId)) stopActors(job, ['collector'], 'waiting_account').then(() => { if (change.connected && job.inventory?.exercises) launchCollector(job).catch(() => {}); }).catch(() => {});
        else if (job.modules.collector && job.inventory?.exercises) launchCollector(job).catch(() => {});
      } else if (!change.connected || job.primaryId !== change.userId) stopActors(job, ['video', 'article', 'discussion', 'homework'], 'waiting_account').catch(() => {});
    }
  });
  async function snapshot() {
    await ready; const primaryId = accounts.summary('primary').userId;
    const quotas = {};
    for (const role of ['primary', 'test']) { const userId = accounts.summary(role).userId; quotas[role] = userId ? await quota.snapshot(userId) : null; }
    return { accounts: { primary: accounts.summary('primary'), test: accounts.summary('test') }, quotas, jobs: [...jobs.values()].filter(job => job.primaryId === primaryId).sort((a, b) => b.createdAt - a.createdAt).map(view) };
  }
  async function close() {
    closed = true; offAccounts(); offBank(); offQuota();
    preparing.forEach(controller => controller.abort()); collecting.forEach(controller => controller.abort());
    await Promise.allSettled([...jobs.values()].filter(job => Object.keys(job.modules).some(kind => actors.has(actorKey(job, kind)))).map(job => { job.control = 'paused'; return stopActors(job, Object.keys(job.modules), 'paused'); }));
    await Promise.allSettled([...exits, ...bankUpdates]);
    await Promise.allSettled([...settling.values()].flatMap(set => [...set]));
    await jobsStore.flush(); await effects.flush();
    broker.close();
  }
  return { accounts, quota, broker, bank, catalog, ready, start, control, snapshot, close,
    get: async id => { await ready; const job = jobs.get(id); if (!job || job.primaryId !== accounts.summary('primary').userId) throw new Error('任务不存在'); return view(job); },
    onEvent(fn) { events.on('event', fn); return () => events.off('event', fn); } };
}
module.exports = { createRuntime };
