const { concurrency: getConcurrency } = require('../src/tasks');
const { EventEmitter } = require('node:events');
const article = require('../src/article');
const { parseCourseUrl } = require('../src/video');
const session = require('./session');

function createArticleRunner({ service = article, sessions = session } = {}) {
  const bus = new EventEmitter(); bus.setMaxListeners(50);
  let state = { status: 'idle', message: '', result: null }, task, controller, generation = 0;
  const getState = () => ({ ...state });
  const emit = () => bus.emit('event', { ...getState(), type: 'article', ts: Date.now() });
  function start(input) {
    if (task) throw new Error('已有图文任务在运行');
    if (!sessions.isConnected()) throw new Error('请先连接登录态');
    parseCourseUrl(input?.courseUrl);
    input = { ...input, concurrency: getConcurrency(input.concurrency) };
    const token = ++generation, cookie = sessions.getCookie();
    controller = new AbortController(); const signal = controller.signal;
    state = { status: 'running', total: 0, processed: 0, completed: 0, skipped: 0, failed: 0, results: [],
      courseUrl: input.courseUrl, concurrency: input.concurrency, message: '准备标记课程图文…', result: null };
    emit();
    task = Promise.resolve().then(() => service.completeCourse(input, cookie, { signal, onProgress(update) {
      if (token === generation) { state = { ...state, ...update }; emit(); }
    } })).then(result => {
      if (token !== generation) return;
      const partial = result.failed > 0 || !!result.stoppedReason;
      state = { ...state, result, status: signal.aborted ? 'stopped' : partial ? 'partial' : 'done',
        message: signal.aborted ? '已停止，已标记的图文保留完成状态' : partial ? '部分图文未能完成，请查看结果' : `本课程 ${result.total} 个图文均已看完` };
    }).catch(error => {
      if (token === generation) state = { ...state, status: signal.aborted ? 'stopped' : 'error', message: signal.aborted ? '已停止，已标记的图文保留完成状态' : error.message };
    }).finally(() => { task = null; controller = null; if (token === generation) emit(); });
    return getState();
  }
  function stop() { controller?.abort(); return getState(); }
  function reset() { generation++; controller?.abort(); state = { status: 'idle', message: '', result: null }; emit(); }
  return { start, stop, reset, getState, waitForIdle: () => task || Promise.resolve(),
    onEvent(listener) { bus.on('event', listener); return () => bus.off('event', listener); } };
}
module.exports = { createArticleRunner, ...createArticleRunner() };
