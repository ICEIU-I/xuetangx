function createContext(runtime) {
  const handle = fn => async (req, res) => { try { await fn(req, res); } catch (error) { res.status(error.code === 'ACCOUNT_REQUIRED' ? 401 : 400).json({ ok: false, error: error.message, code: error.code }); } };
  const primary = () => { const value = runtime.accounts.get('primary'); return { role: 'primary', userId: value.userId }; };
  let courseCache = null;
  async function courseList() {
    const account = primary();
    if (!courseCache || courseCache.userId !== account.userId || courseCache.until < Date.now()) {
      const promise = runtime.catalog.listCourses(account); courseCache = { userId: account.userId, until: Date.now() + 15000, promise };
      promise.catch(() => { if (courseCache?.promise === promise) courseCache = null; });
    }
    return courseCache.promise;
  }
  const initial = () => ({ status: 'idle', message: '', total: 0, done: 0, processed: 0, correct: 0, failed: 0, result: null });
  function legacyState(kind, job) {
    const module = job?.modules[kind]; if (!module) return initial();
    const status = ['running', 'queued', 'scanning', 'waiting_answers', 'waiting_rate_limit'].includes(module.status) ? 'running'
      : ['blocked', 'error', 'waiting_account', 'waiting_enrollment'].includes(module.status) ? 'error' : module.status;
    const results = (module.results || []).map(item => ({ ...item, leafId: item.unitId, url: `${job.course.url}/${kind}/${item.unitId}` }));
    const value = { ...module, status, jobId: job.id, course: job.course, courseUrl: job.course.url, concurrency: job.concurrency, results };
    if (kind === 'video') Object.assign(value, { mode: 'course', totalVideos: module.total || 0, processedVideos: module.processed || 0, completedVideos: module.completed || 0,
      skippedVideos: module.skipped || 0, failedVideos: module.failed || 0, recentResults: results, result: ['done', 'partial'].includes(status) ? { kind: 'batch', results } : null });
    if (kind === 'homework') Object.assign(value, { done: module.processed || 0, correct: module.completed || 0, ratePerMin: 0, etaSec: 0, skipped: module.skipped || 0 });
    if (kind === 'collector') Object.assign(value, { totalQuestions: job.coverage?.total || 0, capturedAnswers: job.coverage?.captured || 0, missingAnswers: job.coverage?.missing || 0,
      totalExercises: 0, processedExercises: 0, result: module.status === 'done' ? { course: job.course } : null });
    return value;
  }
  async function latest(kind) { const state = await runtime.snapshot(); return state.jobs.find(job => job.modules[kind]); }
  return { runtime, handle, primary, courseList, legacyState, latest, invalidateCourses: () => { courseCache = null; } };
}
module.exports = { createContext };
