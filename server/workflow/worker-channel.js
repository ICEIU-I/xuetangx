// Keep the IPC channel open until queued progress and the terminal result are written.
function createWorkerChannel(channel = process) {
  const outgoing = new Set();
  function send(value) {
    if (!channel.connected) return Promise.resolve(false);
    const operation = new Promise(resolve => {
      try { channel.send(value, error => resolve(!error)); }
      catch { resolve(false); }
    });
    outgoing.add(operation);
    operation.finally(() => outgoing.delete(operation));
    return operation;
  }
  async function finish(value) {
    await send(value);
    while (outgoing.size) await Promise.all([...outgoing]);
    if (channel.connected) channel.disconnect();
  }
  return { send, finish };
}
module.exports = { createWorkerChannel };
