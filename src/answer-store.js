const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ANSWER_DB_DIR } = require('../config');

function createAnswerStore(directory = ANSWER_DB_DIR) {
  function filePath(classroomId) {
    if (!Number.isSafeInteger(Number(classroomId)) || Number(classroomId) <= 0) throw new Error('课程 ID 无效');
    return path.join(directory, `${Number(classroomId)}.json`);
  }
  async function read(classroomId) {
    try {
      const data = JSON.parse(await fs.readFile(filePath(classroomId), 'utf8'));
      if (data.version !== 1 || data.course?.classroomId !== Number(classroomId) || !data.exercises || typeof data.exercises !== 'object' || Array.isArray(data.exercises)) throw new Error('数据库格式不正确');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`读取答案数据库失败，原文件未覆盖：${error.message}`);
    }
  }
  async function save(data) {
    const target = filePath(data.course.classroomId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      error.stopCollection = true;
      throw error;
    }
    return target;
  }
  async function withLock(classroomId, operation) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = filePath(classroomId) + '.lock';
    let lock;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { lock = await fs.open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await fs.readFile(lockPath, 'utf8');
        let stale = false;
        try { const pid = Number(previous); if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0); }
        catch (e) { stale = e.code === 'ESRCH'; }
        if (!stale || attempt || await fs.readFile(lockPath, 'utf8') !== previous) throw new Error('该课程已有答案采集任务在运行');
        await fs.unlink(lockPath);
      }
    }
    try { await lock.writeFile(String(process.pid)); return await operation(); }
    finally { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
  }
  return { read, save, withLock, filePath };
}

module.exports = { createAnswerStore, ...createAnswerStore() };
