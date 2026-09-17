const { setTimeout: sleep } = require('node:timers/promises');
const completeValue = value => value === true || value === 1 || value === '1';
function failure(message, code) { return Object.assign(new Error(message), { code }); }
function requireId(value) { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw failure('课程参数不完整', 'INVALID_METADATA'); return id; }
function createClient({ rpc, signal, verificationDelays = [0, 1000, 2000] }) {
  async function request(method, endpoint, body) {
    signal.throwIfAborted();
    const response = await rpc('request', { method, endpoint, body });
    const json = response.json;
    if (response.status !== 200 || !json || json.success === false || (json.code != null && ![0, '0'].includes(json.code))) {
      throw failure(`接口未成功（HTTP ${response.status}）${json?.msg ? '：' + String(json.msg).slice(0, 100) : ''}`, response.status === 401 ? 'ACCOUNT_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : response.status === 429 ? 'RATE_LIMITED' : 'REMOTE_ERROR');
    }
    return json.data ?? json;
  }
  async function leaf(course, unit) {
    const data = await request('GET', `/api/v1/lms/learn/leaf_info/${course.classroomId}/${unit.id}/?sign=${encodeURIComponent(course.sign)}`);
    if (Number(data.id) !== unit.id || Number(data.classroom_id) !== course.classroomId || Number(data.leaf_type) !== unit.leafType) throw failure('学习单元与任务不匹配', 'INVALID_METADATA');
    if (data.is_deleted || data.is_locked || data.locked_reason || data.upgrade_sku_id) throw failure('学习单元不可访问或未开放', 'LOCKED');
    return data;
  }
  async function verify(check) {
    for (const delay of verificationDelays) {
      signal.throwIfAborted(); if (delay) await sleep(delay, undefined, { signal });
      if (await check()) return true;
    }
    return false;
  }
  return { request, leaf, verify };
}
module.exports = { createClient, completeValue, failure, requireId };
