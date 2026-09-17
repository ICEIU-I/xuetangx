const { fingerprint, submitBody } = require('../questions');
function createHomework({ rpc, request, progress, signal, subscribe }) {
  async function homework(input) {
    const entries = input.exercises.flatMap(exercise => exercise.problems.map(problem => ({ exercise, problem, key: `${exercise.leafId}:${problem.problem_id}` })));
    const answers = new Map(input.ready.map(item => [`${item.leafId}:${item.problemId}`, item]));
    const done = new Set(), inFlight = new Set(), sleepers = new Set(); let producerFinished = !!input.producerFinished, fatal;
    const result = { total: entries.length, processed: 0, completed: 0, skipped: 0, failed: 0, wrongExisting: 0, results: [] };
    const wake = () => { sleepers.forEach(resolve => resolve()); sleepers.clear(); };
    const unsubscribe = subscribe(message => {
      if (message.type === 'answer-ready') answers.set(`${message.answer.leafId}:${message.answer.problemId}`, message.answer);
      if (message.type === 'answers-complete') producerFinished = true;
      wake();
    });
    signal.addEventListener('abort', wake);
    for (const entry of entries) if (Number(entry.problem.user?.my_count || 0) > 0) {
      const wrong = entry.problem.user.is_right === false;
      done.add(entry.key); result.processed++; result.skipped++; if (wrong) result.wrongExisting++;
      result.results.push({ unitId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), status: wrong ? 'wrong_existing' : 'skipped', ...(wrong ? { error: '已作答但判错；不自动消耗重答机会' } : {}) });
    }
    async function worker() {
      for (;;) {
        signal.throwIfAborted();
        if (fatal) throw fatal;
        const entry = entries.find(item => !done.has(item.key) && !inFlight.has(item.key) && answers.get(item.key)?.fingerprint === fingerprint(item.problem));
        if (!entry) {
          if (done.size === entries.length || (producerFinished && !inFlight.size)) return;
          progress({ ...result, stage: 'waiting_answers', message: '等待缺失答案；已获取的答案会自动开始作答' });
          await new Promise(resolve => sleepers.add(resolve)); continue;
        }
        inFlight.add(entry.key);
        try {
          const answer = answers.get(entry.key).answer;
          const response = await rpc('submit-question', { leafId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), body: submitBody(answer) });
          const correct = response.is_correct === true || response.is_right === true;
          result[correct ? 'completed' : 'failed']++;
          result.results.push({ unitId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), status: correct ? 'completed' : 'failed', ...(!correct ? { error: '服务器未判定作答正确' } : {}) });
        } catch (error) {
          if (signal.aborted || ['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(error.code)) throw error;
          result.failed++; result.results.push({ unitId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), status: 'failed', error: error.message });
        } finally { done.add(entry.key); inFlight.delete(entry.key); result.processed++; wake(); }
        progress({ ...result, stage: 'answering', message: `已处理 ${result.processed}/${result.total} 题` });
      }
    }
    try {
      const outcomes = await Promise.allSettled(Array.from({ length: input.concurrency || 3 }, async () => {
        try { return await worker(); } catch (error) { fatal = error; wake(); throw error; }
      }));
      const error = outcomes.find(outcome => outcome.status === 'rejected'); if (error) throw error.reason;
      for (const entry of entries) if (!done.has(entry.key)) { result.failed++; result.processed++; result.results.push({ unitId: entry.exercise.leafId, problemId: Number(entry.problem.problem_id), status: 'missing', error: '缺少匹配的标准答案' }); }
      for (const exercise of input.exercises) {
        if (exercise.error) { result.failed++; result.results.push({ unitId: exercise.leafId, status: 'blocked', error: exercise.error }); continue; }
        const fresh = await request('GET', `/api/v1/lms/exercise/get_exercise_list/${exercise.exerciseId}/${exercise.skuId}/`);
        const problems = new Map((fresh.problems || []).map(problem => [Number(problem.problem_id), problem]));
        for (const item of result.results.filter(item => item.unitId === exercise.leafId && item.status === 'completed')) {
          const user = problems.get(item.problemId)?.user;
          if (!(Number(user?.my_count) > 0 && user.is_right === true)) { item.status = 'failed'; item.error = '最终回查未确认作答正确'; result.completed--; result.failed++; }
        }
      }
      return result;
    } finally { unsubscribe(); signal.removeEventListener('abort', wake); wake(); }
  }
  return homework;
}
module.exports = { createHomework };
