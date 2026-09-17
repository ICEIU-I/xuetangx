const { createWorkerActions } = require('./worker-actions');
const pending = new Map(), listeners = new Set(); const controller = new AbortController(); let id = 0;
const send = value => { if (process.connected) process.send(value); };
const rpc = (method, args) => new Promise((resolve, reject) => {
  if (controller.signal.aborted) return reject(controller.signal.reason);
  const requestId = ++id; pending.set(requestId, { resolve, reject }); send({ type: 'rpc', requestId, method, args });
});
process.on('message', async message => {
  if (message.type === 'rpc-result') {
    const promise = pending.get(message.requestId); if (!promise) return; pending.delete(message.requestId);
    message.error ? promise.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : promise.resolve(message.value);
  } else if (message.type === 'cancel') {
    controller.abort(Object.assign(new Error('任务已暂停或停止'), { name: 'AbortError' }));
    for (const promise of pending.values()) promise.reject(controller.signal.reason); pending.clear(); listeners.forEach(fn => fn(message));
  } else if (message.type === 'init') {
    const actions = createWorkerActions({ rpc, signal: controller.signal, progress: data => send({ type: 'progress', data }),
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } });
    try { send({ type: 'result', result: await actions.run(message.input) }); }
    catch (error) { send({ type: 'failed', error: { message: error.message, code: error.code, name: error.name } }); }
    finally { process.disconnect(); }
  } else listeners.forEach(fn => fn(message));
});
process.on('disconnect', () => process.exit(0));
send({ type: 'ready' });
