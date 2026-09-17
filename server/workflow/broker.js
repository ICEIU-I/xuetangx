const { EventEmitter } = require('node:events');
const http = require('../../src/http');
const SUBMIT = '/api/v1/lms/exercise/problem_apply/';

function createBroker({ accounts, quota, transport = http.createHttpClient({ minInterval: 0, retryDelays: [] }), interval = 750, now = Date.now } = {}) {
  const bus = new EventEmitter(), queue = [], active = new Map();
  let timer, pumping = false, nextAt = 0, submitStreak = 0, closed = false;
  const abortError = () => Object.assign(new Error('请求已取消'), { name: 'AbortError' });
  function schedule(ms = 0) { if (closed) return; clearTimeout(timer); timer = setTimeout(pump, Math.max(0, ms)); }
  async function request(role, userId, method, endpoint, body, { signal, onWait } = {}) {
    if (closed) throw new Error('请求调度器已关闭');
    if (!['GET', 'POST'].includes(method) || !endpoint.startsWith('/') || endpoint.startsWith('//') || /[\r\n]/.test(endpoint)) throw new Error('请求路径无效');
    accounts.get(role, userId); signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { role, userId, method, endpoint, body, signal, onWait, resolve, reject, submission: method === 'POST' && endpoint.split('?')[0] === SUBMIT };
      entry.abort = () => { const index = queue.indexOf(entry); if (index >= 0) { queue.splice(index, 1); reject(abortError()); schedule(); } };
      signal?.addEventListener('abort', entry.abort, { once: true }); queue.push(entry); schedule();
    });
  }
  async function pump() {
    if (closed || pumping) return;
    pumping = true;
    try {
      if (!queue.length) return;
      if (nextAt > now()) { schedule(nextAt - now()); return; }
      const ready = []; let earliest = Infinity;
      for (const entry of [...queue]) {
        try { accounts.get(entry.role, entry.userId); }
        catch (error) { queue.splice(queue.indexOf(entry), 1); entry.signal?.removeEventListener('abort', entry.abort); entry.reject(error); continue; }
        if (entry.submission) {
          if ((active.get(entry.userId) || 0) >= 3) continue;
          const state = await quota.snapshot(entry.userId);
          if (state.readyAt > now()) { earliest = Math.min(earliest, state.readyAt); entry.onWait?.(state); bus.emit('quota', { role: entry.role, ...state }); continue; }
        }
        ready.push(entry);
      }
      const writes = ready.filter(entry => entry.submission), normal = ready.filter(entry => !entry.submission);
      const entry = writes.length && (submitStreak < 2 || !normal.length) ? writes[0] : normal[0] || writes[0];
      if (!entry) { if (Number.isFinite(earliest)) schedule(earliest - now()); return; }
      if (entry.signal?.aborted || !queue.includes(entry)) { schedule(); return; }
      if (entry.submission && !await quota.reserve(entry.userId)) { schedule(); return; }
      if (entry.signal?.aborted || !queue.includes(entry)) { schedule(); return; }
      // Durable reservation is immediately followed by the actual outbound attempt.
      queue.splice(queue.indexOf(entry), 1); entry.signal?.removeEventListener('abort', entry.abort);
      nextAt = now() + interval;
      if (entry.submission) { submitStreak++; active.set(entry.userId, (active.get(entry.userId) || 0) + 1); }
      else submitStreak = 0;
      execute(entry).catch(() => {});
      if (queue.length) schedule(nextAt - now());
    } catch (error) {
      // Storage errors must fail closed; never emit unhandled rejections or send unmetered requests.
      for (const entry of queue.splice(0)) { entry.signal?.removeEventListener('abort', entry.abort); entry.reject(error); }
    } finally { pumping = false; }
  }
  async function execute(entry) {
    try {
      const account = accounts.get(entry.role, entry.userId);
      const options = { signal: entry.signal, headers: { xtbz: 'xt', 'X-Requested-With': 'XMLHttpRequest' } };
      const response = await (entry.method === 'GET' ? transport.get(entry.endpoint, account.cookie, options) : transport.post(entry.endpoint, entry.body, account.cookie, options));
      if (entry.submission && response.status === 429) {
        const raw = response.retryAfter, seconds = Number(/(\d+(?:\.\d+)?)\s*seconds?/.exec(response.json?.detail || response.json?.msg || '')?.[1]);
        const until = raw != null && Number.isFinite(Number(raw)) ? now() + Number(raw) * 1000 + 1000
          : raw && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) + 1000 : now() + (Number.isFinite(seconds) ? seconds * 1000 + 1000 : 61000);
        await quota.coolDown(entry.userId, until);
      }
      if (response.status === 401) accounts.invalidate(entry.role, entry.userId);
      entry.resolve(response);
    } catch (error) { entry.reject(error); }
    finally {
      if (entry.submission) { active.set(entry.userId, (active.get(entry.userId) || 1) - 1); try { bus.emit('quota', { role: entry.role, ...await quota.snapshot(entry.userId) }); } catch {} }
      schedule(Math.max(0, nextAt - now()));
    }
  }
  function close() { closed = true; clearTimeout(timer); for (const entry of queue.splice(0)) { entry.signal?.removeEventListener('abort', entry.abort); entry.reject(abortError()); } }
  return { request, close, onQuota(fn) { bus.on('quota', fn); return () => bus.off('quota', fn); } };
}
module.exports = { createBroker, SUBMIT };
