const { EventEmitter } = require('node:events');
const homework = require('../src/homework');
const { parseCourseUrl } = require('../src/video');
const { concurrency: getConcurrency } = require('../src/tasks');
const session = require('./session');

function createHomeworkRunner({ service = homework, sessions = session } = {}) {
  const bus = new EventEmitter(); bus.setMaxListeners(50);
  const idle = () => ({ status: 'idle', total: 0, done: 0, correct: 0, failed: 0, ratePerMin: 0, etaSec: 0, rateLimited: false, skipped: 0, missing: 0 });
  let state = idle(), task, controller, generation = 0;
  let recent = [];
  const getState = () => {
    recent = recent.filter(time => Date.now() - time < 60000);
    const ratePerMin = recent.length;
    return { ...state, ratePerMin, etaSec: ratePerMin ? Math.round(Math.max(0, state.total - state.done) / ratePerMin * 60) : 0 };
  };
  const emit = (type, extra = {}) => bus.emit('event', { ...getState(), ...extra, type, ts: Date.now() });
  function startRun(input = {}) {
    if (task) throw new Error('已有作业任务在运行');
    if (!sessions.isConnected()) throw new Error('请先连接登录态');
    parseCourseUrl(input.courseUrl);
    if (input.targets != null && (!Array.isArray(input.targets) || input.targets.some(value => typeof value !== 'string'))) throw new Error('作业选择格式无效');
    input = { ...input, concurrency: getConcurrency(input.concurrency) };
    const cookie = sessions.getCookie(), token = ++generation;
    controller = new AbortController(); const signal = controller.signal;
    recent = [];
    state = { ...idle(), status: 'running', concurrency: input.concurrency, courseUrl: input.courseUrl, startedAt: Date.now() };
    emit('phase', { msg: '准备课程作业任务…' });
    task = Promise.resolve().then(() => service.complete(input, cookie, { signal, onProgress(event) {
      if (token !== generation) return;
      if (event.type === 'progress' && event.mark !== 'fail') recent.push(Date.now());
      for (const key of ['total', 'done', 'correct', 'failed', 'skipped', 'missing']) if (event[key] != null) state[key] = event[key];
      emit(event.type, event);
    } })).then(result => {
      if (token !== generation) return;
      state = { ...state, ...result, status: signal.aborted ? 'stopped' : result.failed || result.missing ? 'partial' : 'done' };
      emit(state.status, { msg: result.total === 0 ? `没有待提交题目，已做 ${result.skipped} 题，缺失答案 ${result.missing} 题` : undefined });
    }).catch(error => {
      if (token !== generation) return;
      state.status = signal.aborted ? 'stopped' : 'error'; state.message = error.message;
      emit(state.status, { msg: signal.aborted ? '作业任务已停止' : error.message });
    }).finally(() => { task = null; controller = null; });
    return getState();
  }
  function stopRun() { controller?.abort(); }
  function reset() { generation++; controller?.abort(); state = idle(); recent = []; emit('reset'); }
  return { startRun, stopRun, reset, getState, snapshot: getState, waitForIdle: () => task || Promise.resolve(),
    onEvent(listener) { bus.on('event', listener); return () => bus.off('event', listener); } };
}
module.exports = { createHomeworkRunner, ...createHomeworkRunner() };
