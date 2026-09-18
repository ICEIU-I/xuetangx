import { primaryId } from '../workspace/presentation.js';
export const emptyScore = () => ({ loading: false, available: false, value: null, breakdown: [], message: '', primaryId: 0, updatedAt: 0, retryAt: 0, stale: false, waiting: false });

// One account-scoped request and timer shared by the course and task views.
export function createCourseScore({ state, client, interval = 15000, now = Date.now, schedule = setTimeout, cancel = clearTimeout, visibility = globalThis.document }) {
  let generation = 0, closed = false, pending, abort, timer, failures = 0, suspended = false;
  const watchers = new Set();
  const visible = () => !visibility?.hidden && [...watchers].some(accept => accept());
  function stopTimer() { cancel(timer); timer = null; }
  function plan() {
    stopTimer();
    if (closed || suspended || pending || !state.session.connected || !visible()) return;
    const due = Math.max(state.score.retryAt || 0, (state.score.updatedAt || 0) + interval);
    timer = schedule(() => { timer = null; void load(); }, Math.max(0, due - now()));
  }
  function reset() {
    generation++; abort?.abort(); abort = null; pending = null;
    stopTimer(); failures = 0; suspended = false;
    state.score = emptyScore();
  }
  function waitUntil(retryAt, message) {
    state.score = { ...state.score, loading: false, waiting: true, stale: state.score.available, retryAt, message };
  }
  function load() {
    if (closed || suspended || !state.session.connected || !client.workflowCourseScore) return Promise.resolve();
    if (pending) return pending;
    stopTimer();
    const limit = state.rateLimits?.primary;
    const retryAt = Math.max(state.score.retryAt || 0, limit?.blocked && limit.scope === 'account' ? Number(limit.readyAt) || 0 : 0);
    if (retryAt > now()) {
      waitUntil(retryAt, '平台暂时限制访问，稍后自动更新'); plan(); return Promise.resolve();
    }
    abort = new AbortController();
    const id = ++generation, account = primaryId(state.session), signal = abort.signal;
    state.score = { ...state.score, loading: true, primaryId: account };
    pending = (async () => {
      try {
        const result = await client.workflowCourseScore(signal);
        if (closed || id !== generation || primaryId(state.session) !== account) return;
        if (Number(result.primaryId) !== account) throw Object.assign(new Error('平台账号已切换，请重新连接'), { code: 'ACCOUNT_CHANGED' });
        if (result.waiting) {
          waitUntil(Math.max(Number(result.retryAt) || 0, now() + interval), result.message || '平台暂时限制访问，稍后自动更新');
          return;
        }
        if (result.course?.classroomId === state.courses[0]?.classroomId && result.course?.title) state.courses = [result.course];
        const available = result.available === true && typeof result.score === 'number' && Number.isFinite(result.score) && result.score >= 0 && result.score <= 100;
        state.score = { ...emptyScore(), available, value: available ? result.score : null, breakdown: result.breakdown || [], message: result.message || (available ? '' : '平台暂无成绩'), primaryId: account, updatedAt: now() };
        failures = 0;
      } catch (error) {
        if (closed || id !== generation || primaryId(state.session) !== account) return;
        suspended = ['ACCOUNT_REQUIRED', 'ACCOUNT_CHANGED', 'AUTH_REQUIRED'].includes(error.code);
        if (suspended) state.score = { ...emptyScore(), primaryId: account, message: '请重新连接学堂在线' };
        else state.score = { ...state.score, loading: false, stale: state.score.available, waiting: false, message: error.message || '成绩更新失败，将自动重试', retryAt: now() + Math.min(interval * 2 ** failures++, 120000) };
      } finally {
        if (id === generation) { pending = null; abort = null; plan(); }
      }
    })();
    return pending;
  }
  function watch(accept = () => true) {
    watchers.add(accept); plan();
    return () => { watchers.delete(accept); plan(); };
  }
  function visibilityChanged() {
    if (!visible()) stopTimer();
    else plan();
  }
  visibility?.addEventListener('visibilitychange', visibilityChanged);
  function dispose() {
    closed = true; generation++; abort?.abort(); pending = null; stopTimer(); watchers.clear();
    visibility?.removeEventListener('visibilitychange', visibilityChanged);
  }
  return { load, watch, reset, dispose };
}
