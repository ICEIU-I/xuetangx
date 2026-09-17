// 所有 problem_apply 共用的持久化额度：首个实际请求起算60秒，每账号20次。
function createQuota({ storage, now = Date.now, limit = 20, period = 60000, guard = 1000 } = {}) {
  const cache = new Map();
  function validate(data, userId) {
    if (!data) return { userId, windowStart: null, used: 0, cooldownUntil: 0 };
    if (data.userId !== userId || !Number.isInteger(data.used) || data.used < 0 || data.used > limit || (data.windowStart != null && !Number.isFinite(data.windowStart)) || !Number.isFinite(data.cooldownUntil)) throw new Error('额度记录损坏，停止提交以防超额');
    return data;
  }
  async function load(userId) {
    if (!cache.has(userId)) cache.set(userId, validate(await storage.read(String(userId)), userId));
    return cache.get(userId);
  }
  function availableAt(data, time = now()) {
    const exhaustedUntil = data.used >= limit && data.windowStart != null ? data.windowStart + period + guard : 0;
    return Math.max(time, exhaustedUntil, data.cooldownUntil);
  }
  async function snapshot(userId) {
    const data = await load(userId), time = now();
    const used = data.windowStart != null && time >= data.windowStart + period + guard ? 0 : data.used;
    return { userId, limit, used, remaining: limit - used, windowStart: data.windowStart, readyAt: availableAt(data), resetsAt: data.windowStart == null ? null : data.windowStart + period + guard };
  }
  async function reserve(userId) {
    let allowed = false;
    const saved = await storage.transact(String(userId), previous => {
      const data = validate(previous, userId), time = now();
      if (availableAt(data, time) > time) return data;
      if (data.windowStart == null || time >= data.windowStart + period + guard) { data.windowStart = time; data.used = 0; }
      data.used++; allowed = true; return data;
    });
    cache.set(userId, saved); return allowed;
  }
  async function coolDown(userId, until) {
    const saved = await storage.transact(String(userId), previous => {
      const data = validate(previous, userId);
      data.cooldownUntil = Math.max(data.cooldownUntil, until, data.windowStart == null ? 0 : data.windowStart + period + guard); return data;
    });
    cache.set(userId, saved);
  }
  return { snapshot, reserve, coolDown };
}
module.exports = { createQuota };
