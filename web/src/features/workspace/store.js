import { observable } from '../../shared/observable.js';
import { api, subscribeEvents } from '../../api.js';
import { createCourseScore, emptyScore } from '../course-score/store.js';
import { selectedCourse } from './courses.js';
import { primaryId } from './presentation.js';
import { homepageJob, startScope, matchesPendingScope } from './course-tasks.js';

export function createWorkspace({ client = api, subscribe = subscribeEvents, storage = globalThis.sessionStorage, owner = '', pollMs = 5000 } = {}) {
  const changes = observable({ session: { connected: false, user: null }, jobs: [], courses: [], selectedCourseUrl: '', coursesLoading: false, coursesWarning: '', score: emptyScore(), rateLimits: {}, collectorLimits: {}, sharedCollectors: 0, loading: true, error: '', syncError: '', stream: 'connecting', starting: false, pendingStart: null, actionId: '', detailId: '' });
  const state = changes.state;
  const scores = createCourseScore({ state, client });
  const loadScore = scores.load;
  const currentJob = { get value() { return homepageJob(state.jobs, state.session, selectedCourse(state)); } };
  let closed = false, epoch = 0, refreshId = 0, stream, timer, refreshing, courseRequest = 0, jobRequest = 0;
  const storageKey = `iceiu:pending-start:${owner}`;
  try { state.pendingStart = JSON.parse(storage?.getItem(storageKey) || 'null'); } catch {}
  function savePending(value) {
    state.pendingStart = value;
    try { if (value) storage?.setItem(storageKey, JSON.stringify(value)); else storage?.removeItem(storageKey); } catch {}
  }
  function mergeJob(job) {
    if (!job || closed) return;
    const old = state.jobs.find(j => j.id === job.id);
    if (old && (old.revision || 0) > (job.revision || 0)) return;
    state.jobs = [...state.jobs.filter(j => j.id !== job.id), job].sort((a, b) => b.createdAt - a.createdAt);
    if (old && old.status !== 'done' && job.status === 'done' && currentJob.value?.id === job.id) void loadScore(true);
  }
  function setSession(session) {
    if (closed) return;
    if (primaryId(session) !== primaryId(state.session) || session.connected !== state.session.connected || session.connectedAt !== state.session.connectedAt) {
      epoch++;
      state.jobs = [];
      courseRequest++; jobRequest++; state.courses = []; state.selectedCourseUrl = ''; state.coursesWarning = ''; state.coursesLoading = false;
      state.rateLimits = {};
      state.collectorLimits = {};
      scores.reset();
      state.error = '';
      if (state.pendingStart && primaryId(session) && Number(state.pendingStart.primaryId) !== primaryId(session)) savePending(null);
    }
    state.session = session;
  }
  function recoverPending() {
    const pending = state.pendingStart;
    if (!pending) return null;
    const job = state.jobs.find(j => Number(j.primaryId) === Number(pending.primaryId) && j.course.url === pending.courseUrl && matchesPendingScope(j, pending) && (!pending.previous.includes(j.id) || ['queued', 'running', 'waiting_input'].includes(j.status)));
    if (job) savePending(null);
    return job;
  }
  async function refresh() {
    const id = ++refreshId, identity = epoch;
    const snapshot = await client.workflowState(0, 100);
    if (closed || id !== refreshId || identity !== epoch) return;
    const before = epoch;
    if (snapshot.accounts?.primary) setSession(snapshot.accounts.primary);
    const snapshotEpoch = epoch;
    if (before !== epoch) await loadCourses();
    if (closed || id !== refreshId || snapshotEpoch !== epoch) return;
    for (const job of snapshot.jobs || []) mergeJob(job);
    state.rateLimits = snapshot.rateLimits || {};
    state.collectorLimits = snapshot.collectorLimits || {};
    state.sharedCollectors = snapshot.sharedCollectors || 0;
    state.syncError = '';
    recoverPending();
    if (state.detailId) await getJob(state.detailId);
  }
  async function getJob(id) {
    const identity = epoch;
    const result = await client.workflowJob(id);
    if (!closed && identity === epoch) mergeJob(result.job);
    return result.job;
  }
  async function refreshSafely() {
    if (closed || refreshing) return;
    refreshing = refresh().catch(() => { if (!closed) state.syncError = '进度暂时无法更新，正在重新连接。服务端任务会继续运行。'; }).finally(() => { refreshing = null; });
    await refreshing;
  }
  function receive(event) {
    if (closed) return;
    state.stream = 'connected';
    if (event.type === 'accounts' && event.accounts?.primary) {
      const before = epoch; setSession(event.accounts.primary);
      if (before !== epoch) void loadCourses();
      refreshSafely();
    }
    if (event.type === 'workflow') { mergeJob(event.job); recoverPending(); }
    if (event.type === 'rate-limit') state.rateLimits = { ...state.rateLimits, [event.role]: event };
  }
  const courseStorageKey = () => `iceiu:selected-course:${owner}:${primaryId(state.session)}`;
  async function loadSelectedJob() {
    const id = ++jobRequest, identity = epoch, url = selectedCourse(state)?.url;
    if (!url || currentJob.value || !primaryId(state.session)) return;
    let offset = 100;
    while (!closed && identity === epoch && id === jobRequest && selectedCourse(state)?.url === url) {
      const page = await client.workflowState(offset, 100);
      if (closed || identity !== epoch || id !== jobRequest || selectedCourse(state)?.url !== url) return;
      (page.jobs || []).forEach(mergeJob);
      if (currentJob.value || offset + 100 >= (page.pagination?.total || 0)) break;
      offset += 100;
    }
  }
  function selectCourse(url) {
    if (state.starting || state.pendingStart || !state.courses.some(c => c.url === url)) return;
    if (state.selectedCourseUrl === url) return;
    state.selectedCourseUrl = url; state.error = ''; scores.reset();
    try { storage?.setItem(courseStorageKey(), url); } catch {}
    if (state.session.connected) void loadScore();
    void loadSelectedJob().catch(() => { if (!closed) state.syncError = '课程任务记录暂时无法更新。'; });
  }
  async function loadCourses() {
    const id = ++courseRequest, identity = epoch, account = primaryId(state.session);
    state.coursesLoading = true; state.coursesWarning = '';
    try {
      const result = await client.workflowCourses();
      if (closed || id !== courseRequest || identity !== epoch) return;
      if (result.primaryId !== undefined && Number(result.primaryId) !== account) throw new Error('平台账号已切换，请刷新课程列表。');
      if (result.connectedAt !== undefined && state.session.connectedAt && result.connectedAt !== state.session.connectedAt) throw new Error('平台账号已重新连接，请刷新课程列表。');
      const previous = selectedCourse(state)?.url;
      // On a temporary upstream failure retain only this account's previous
      // list, clearly marked as stale, rather than losing a selected course.
      if (!result.warning || !state.courses.length) state.courses = result.courses || [];
      state.coursesWarning = result.warning || '';
      let saved; try { saved = storage?.getItem(courseStorageKey()); } catch {}
      const wanted = state.pendingStart?.courseUrl || state.selectedCourseUrl || saved;
      state.selectedCourseUrl = state.courses.find(c => c.url === wanted)?.url || state.courses[0]?.url || '';
      if (previous !== selectedCourse(state)?.url) scores.reset();
      if (state.session.connected) void loadScore();
    } catch (error) {
      if (!closed && id === courseRequest && identity === epoch) state.coursesWarning = error.message || '已选课程读取失败，请刷新重试。';
    } finally { if (!closed && id === courseRequest && identity === epoch) state.coursesLoading = false; }
  }
  async function initialize() {
    state.loading = true; state.error = '';
    try {
      const session = await client.session();
      if (closed) return;
      setSession(session);
      await Promise.all([loadCourses(), refresh()]);
      await loadSelectedJob();
    } catch (e) { if (!closed) state.error = e.message; }
    finally { if (!closed) state.loading = false; }
    if (!closed && !stream) {
      stream = subscribe(receive, {
        open: () => { state.stream = 'connected'; refreshSafely(); },
        error: () => { state.stream = 'reconnecting'; refreshSafely(); },
      });
      timer = setInterval(refreshSafely, pollMs);
    }
  }
  async function connected(account) {
    setSession(account);
    await Promise.all([loadCourses(), refresh()]);
  }
  async function disconnect() {
    await client.disconnect();
    setSession({ ...state.session, connected: false });
    await refresh();
  }
  async function checkStart() {
    state.starting = true; state.error = '';
    try {
      await refresh();
      const recovered = recoverPending();
      if (state.pendingStart) state.error = '暂未找到新任务，系统将继续核对。请勿重复启动，可稍后重新检查。';
      return recovered || currentJob.value;
    } catch { state.error = '暂时无法核对任务，请恢复连接后重新检查。'; }
    finally { state.starting = false; }
  }
  async function start(courseUrl, concurrency = 1, options = {}) {
    if (state.starting || state.pendingStart) return;
    state.starting = true; state.error = '';
    const identity = epoch;
    if (state.courses.some(c => c.url === courseUrl)) { state.selectedCourseUrl = courseUrl; scores.reset(); }
    savePending({ courseUrl, primaryId: primaryId(state.session), previous: state.jobs.map(j => j.id), ...startScope(options) });
    try {
      const result = await client.workflowStart(courseUrl, concurrency, options);
      if (closed || identity !== epoch) return;
      mergeJob(result.job); savePending(null);
      return result.job;
    } catch (e) {
      if (closed || identity !== epoch) return;
      if (e.code && !['UNAVAILABLE', 'INTERNAL_ERROR'].includes(e.code)) {
        savePending(null); state.error = e.message;
      } else {
        try { await refresh(); } catch {}
        if (state.pendingStart) state.error = '启动响应中断，正在核对任务是否已创建。请勿重复启动。';
      }
    } finally { if (!closed) state.starting = false; }
  }
  async function control(id, action) {
    if (state.actionId) return;
    state.actionId = id; state.error = '';
    try { const { job } = await client.workflowControl(id, action); mergeJob(job); return job; }
    catch (e) { state.error = e.message; throw e; }
    finally { state.actionId = ''; }
  }
  function dispose() { closed = true; epoch++; refreshId++; scores.dispose(); stream?.close(); clearInterval(timer); changes.clear(); }
  return { state, currentJob, subscribe: changes.subscribe, initialize, refresh, loadCourses, selectCourse, loadScore, watchScore: scores.watch, getJob, setSession, connected, disconnect, start, checkStart, control, mergeJob, dispose };
}
