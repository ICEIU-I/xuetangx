const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { createStorage } = require('./storage');
const { createAccounts } = require('./accounts');
const { createServerLimits } = require('./server-limits');
const { createBroker } = require('./broker');
const { createCatalog } = require('./catalog');
const { createBank } = require('./bank');
const { createRequestClient } = require('./request-client');
const { createOperations } = require('./operations');
const { createProcessHost, actorKey, send } = require('./processes');
const { createPipeline } = require('./pipeline');
const { parseCourseUrl } = require('../../src/video');
const { concurrency: getConcurrency } = require('../../src/tasks');
const { ROOT, ANSWER_DB_DIR } = require('../../config');
const KINDS = ['video', 'article', 'discussion', 'homework', 'collector'];
const ACTIVE = new Set(['running', 'queued', 'waiting_answers', 'waiting_rate_limit', 'scanning']);

function createRuntime({ directory = path.join(ROOT, 'data/workflow'), bankDirectory = ANSWER_DB_DIR, accounts = createAccounts(), transport, interval = 0, now = Date.now, forkImpl = fork } = {}) {
  const events = new EventEmitter(); events.setMaxListeners(100);
  const jobsStore = createStorage(path.join(directory, 'jobs')), effects = createStorage(path.join(directory, 'effects'));
  const serverLimits = createServerLimits({ now });
  const broker = createBroker({ accounts, serverLimits, ...(transport ? { transport } : {}), interval, now });
  const jobs = new Map(), actors = new Map(), preparing = new Map(), collecting = new Map();
  const exits = new Set(), bankUpdates = new Set(), settling = new Map();
  function beginOperation(id) {
    let finish; const promise = new Promise(resolve => { finish = resolve; });
    if (!settling.has(id)) settling.set(id, new Set()); settling.get(id).add(promise);
    return () => { finish(); settling.get(id)?.delete(promise); if (!settling.get(id)?.size) settling.delete(id); };
  }
  const call = createRequestClient({ broker });
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
    if (states.some(status => ['running', 'scanning', 'queued', 'waiting_rate_limit'].includes(status))) job.status = 'running';
    else if (states.some(status => status.startsWith('waiting_'))) job.status = 'waiting_input';
    else if (states.some(status => ['partial', 'blocked', 'error', 'paused', 'stopped'].includes(status))) job.status = 'partial';
    else job.status = 'done';
  }
  async function publish(job) {
    aggregate(job); job.updatedAt = now();
    await jobsStore.save(job.id, job);
    events.emit('event', { type: 'workflow', job: view(job), ts: now() });
  }
  function log(job, kind, message) {
    if (!message) return;
    job.logs ||= []; const last = job.logs.at(-1);
    if (last?.kind === kind && last.message === message) return;
    job.logs.push({ ts: now(), kind, message }); if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
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
  function waiting(job, actor, state) {
    const module = job.modules[actor.kind]; module.status = 'waiting_rate_limit'; module.message = '服务端返回限流，等待后自动重试';
    log(job, actor.kind, module.message);
    publish(job).catch(() => {});
  }
  const { handleRpc } = createOperations({ accounts, bank, catalog, effects, call, now, waiting });
  const { spawn } = createProcessHost({ actors, exits, accounts, forkImpl, handleRpc, publish, log, restartModule: (...args) => pipeline.restartModule(...args), isClosed: () => closed });
  const pipeline = createPipeline({ accounts, catalog, bank, actors, preparing, collecting, beginOperation, spawn, send, actorKey, publish, log });
  const { refreshCoverage, launchCollector, prepare, restartModule } = pipeline;
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
  const offRateLimit = broker.onRateLimit(state => events.emit('event', { type: 'rate-limit', ...state, ts: now() }));
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
    const rateLimits = {};
    for (const role of ['primary', 'test']) { const userId = accounts.summary(role).userId; rateLimits[role] = userId ? serverLimits.snapshot(userId) : null; }
    return { accounts: { primary: accounts.summary('primary'), test: accounts.summary('test') }, rateLimits, jobs: [...jobs.values()].filter(job => job.primaryId === primaryId).sort((a, b) => b.createdAt - a.createdAt).map(view) };
  }
  async function close() {
    closed = true; offAccounts(); offBank(); offRateLimit();
    preparing.forEach(controller => controller.abort()); collecting.forEach(controller => controller.abort());
    await Promise.allSettled([...jobs.values()].filter(job => Object.keys(job.modules).some(kind => actors.has(actorKey(job, kind)))).map(job => { job.control = 'paused'; return stopActors(job, Object.keys(job.modules), 'paused'); }));
    await Promise.allSettled([...exits, ...bankUpdates]);
    await Promise.allSettled([...settling.values()].flatMap(set => [...set]));
    await jobsStore.flush(); await effects.flush();
    broker.close();
  }
  return { accounts, serverLimits, broker, bank, catalog, ready, start, control, snapshot, close,
    get: async id => { await ready; const job = jobs.get(id); if (!job || job.primaryId !== accounts.summary('primary').userId) throw new Error('任务不存在'); return view(job); },
    onEvent(fn) { events.on('event', fn); return () => events.off('event', fn); } };
}
module.exports = { createRuntime };
