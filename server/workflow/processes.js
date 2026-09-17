const path = require('node:path');
const actorKey = (job, kind) => `${job.id}:${kind}`;
  function send(actor, value) {
    if (!actor?.child?.connected) return;
    if (!actor.initialized && ['answer-ready', 'answers-complete'].includes(value.type)) { (actor.mailbox ||= []).push(value); return; }
    try { actor.child.send(value, () => {}); } catch { return; }
    if (value.type === 'init') { actor.initialized = true; for (const queued of actor.mailbox || []) actor.child.send(queued); actor.mailbox = []; }
  }
function createProcessHost({ actors, exits, accounts, forkImpl, handleRpc, publish, log, restartModule, isClosed }) {
  function spawn(job, kind, input, role = 'primary', restart = 0) {
    if (isClosed() || job.control || actors.has(actorKey(job, kind))) return;
    const account = accounts.get(role, role === 'primary' ? job.primaryId : undefined);
    const actor = { kind, account: { role, userId: account.userId }, input: { ...input, kind, concurrency: 1 }, controller: new AbortController(), restart, stopping: false, finalized: false, operations: new Set() };
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
      if (message.type === 'progress' && !actor.stopping && !actor.finalized) { Object.assign(job.modules[kind], message.data, { status: message.data.stage === 'waiting_answers' ? 'waiting_answers' : 'running' }); log(job, kind, message.data.message); publish(job).catch(() => {}); }
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
        job.modules[kind].errorCode = message.error.code;
        log(job, kind, message.error.message);
        if (kind === 'collector' && message.error.code !== 'ACCOUNT_REQUIRED') send(actors.get(actorKey(job, 'homework')), { type: 'answers-complete' });
        publish(job).catch(() => {});
      }
    });
    child.on('error', error => { if (!actor.finalized && !actor.stopping) job.modules[kind].message = error.message; });
    child.on('close', async (code, signal) => {
      actor.controller.abort(); await Promise.allSettled([...actor.operations]);
      actors.delete(actorKey(job, kind)); delete job.modules[kind].pid;
      if (!actor.finalized && !actor.stopping && !isClosed() && !job.control) {
        if (restart < 1) {
          job.modules[kind].message = '执行进程退出，正在回查后恢复';
          // Refresh only the failed module; durable side-effect journals suppress duplicate writes.
          try { await restartModule(job, kind, restart + 1); } catch (error) { job.modules[kind].status = 'blocked'; job.modules[kind].message = error.message; }
        } else { job.modules[kind].status = 'blocked'; job.modules[kind].message = `子进程反复退出（${signal || `退出码 ${code}`}），请重试该模块`; }
        log(job, kind, job.modules[kind].message);
      }
      await publish(job).catch(() => {});
      exited(); exits.delete(actor.exited);
    });
    actor.killTimer = null;
    actor.controller.signal.addEventListener('abort', () => { send(actor, { type: 'cancel' }); actor.killTimer = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 2000); actor.killTimer.unref(); });
    child.once('exit', () => clearTimeout(actor.killTimer));
  }
  return { spawn };
}
module.exports = { createProcessHost, actorKey, send };
