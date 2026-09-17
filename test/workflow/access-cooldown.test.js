const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAccounts } = require('../../server/workflow/accounts');
const { createServerLimits } = require('../../server/workflow/server-limits');
const { createBroker, SUBMIT } = require('../../server/workflow/broker');
const { createRequestClient } = require('../../server/workflow/request-client');
async function setup(t, transport) {
  const accounts = createAccounts({ authenticate: async cookie => ({ user_id: Number(cookie) }) });
  await accounts.connect('primary', '1'); await accounts.connect('test', '2');
  const serverLimits = createServerLimits();
  const broker = createBroker({ accounts, serverLimits, transport }); t.after(() => broker.close());
  return { broker, serverLimits, call: createRequestClient({ broker }) };
}
const primary = { role: 'primary', userId: 1 };
test('403 waits for the server deadline and then retries the identical request successfully', async t => {
  const attempts = [], waits = [];
  const { call } = await setup(t, { post: async (endpoint, body) => {
    attempts.push({ endpoint, body, at: Date.now() });
    return attempts.length === 1 ? { status: 403, retryAfter: '0.03' } : { status: 200, json: { success: true } };
  } });
  assert.equal((await call(primary, 'POST', SUBMIT, { problem_id: 101 }, { onWait: state => waits.push(state) })).status, 200);
  assert.equal(attempts.length, 2); assert.ok(attempts[1].at - attempts[0].at >= 30);
  assert.deepEqual(attempts[0].body, attempts[1].body); assert.ok(waits.some(state => state.reason === 'access_denied'));
});
test('403 cools down every request for that account, while the other account continues', async t => {
  const sent = [];
  const { broker } = await setup(t, { get: async (endpoint, cookie) => {
    sent.push({ endpoint, cookie }); return endpoint === '/blocked' ? { status: 403, retryAfter: '120' } : { status: 200 };
  }, post: async endpoint => { sent.push({ endpoint }); return { status: 200 }; } });
  await broker.request('primary', 1, 'GET', '/blocked');
  const controller = new AbortController();
  const waiting = [broker.request('primary', 1, 'GET', '/read', null, { signal: controller.signal }), broker.request('primary', 1, 'POST', SUBMIT, {}, { signal: controller.signal })];
  const rejected = waiting.map(p => assert.rejects(p, { name: 'AbortError' }));
  await broker.request('test', 2, 'GET', '/other');
  assert.deepEqual(sent.map(x => x.endpoint), ['/blocked', '/other']);
  controller.abort(); await Promise.all(rejected);
});
test('persistent 403 stops only after two cooldown retries and cancellation prevents another request', async t => {
  let calls = 0;
  const { call } = await setup(t, { get: async () => { calls++; return { status: 403, retryAfter: '0.01' }; } });
  await assert.rejects(call(primary, 'GET', '/read'), /已冷却重试 2 次/); assert.equal(calls, 3);
  const controller = new AbortController();
  await assert.rejects(call(primary, 'GET', '/read', null, { signal: controller.signal, onWait: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(calls, 3);
});
test('403 defaults to sixty seconds, respects server hints, and cannot be shortened by 429', () => {
  let clock = 1000;
  const limits = createServerLimits({ now: () => clock });
  assert.equal(limits.observe(1, { status: 403 }).accessReadyAt, 61000);
  assert.equal(limits.observe(1, { status: 429, retryAfter: '1' }).accessReadyAt, 61000);
  assert.equal(limits.observe(2, { status: 403, json: { msg: 'Wait 5 seconds' } }).readyAt, 6000);
  clock = 61000; assert.equal(limits.snapshot(1).blocked, false);
});
