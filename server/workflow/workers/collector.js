const { workers } = require('../../../src/tasks');
const { fingerprint, standardAnswer, probeBody } = require('../questions');
function createCollector({ rpc, progress, signal }) {
  async function collect(input) {
    const result = { total: input.missing.length, processed: 0, captured: 0, failed: 0, results: [] };
    const wanted = new Map(input.missing.map(item => [`${item.leafId}:${item.problemId}`, item]));
    const seen = new Set(), unavailable = new Map();
    await workers(input.exercises, input.concurrency || 3, async exercise => {
      if (exercise.error) { unavailable.set(exercise.leafId, exercise.error); return; }
      for (const problem of exercise.problems) {
        signal.throwIfAborted(); const item = wanted.get(`${exercise.leafId}:${problem.problem_id}`); if (!item) continue;
        seen.add(`${exercise.leafId}:${problem.problem_id}`);
        let error;
        if (fingerprint(problem) !== item.fingerprint) error = '测试账号题目版本与正式账号不匹配';
        else {
          let source = problem.user, sourceName = 'exercise_list';
          if (!standardAnswer(problem, source) && input.submitUnanswered !== false && Number(problem.user?.my_count || 0) === 0) {
            const body = probeBody(problem);
            if (!body) error = '不支持该题型的采集提交';
            else {
              try { source = await rpc('submit-question', { leafId: exercise.leafId, problemId: Number(problem.problem_id), body }); sourceName = 'submission_response'; }
              catch (e) { if (signal.aborted || ['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(e.code)) throw e; error = e.message; }
            }
          }
          if (!error) {
            if (!standardAnswer(problem, source)) error = '后端未公开标准答案或作答机会已用尽';
            else await rpc('save-answer', { leafId: exercise.leafId, problemId: Number(problem.problem_id), source, sourceName });
          }
        }
        result.processed++; result[error ? 'failed' : 'captured']++;
        result.results.push({ unitId: exercise.leafId, problemId: Number(problem.problem_id), status: error ? 'missing' : 'captured', ...(error ? { error } : {}) });
        progress({ ...result, message: error || `已采集 ${result.captured}/${result.total} 条答案` });
      }
    }, { signal });
    for (const item of input.missing) if (!seen.has(`${item.leafId}:${item.problemId}`)) {
      result.failed++; result.processed++; result.results.push({ unitId: item.leafId, problemId: item.problemId, status: 'missing', error: unavailable.get(item.leafId) || '测试账号未返回对应题目' });
    }
    return result;
  }
  return collect;
}
module.exports = { createCollector };
