const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAccounts } = require('../../server/workflow/accounts');
const { createServerLimits, isRateLimited } = require('../../server/workflow/server-limits');
const { createBroker, SUBMIT } = require('../../server/workflow/broker');

async function accounts() {
  const registry = createAccounts({ authenticate: async cookie => ({ user_id: Number(cookie) }) });
  await registry.connect('primary', '1'); await registry.connect('test', '2'); return registry;
}
test('server limits only start after an actual throttling response and use server timing', () => {
  let clock = 1000; const limits = createServerLimits({ now: () => clock });
  for (let i = 0; i < 50; i++) limits.observe(1, { status: 200, json: { success: true } });
  assert.equal(limits.snapshot(1).blocked, false);
  assert.equal(limits.observe(1, { status: 429, retryAfter: '2.5' }).readyAt, 3500);
  assert.equal(limits.snapshot(2).blocked, false);
  clock = 3500; assert.equal(limits.snapshot(1).blocked, false);
  assert.equal(limits.observe(1, { status: 429, retryAfter: new Date(10000).toUTCString() }).readyAt, 10000);
  assert.equal(createServerLimits({ now: () => clock }).snapshot(1).blocked, false, 'restart does not restore local counters or cooldowns');
});
test('server wait hints and fallback are applied only to rate-limit responses', () => {
  const limits = createServerLimits({ now: () => 1000 });
  assert.equal(limits.observe(1, { status: 429, json: { detail: 'Expected available in 4 seconds.' } }).readyAt, 5000);
  assert.equal(limits.observe(2, { status: 429, json: { msg: '请等待2秒' } }).readyAt, 3000);
  assert.equal(limits.observe(3, { status: 429 }).readyAt, 61000);
  assert.equal(limits.observe(4, { status: 403, json: { msg: 'access denied' } }), null);
  assert.equal(isRateLimited({ status: 200, json: { success: false, detail: 'Request was throttled. Expected available in 3 seconds.' } }), true);
});
test('roles are isolated, same-user roles rejected and summaries never contain cookies', async () => {
  const registry = createAccounts({ authenticate: async cookie => ({ user_id: cookie === 'primary-secret' ? 1 : 2 }) });
  await registry.connect('primary', 'primary-secret');
  await assert.rejects(registry.connect('test', 'primary-secret'), /两个不同/);
  await registry.connect('test', 'test-secret');
  assert.equal(registry.get('primary').cookie, 'primary-secret');
  assert.equal(registry.get('test').cookie, 'test-secret');
  assert.doesNotMatch(JSON.stringify([registry.summary('primary'), registry.summary('test')]), /secret/);
  registry.clear('test'); assert.equal(registry.summary('primary').connected, true);
});
test('more than twenty submissions proceed immediately with a frozen clock and default settings', async t => {
  let sent = 0;
  const broker = createBroker({ accounts: await accounts(), now: () => 1000, transport: { post: async () => { sent++; return { status: 200 }; } } });
  t.after(() => broker.close());
  await Promise.all(Array.from({ length: 25 }, () => broker.request('primary', 1, 'POST', SUBMIT, {})));
  assert.equal(sent, 25);
});
test('actual server cooldown blocks only that account while other accounts and reads proceed', async t => {
  const serverLimits = createServerLimits(), sent = [];
  const broker = createBroker({ accounts: await accounts(), serverLimits, transport: {
    get: async (url, cookie) => { sent.push({ url, cookie }); return { status: 200 }; },
    post: async (url, body, cookie) => { sent.push({ url, cookie }); return { status: cookie === '1' ? 429 : 200, retryAfter: '120' }; },
  } }); t.after(() => broker.close());
  await broker.request('primary', 1, 'POST', SUBMIT, {});
  const controller = new AbortController();
  const blocked = broker.request('primary', 1, 'POST', SUBMIT, {}, { signal: controller.signal });
  const rejected = assert.rejects(blocked, { name: 'AbortError' });
  await Promise.all([broker.request('test', 2, 'POST', SUBMIT, {}), broker.request('primary', 1, 'GET', '/read')]);
  assert.equal(sent.filter(item => item.url === SUBMIT && item.cookie === '1').length, 1);
  assert.equal(sent.length, 3); controller.abort(); await rejected;
});
test('queued submissions resume after the server-requested wait', async t => {
  const serverLimits = createServerLimits(); let sent = 0, started;
  const broker = createBroker({ accounts: await accounts(), serverLimits, transport: { post: async () => {
    sent++; if (sent === 1) { started = Date.now(); return { status: 429, retryAfter: '0.03' }; } return { status: 200 };
  } } }); t.after(() => broker.close());
  await broker.request('primary', 1, 'POST', SUBMIT, {});
  await broker.request('primary', 1, 'POST', SUBMIT, {});
  assert.equal(sent, 2); assert.ok(Date.now() - started >= 30); assert.equal(serverLimits.snapshot(1).blocked, false);
});
test('broker keeps three in-flight submissions and fairly schedules ordinary requests', async t => {
  const releases = [], starts = []; let active = 0, peak = 0;
  const broker = createBroker({ accounts: await accounts(), transport: {
    post: async () => { starts.push('submit'); active++; peak = Math.max(peak, active); await new Promise(resolve => releases.push(resolve)); active--; return { status: 200 }; },
    get: async () => { starts.push('read'); return { status: 200 }; },
  } }); t.after(() => broker.close());
  const promises = Array.from({ length: 5 }, () => broker.request('primary', 1, 'POST', SUBMIT, {}));
  await broker.request('primary', 1, 'GET', '/read');
  assert.deepEqual(starts.slice(0, 3), ['submit', 'submit', 'read']);
  const interval = setInterval(() => releases.splice(0).forEach(resolve => resolve()), 5);
  try { await Promise.all(promises); } finally { clearInterval(interval); }
  assert.ok(peak <= 3);
});
