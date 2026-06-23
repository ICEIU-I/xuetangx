// src/http.js - 纯 HTTPS 请求层（带 cookie，脱离浏览器）。
// cookie 可运行时传入（前端多账号），不传则回退 config.COOKIE（CLI 默认）。
const https = require('https');
const { COOKIE } = require('../config');

const HOST = 'www.xuetangx.com';

// 从 cookie 串里取 csrftoken
function getCsrf(cookie) {
  const m = /csrftoken=([^;]+)/.exec(cookie || COOKIE || '');
  return m ? m[1] : '';
}

function baseHeaders(cookie, extra = {}) {
  return {
    'Cookie': cookie || COOKIE || '',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Referer': 'https://www.xuetangx.com/',
    ...extra,
  };
}

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = baseHeaders(cookie, method === 'POST'
      ? { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrf(cookie), 'Content-Length': Buffer.byteLength(data) }
      : {});
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const req = https.request({ hostname: HOST, path, method, headers, timeout: 12000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(d); } catch {}
        finish(resolve, { status: res.statusCode, json, raw: d });
      });
    });
    req.on('timeout', () => { req.destroy(); finish(reject, new Error('请求超时')); });
    req.on('error', (e) => finish(reject, e));
    if (data) req.write(data);
    req.end();
  });
}

const get = (path, cookie) => request('GET', path, null, cookie);
const post = (path, body, cookie) => request('POST', path, body, cookie);

// 校验 cookie 是否已配置且有效（登录态）。返回用户信息 data。
async function assertLoggedIn(cookie) {
  const ck = cookie || COOKIE;
  if (!ck) throw new Error('未配置 COOKIE');
  if (!getCsrf(ck)) throw new Error('COOKIE 里缺少 csrftoken');
  const r = await get('/api/v1/u/user/basic_profile/', ck);
  if (r.status !== 200 || !r.json || !r.json.data) throw new Error(`cookie 无效或已过期 (status ${r.status})`);
  return r.json.data;
}

module.exports = { get, post, getCsrf, assertLoggedIn, HOST };
