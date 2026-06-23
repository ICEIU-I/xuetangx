// server/session.js - 运行时 cookie 会话管理（内存，不写盘）
const http = require('../src/http');

let state = {
  cookie: '',          // 当前活动 cookie
  user: null,          // 校验后的用户信息
  connectedAt: 0,
};

async function setCookie(cookie) {
  cookie = (cookie || '').trim();
  if (!cookie) throw new Error('cookie 为空');
  const user = await http.assertLoggedIn(cookie); // 校验登录态
  state = { cookie, user, connectedAt: Date.now() };
  return user;
}

function clear() { state = { cookie: '', user: null, connectedAt: 0 }; }

function getCookie() { return state.cookie; }
function getUser() { return state.user; }
function isConnected() { return !!state.cookie && !!state.user; }
function summary() {
  return { connected: isConnected(), user: state.user, connectedAt: state.connectedAt };
}

module.exports = { setCookie, clear, getCookie, getUser, isConnected, summary };
