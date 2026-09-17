const { EventEmitter } = require('node:events');
const service = require('../src/answer-bank');
const { parseCourseUrl } = require('../src/video');
const session = require('./session');

function createAnswerRunner({ collector = service, sessions = session } = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(50);
  let state = { status: 'idle', message: '', result: null }, task, controller, generation = 0;
  const snapshot = () => ({ ...state });
  const emit = () => events.emit('event', { ...snapshot(), type: 'answer-bank', ts: Date.now() });
  function start(input) {
    if (task) throw new Error('已有答案采集任务在运行');
    if (!sessions.isConnected()) throw new Error('请先连接登录态');
    parseCourseUrl(input?.courseUrl);
    if (input.submitUnanswered != null && typeof input.submitUnanswered !== 'boolean') throw new Error('采集模式无效');
    const cookie = sessions.getCookie(), token = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    state = { status: 'running', stage: 'discovering', message: '准备采集答案…', result: null, courseUrl: input.courseUrl,
      mode: input.submitUnanswered === true ? 'submit' : 'visible', totalQuestions: 0, capturedAnswers: 0, missingAnswers: 0, totalExercises: 0, processedExercises: 0, submitted: 0 };
    emit();
    task = Promise.resolve().then(() => collector.collect(input, cookie, { signal, onProgress(update) {
      if (token === generation) { state = { ...state, ...update }; emit(); }
    } })).then(result => {
      if (token !== generation) return;
      state = { ...state, result, status: signal.aborted ? 'stopped' : result.complete ? 'done' : 'partial',
        message: signal.aborted ? '已停止，已采集答案保存在本地' : result.complete ? '该课程练习答案已完整保存' : '已保存可获取的答案，缺失项已标记' };
    }).catch(error => {
      if (token === generation) state = { ...state, status: signal.aborted ? 'stopped' : 'error', message: signal.aborted ? '已停止，已采集答案保存在本地' : error.message };
    }).finally(() => { task = null; controller = null; if (token === generation) emit(); });
    return snapshot();
  }
  function stop() { controller?.abort(); return snapshot(); }
  function reset() { generation++; controller?.abort(); state = { status: 'idle', message: '', result: null }; emit(); }
  return { start, stop, reset, getState: snapshot, waitForIdle: () => task || Promise.resolve(),
    onEvent(listener) { events.on('event', listener); return () => events.off('event', listener); } };
}
module.exports = { createAnswerRunner, ...createAnswerRunner() };
