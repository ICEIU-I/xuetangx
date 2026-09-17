// 共享 HTTPS 请求层。任务可以同时运行，请求启动统一配速。
const https = require('node:https');
const { setTimeout: wait } = require('node:timers/promises');
const { COOKIE } = require('../config');
const HOST = 'www.xuetangx.com';
const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);
const getCsrf = cookie => /csrftoken=([^;]+)/.exec(cookie || COOKIE || '')?.[1] || '';

function responseError(response, label = '请求') {
  const status = response.status;
  const raw = response.json?.msg || response.json?.detail;
  const detail = typeof raw === 'string' ? raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').slice(0, 160).trim() : '';
  if (status === 403) return `${label}被平台拒绝（HTTP 403）${detail ? `：${detail}` : '，请在官网检查登录态及访问权限，或稍后重试'}`;
  if (status === 401) return `${label}失败：登录态失效（HTTP 401），请重新连接`;
  if (status === 429) return `${label}遇到平台限速（HTTP 429），请稍后重试`;
  return `${label}失败（HTTP ${status}）${detail ? `：${detail}` : ''}`;
}
function readOnly(method, endpoint) {
  const pathname = endpoint.split('?')[0];
  if (method === 'POST') return pathname === '/api/v1/lms/learn/chapter/schedule';
  return method === 'GET' && /^\/(?:video-log\/get_video_watch_progress\/|api\/v1\/(?:u\/user\/basic_profile\/|lms\/(?:user\/user-courses\/|learn\/(?:leaf_info\/|course\/(?:chapter|schedule|user-score)(?:\/|$))|exercise\/get_exercise_list\/|service\/playurl\/|forum\/comment\/list\/)))/.test(pathname);
}
function createHttpClient({ requestImpl = https.request, sleep = wait, now = Date.now, minInterval = 750, retryDelays = [1000, 2000], timeout = 12000 } = {}) {
  let nextRequest = 0;
  async function pace(signal) {
    signal?.throwIfAborted();
    const slot = Math.max(now(), nextRequest); nextRequest = slot + minInterval;
    if (slot > now()) await sleep(slot - now(), undefined, { signal });
    signal?.throwIfAborted();
  }
  function attempt(method, endpoint, body, cookie, options, fresh) {
    return new Promise((resolve, reject) => {
      const data = body == null ? null : JSON.stringify(body);
      const headers = { Cookie: cookie || COOKIE || '', Referer: 'https://www.xuetangx.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrf(cookie), 'Content-Length': Buffer.byteLength(data || '') } : {}), ...options.headers };
      let settled = false, secure = false;
      const fail = error => { if (!settled) { settled = true; error.connectionEstablished = secure; reject(error); } };
      const interrupted = () => Object.assign(new Error('连接在响应完成前中断'), { code: 'ECONNRESET' });
      try {
        const req = requestImpl({ hostname: HOST, path: endpoint, method, headers, timeout, signal: options.signal, ...(fresh ? { agent: false } : {}) }, res => {
          secure = true; let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('aborted', () => fail(interrupted()));
          res.on('error', fail);
          res.on('close', () => { if (!settled && res.complete === false) fail(interrupted()); });
          res.on('end', () => {
            if (settled) return;
            settled = true; let json = null; try { json = JSON.parse(raw); } catch {}
            resolve({ status: res.statusCode, json, raw, retryAfter: res.headers['retry-after'] });
          });
        });
        req.on('socket', socket => { secure = !!req.reusedSocket || !!socket.getProtocol?.(); socket.once('secureConnect', () => { secure = true; }); });
        req.on('error', fail);
        req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
        if (data) req.write(data); req.end();
      } catch (error) { fail(error); }
    });
  }
  async function request(method, endpoint, body, cookie, options = {}) {
    for (let index = 0; ; index++) {
      await pace(options.signal);
      try { return await attempt(method, endpoint, body, cookie, options, index > 0); }
      catch (error) {
        if (options.signal?.aborted || error.name === 'AbortError') throw error;
        const safe = error.connectionEstablished === false || readOnly(method, endpoint);
        if (transientCodes.has(error.code) && safe && index < retryDelays.length) {
          options.onRetry?.({ attempt: index + 1, delay: retryDelays[index], code: error.code });
          await sleep(retryDelays[index], undefined, { signal: options.signal }); continue;
        }
        if (!transientCodes.has(error.code)) throw error;
        const phase = error.connectionEstablished ? '网络连接中断' : '连接学堂在线失败（TLS 连接建立前中断）';
        const hint = safe ? '请检查网络或代理后重试。' : '请求可能已被接收，未自动重发；请先回查结果。';
        const failure = new Error(`${phase}${index ? `，已重试 ${index} 次` : ''}（${error.code}）。${hint}`, { cause: error });
        failure.code = error.code; failure.connectionEstablished = error.connectionEstablished; failure.attempts = index + 1;
        throw failure;
      }
    }
  }
  const get = (endpoint, cookie, options) => request('GET', endpoint, null, cookie, options);
  const post = (endpoint, body, cookie, options) => request('POST', endpoint, body, cookie, options);
  async function assertLoggedIn(cookie) {
    const value = cookie || COOKIE;
    if (!value) throw new Error('未配置 COOKIE');
    if (!getCsrf(value)) throw new Error('COOKIE 里缺少 csrftoken');
    const response = await get('/api/v1/u/user/basic_profile/', value);
    if (response.status !== 200 || !response.json?.data) throw new Error(responseError(response, '校验登录态'));
    return response.json.data;
  }
  return { get, post, assertLoggedIn };
}
module.exports = { getCsrf, HOST, responseError, createHttpClient, ...createHttpClient() };
