const { EventEmitter } = require('node:events');
const http = require('../../src/http');

function createAccounts({ authenticate = cookie => http.assertLoggedIn(cookie) } = {}) {
  const bus = new EventEmitter();
  const state = { primary: null, test: null }, revisions = { primary: 0, test: 0 };
  const roleCheck = role => { if (!['primary', 'test'].includes(role)) throw new Error('账号角色无效'); };
  async function connect(role, cookie) {
    roleCheck(role);
    if (typeof cookie !== 'string' || !cookie.trim()) throw new Error('请填写 Cookie');
    const revision = ++revisions[role], user = await authenticate(cookie.trim());
    const userId = Number(user.user_id || user.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('未能验证账号身份');
    if (revision !== revisions[role]) throw new Error('登录验证已被更新的请求替代');
    const other = role === 'primary' ? 'test' : 'primary';
    if (state[other]?.userId === userId) throw new Error('正式账号与测试账号必须是两个不同的用户');
    const previous = state[role];
    state[role] = { role, userId, user, cookie: cookie.trim(), connectedAt: Date.now(), revision, valid: true };
    bus.emit('change', { role, userId, previousUserId: previous?.userId, connected: true });
    return summary(role);
  }
  function get(role, expectedUserId) {
    roleCheck(role); const account = state[role];
    if (!account || !account.valid || (expectedUserId && account.userId !== expectedUserId)) {
      const error = new Error(role === 'test' ? '请提供可用的测试账号' : '请重新连接正式账号'); error.code = 'ACCOUNT_REQUIRED'; error.role = role; throw error;
    }
    return account;
  }
  function summary(role) {
    roleCheck(role); const account = state[role];
    return { connected: !!account?.valid, role, userId: account?.userId || null, user: account?.user || null, connectedAt: account?.connectedAt || 0 };
  }
  function clear(role) {
    roleCheck(role); const previousUserId = state[role]?.userId; revisions[role]++; state[role] = null;
    bus.emit('change', { role, previousUserId, connected: false });
  }
  function invalidate(role, userId) {
    if (state[role]?.userId === userId) { state[role].valid = false; bus.emit('change', { role, userId, connected: false }); }
  }
  return { connect, get, summary, clear, invalidate, onChange(fn) { bus.on('change', fn); return () => bus.off('change', fn); } };
}
module.exports = { createAccounts };
