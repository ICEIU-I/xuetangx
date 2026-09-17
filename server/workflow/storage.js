const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createStorage(directory) {
  const queues = new Map();
  const filename = key => {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(key))) throw new Error('无效的存储标识');
    return path.join(directory, `${key}.json`);
  };
  async function read(key, fallback = null) {
    try { return JSON.parse(await fs.readFile(filename(key), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw new Error(`读取本地状态失败：${key}（原文件未覆盖）`); }
  }
  async function write(key, data) {
    const temp = `${filename(key)}.${randomUUID()}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try { await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temp, filename(key)); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  function transact(key, fn) {
    const operation = (queues.get(key) || Promise.resolve()).then(async () => {
      const current = await read(key); const next = await fn(current);
      if (next !== undefined) await write(key, next);
      return next;
    });
    const tail = operation.catch(() => {}); queues.set(key, tail);
    tail.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
    return operation;
  }
  const save = (key, data) => { const snapshot = structuredClone(data); return transact(key, () => snapshot); };
  async function list() {
    let files; try { files = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(files.filter(name => name.endsWith('.json')).map(name => read(name.slice(0, -5))));
  }
  const flush = async () => { while (queues.size) await Promise.allSettled([...queues.values()]); };
  return { read, save, transact, list, flush, directory };
}
module.exports = { createStorage };
