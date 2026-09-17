const { standardAnswer } = require('./questions');
function createPipeline({ accounts, catalog, bank, actors, preparing, collecting, beginOperation, spawn, send, actorKey, publish, log }) {
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
      for (const kind of ['video', 'article', 'discussion']) if (job.requested.includes(kind) && !actors.has(actorKey(job, kind)) && !['paused', 'stopped', 'done'].includes(job.modules[kind].status)) {
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
        if (job.requested.includes('homework') && !actors.has(actorKey(job, 'homework')) && !['paused', 'stopped', 'done'].includes(job.modules.homework.status)) spawn(job, 'homework', { course: job.course, exercises: inventory.exercises, ready: coverage.ready, producerFinished: coverage.missing.length === 0 });
        if (coverage.missing.length || job.requested.includes('collector')) { job.modules.collector ||= { status: 'queued', role: 'test', message: '准备补齐题库' }; await launchCollector(job); }
      }
      await publish(job);
    } catch (error) {
      if (!controller.signal.aborted) {
        for (const kind of job.requested) if (!actors.has(actorKey(job, kind)) && !['done', 'paused', 'stopped'].includes(job.modules[kind].status)) {
          Object.assign(job.modules[kind], { status: error.code === 'ACCOUNT_REQUIRED' ? 'waiting_account' : 'blocked', message: error.message });
          log(job, kind, error.message);
        }
        await publish(job);
      }
    } finally { preparing.delete(job.id); finishOperation(); }
  }
  async function restartModule(job, kind, restart = 0) {
    if (kind === 'collector') return launchCollector(job, restart);
    if (kind === 'homework') {
      const account = { role: 'primary', userId: job.primaryId };
      job.inventory.exercises = await catalog.exercises(account, job.inventory);
      if (job.targets?.length) job.inventory.exercises = job.inventory.exercises.filter(exercise => job.targets.includes(exercise.title));
      const coverage = await refreshCoverage(job);
      return spawn(job, kind, { course: job.course, exercises: job.inventory.exercises, ready: coverage.ready, producerFinished: !coverage.missing.length || ['done', 'partial', 'blocked'].includes(job.modules.collector?.status) }, 'primary', restart);
    }
    const account = { role: 'primary', userId: job.primaryId };
    const fresh = await catalog.discover(account, job.course.url); return spawn(job, kind, { course: job.course, units: fresh.units.filter(unit => unit.kind === kind) }, 'primary', restart);
  }
  return { refreshCoverage, launchCollector, prepare, restartModule };
}
module.exports = { createPipeline };
