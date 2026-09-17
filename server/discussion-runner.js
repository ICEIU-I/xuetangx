const { concurrency: getConcurrency } = require('../src/tasks');
const { EventEmitter } = require('node:events');
const discussion = require('../src/discussion');
const { parseCourseUrl } = require('../src/video');
const session = require('./session');

function createDiscussionRunner({ service = discussion, sessions = session } = {}) {
  const bus = new EventEmitter(); bus.setMaxListeners(50);
  let state = { status: 'idle', message: '', result: null }, task, controller, generation = 0;
  const getState = () => ({ ...state });
  const emit = () => bus.emit('event', { ...getState(), type: 'discussion', ts: Date.now() });
  function start(input) {
    if (task) throw new Error('已有讨论题任务在运行');
    if (!sessions.isConnected()) throw new Error('请先连接登录态');
    parseCourseUrl(input?.courseUrl);
    input = { ...input, concurrency: getConcurrency(input.concurrency) };
    const token = ++generation, cookie = sessions.getCookie();
    controller = new AbortController(); const signal = controller.signal;
    state = { status: 'running', total: 0, processed: 0, completed: 0, skipped: 0, failed: 0, results: [],
      courseUrl: input.courseUrl, concurrency: input.concurrency, message: '准备发布课程讨论题…', result: null };
    emit();
    task = Promise.resolve().then(() => service.completeCourse(input, cookie, { signal, onProgress(update) {
      if (token === generation) { state = { ...state, ...update }; emit(); }
    } })).then(result => {
      if (token !== generation) return;
      const partial = result.failed > 0 || !!result.stoppedReason;
      state = { ...state, result, status: signal.aborted ? 'stopped' : partial ? 'partial' : 'done',
        message: signal.aborted ? '已停止，已发布的讨论不重复发送' : partial ? '部分讨论题未能完成，请查看结果' : `本课程 ${result.total} 个讨论题均已完成` };
    }).catch(error => {
      if (token === generation) state = { ...state, status: signal.aborted ? 'stopped' : 'error', message: signal.aborted ? '已停止，已发布的讨论不重复发送' : error.message };
    }).finally(() => { task = null; controller = null; if (token === generation) emit(); });
    return getState();
  }
  function stop() { controller?.abort(); return getState(); }
  function reset() { generation++; controller?.abort(); state = { status: 'idle', message: '', result: null }; emit(); }
  return { start, stop, reset, getState, waitForIdle: () => task || Promise.resolve(),
    onEvent(listener) { bus.on('event', listener); return () => bus.off('event', listener); } };
}
module.exports = { createDiscussionRunner, ...createDiscussionRunner() };
