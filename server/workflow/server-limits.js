// 只响应服务端限流信号；不计数、不设置本地提交周期，也不写盘。
function isRateLimited(response) {
  if (response.status === 429) return true;
  const json = response.json;
  if (json?.success !== false) return false;
  return /throttl|too many requests|请求过于频繁|操作过于频繁|限流/i.test(String(json.detail || json.msg || json.code || ''));
}
function createServerLimits({ now = Date.now } = {}) {
  const cooldowns = new Map();
  function observe(userId, response) {
    if (response.status !== 403 && !isRateLimited(response)) return null;
    const time = now(), raw = response.retryAfter;
    const detail = String(response.json?.detail || response.json?.msg || '');
    const match = /(\d+(?:\.\d+)?)\s*(?:seconds?|秒)/i.exec(detail);
    const numericHeader = raw != null && String(raw).trim() !== '' && Number.isFinite(Number(raw));
    const delay = numericHeader ? Math.max(0, Number(raw) * 1000)
      : raw && Number.isFinite(Date.parse(raw)) ? Math.max(0, Date.parse(raw) - time)
      : match ? Number(match[1]) * 1000 : 60000;
    const previous = cooldowns.get(userId) || {};
    const key = response.status === 403 ? 'accessUntil' : 'submitUntil';
    cooldowns.set(userId, { ...previous, [key]: Math.max(previous[key] || 0, time + delay) });
    return snapshot(userId);
  }
  function snapshot(userId) {
    const saved = cooldowns.get(userId) || {}, accessReadyAt = saved.accessUntil > now() ? saved.accessUntil : null;
    const readyAt = Math.max(saved.submitUntil || 0, saved.accessUntil || 0), blocked = readyAt > now();
    if (!blocked) cooldowns.delete(userId);
    return { userId, source: 'server', blocked, readyAt: blocked ? readyAt : null, accessReadyAt,
      reason: blocked ? accessReadyAt ? 'access_denied' : 'rate_limited' : null };
  }
  return { observe, snapshot };
}
module.exports = { createServerLimits, isRateLimited };
