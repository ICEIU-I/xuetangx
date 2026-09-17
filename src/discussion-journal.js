const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DISCUSSION_STATE_DIR } = require('../config');
const { createAnswerStore } = require('./answer-store');

function createDiscussionJournal(directory = DISCUSSION_STATE_DIR) {
  const locks = createAnswerStore(path.join(directory, '.locks'));
  function filename(classroomId, userId) {
    if (![classroomId, userId].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('讨论记录标识无效');
    return path.join(directory, `${classroomId}-${userId}.json`);
  }
  async function read(classroomId, userId) {
    try {
      const data = JSON.parse(await fs.readFile(filename(classroomId, userId), 'utf8'));
      if (data.classroomId !== classroomId || data.userId !== userId || !data.units || typeof data.units !== 'object' || Array.isArray(data.units)) throw new Error('讨论记录格式无效');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { classroomId, userId, units: {} };
      error.stopBatch = true; throw error;
    }
  }
  async function get(classroomId, userId, leafId) { return (await read(classroomId, userId)).units[leafId]; }
  async function set(classroomId, userId, leafId, record) {
    const target = filename(classroomId, userId), temp = `${target}.${randomUUID()}.tmp`;
    try {
      const data = await read(classroomId, userId);
      data.units[leafId] = { ...record, updatedAt: new Date().toISOString() };
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) { await fs.unlink(temp).catch(() => {}); error.stopBatch = true; throw error; }
  }
  async function withLock(classroomId, operation) {
    try { return await locks.withLock(classroomId, operation); }
    catch (error) {
      if (error.message === '该课程已有答案采集任务在运行') error.message = '该课程已有讨论发布任务在运行';
      throw error;
    }
  }
  return { get, set, withLock };
}
module.exports = { createDiscussionJournal, ...createDiscussionJournal() };
