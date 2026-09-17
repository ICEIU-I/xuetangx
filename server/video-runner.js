const { EventEmitter } = require('node:events');
const videoService = require('../src/video');
const session = require('./session');

function createVideoRunner({ service = videoService, sessions = session } = {}) {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  let state = { status: 'idle', stage: '', sent: 0, total: 0, message: '', result: null };
  let controller = null;
  let task = null;
  let generation = 0;
  const getState = () => ({ ...state });
  const emit = () => bus.emit('event', { type: 'video', ...getState(), ts: Date.now() });

  function start(input) {
    if (task) throw new Error('已有视频任务在运行，请等待结束');
    if (!sessions.isConnected()) throw new Error('未连接，请先设置 Cookie');
    if (!input || (typeof input.courseUrl !== 'string' && typeof input.url !== 'string')) throw new Error('请先选择一门课程或填写视频链接');
    const isCourse = typeof input.courseUrl === 'string';
    if (isCourse) videoService.parseCourseUrl(input.courseUrl);
    else videoService.parseVideoUrl(input.url);
    if (isCourse && input.concurrency != null && (!Number.isInteger(Number(input.concurrency)) || Number(input.concurrency) < 1 || Number(input.concurrency) > 3)) throw new Error('视频并发数须为 1–3');
    if (input.durationSeconds != null && (!Number.isFinite(Number(input.durationSeconds))
      || Number(input.durationSeconds) <= 0 || Number(input.durationSeconds) > 86400)) throw new Error('总时长须为 1–86400 秒');
    const cookie = sessions.getCookie();
    const token = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    state = { status: 'running', stage: 'loading', mode: isCourse ? 'course' : 'single', sent: 0, total: 0,
      totalVideos: 0, processedVideos: 0, completedVideos: 0, skippedVideos: 0, failedVideos: 0, recentResults: [],
      activeVideos: [], concurrency: isCourse ? Number(input.concurrency ?? 3) : 1,
      message: '正在准备…', result: null, startedAt: Date.now(), url: input.url };
    emit();
    const callbacks = { signal, onProgress(update) {
      if (token === generation) { state = { ...state, ...update }; emit(); }
    } };
    task = Promise.resolve().then(() => isCourse ? service.completeCourse(input, cookie, callbacks) : service.complete(input, cookie, callbacks)).then(result => {
      if (token !== generation) return;
      const partial = result.kind === 'batch' && (result.failedVideos || result.stoppedReason);
      state = { ...state, status: signal.aborted ? 'stopped' : partial ? 'partial' : 'done', result,
        message: signal.aborted ? '任务已停止，请刷新后端进度' : result.kind === 'batch'
          ? `${partial ? '批量处理结束，存在未完成项' : '该课程全部视频已处理'}：新完成 ${result.completedVideos}，跳过 ${result.skippedVideos}，失败 ${result.failedVideos}`
          : result.alreadyCompleted ? '后端已完成，已跳过上报' : '后端已确认视频完成' };
    }).catch(error => {
      if (token !== generation) return;
      state = { ...state, status: signal.aborted ? 'stopped' : 'error', message: signal.aborted ? '任务已停止；已接收的记录可能已计入进度' : error.message };
    }).finally(() => { task = null; controller = null; if (token === generation) emit(); });
    return getState();
  }

  function stop() {
    if (controller) { controller.abort(); state.message = '正在停止…'; emit(); }
    return getState();
  }

  function reset() {
    generation++;
    controller?.abort();
    state = { status: 'idle', stage: '', sent: 0, total: 0, message: '', result: null };
    emit();
  }

  return { start, stop, reset, getState, waitForIdle: () => task || Promise.resolve(),
    onEvent(listener) { bus.on('event', listener); return () => bus.off('event', listener); } };
}

module.exports = { createVideoRunner, ...createVideoRunner() };
