import { primaryId } from '../workspace/presentation.js';
export const emptyScore = () => ({ loading: false, available: false, value: null, message: '', primaryId: 0 });

export function createCourseScore({ state, client }) {
  let generation = 0, closed = false, pending, abort;
  function reset() {
    generation++; abort?.abort(); abort = null; pending = null;
    state.score = emptyScore();
  }
  function load(force = false) {
    if (closed || !state.session.connected || !client.workflowCourseScore) return Promise.resolve();
    if (pending && !force) return pending;
    abort?.abort(); abort = new AbortController();
    const id = ++generation, account = primaryId(state.session);
    state.score = { ...state.score, loading: true, message: '', primaryId: account };
    pending = (async () => {
      try {
        const result = await client.workflowCourseScore(abort.signal);
        if (closed || id !== generation || primaryId(state.session) !== account) return;
        if (Number(result.primaryId) !== account) throw new Error('平台账号已切换，请刷新成绩');
        if (result.course?.classroomId != null && result.course.classroomId === state.courses[0]?.classroomId && result.course.title) state.courses = [result.course];
        const available = result.available === true && typeof result.score === 'number' && Number.isFinite(result.score) && result.score >= 0 && result.score <= 100;
        state.score = { loading: false, available, value: available ? result.score : null, message: result.message || (available ? '' : '平台暂无成绩'), primaryId: account };
      } catch (error) {
        if (!closed && id === generation) state.score = { ...emptyScore(), primaryId: account, message: error.message || '成绩暂不可用，请稍后刷新' };
      } finally {
        if (id === generation) { pending = null; abort = null; }
      }
    })();
    return pending;
  }
  function dispose() { closed = true; generation++; abort?.abort(); pending = null; }
  return { load, reset, dispose };
}
