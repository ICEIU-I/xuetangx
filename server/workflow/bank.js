const { EventEmitter } = require('node:events');
const { createStorage } = require('./storage');
const { storedAnswer, standardAnswer, fingerprint, questionRecord } = require('./questions');
function createBank({ directory }) {
  const storage = createStorage(directory), bus = new EventEmitter(); bus.setMaxListeners(100);
  async function read(course) {
    const value = await storage.read(String(course.classroomId), { version: 1, course, exercises: {} });
    if (![1, 2].includes(value.version) || Number(value.course?.classroomId) !== course.classroomId || !value.exercises || Array.isArray(value.exercises)) throw new Error('题库格式无效，原文件保留');
    return value;
  }
  async function coverage(inventory) {
    const database = await read(inventory.course), ready = [], missing = [];
    for (const exercise of inventory.exercises) for (const problem of exercise.problems) {
      const stored = database.exercises[exercise.leafId];
      const record = Number(stored?.exercise_id) === exercise.exerciseId ? stored.questions?.find(item => Number(item.problem_id) === Number(problem.problem_id)) : null;
      const answer = storedAnswer(problem, record);
      const item = { leafId: exercise.leafId, problemId: Number(problem.problem_id), fingerprint: fingerprint(problem), answer };
      (answer ? ready : missing).push(item);
    }
    return { total: ready.length + missing.length, captured: ready.length, missing: missing.length, ready, missingItems: missing };
  }
  async function save(inventory, exercise, problem, source, provenance) {
    const expected = inventory.exercises.find(item => item.leafId === exercise.leafId);
    const current = expected?.problems.find(item => Number(item.problem_id) === Number(problem.problem_id));
    if (!current || expected.exerciseId !== exercise.exerciseId || fingerprint(current) !== fingerprint(problem)) throw new Error('测试账号题目与正式账号题目版本不匹配');
    const answer = standardAnswer(problem, source); if (!answer) return null;
    const record = questionRecord(problem, answer, provenance);
    await storage.transact(String(inventory.course.classroomId), previous => {
      const database = previous || { version: 1, course: inventory.course, exercises: {} };
      if (![1, 2].includes(database.version) || Number(database.course?.classroomId) !== inventory.course.classroomId || !database.exercises) throw new Error('题库格式无效，停止写入');
      const old = database.exercises[exercise.leafId];
      const questions = Number(old?.exercise_id) === exercise.exerciseId ? [...(old.questions || [])] : [];
      const index = questions.findIndex(item => Number(item.problem_id) === record.problem_id);
      if (index < 0) questions.push(record); else questions[index] = record;
      database.version = 2; database.course = inventory.course; database.updatedAt = new Date().toISOString();
      database.exercises[exercise.leafId] = { ...old, section: exercise.title, leaf_id: exercise.leafId, exercise_id: exercise.exerciseId,
        classroom_id: inventory.course.classroomId, sign: inventory.course.sign, sku_id: expected.skuId, active: true, questions };
      return database;
    });
    const event = { classroomId: inventory.course.classroomId, leafId: exercise.leafId, problemId: record.problem_id, fingerprint: record.fingerprint, answer };
    bus.emit('answer-ready', event); return event;
  }
  return { read, coverage, save, onAnswer(fn) { bus.on('answer-ready', fn); return () => bus.off('answer-ready', fn); } };
}
module.exports = { createBank };
