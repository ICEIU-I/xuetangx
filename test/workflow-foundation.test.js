const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createStorage } = require('../server/workflow/storage');
const { createAccounts } = require('../server/workflow/accounts');
const { createQuota } = require('../server/workflow/quota');
const { createBroker, SUBMIT } = require('../server/workflow/broker');

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-foundation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
test('20 durable reservations per first-submission cycle, independent users, restart and cooldown', async t => {
  const root = await directory(t), storage = createStorage(root); let clock = 1000;
  const quota = createQuota({ storage, now: () => clock });
  const accepted = await Promise.all(Array.from({ length: 25 }, () => quota.reserve(1)));
  assert.equal(accepted.filter(Boolean).length, 20);
  assert.equal((await quota.snapshot(1)).readyAt, 62000);
  assert.equal(await quota.reserve(2), true);
  const restarted = createQuota({ storage: createStorage(root), now: () => clock });
  assert.equal((await restarted.snapshot(1)).remaining, 0);
  clock = 61999; assert.equal(await restarted.reserve(1), false);
  clock = 62000; assert.equal(await restarted.reserve(1), true);
  assert.equal((await restarted.snapshot(1)).used, 1);
  await restarted.coolDown(1, 150000);
  clock = 140000; assert.equal(await restarted.reserve(1), false);
  clock = 150000; assert.equal(await restarted.reserve(1), true);
});
test('corrupted quota fails closed rather than resetting it', async t => {
  const storage = createStorage(await directory(t)); await storage.save('1', { userId: 1, used: -1 });
  await assert.rejects(createQuota({ storage }).reserve(1), /额度记录损坏/);
});
test('roles are isolated, same-user roles rejected and summaries never contain cookies', async () => {
  const accounts = createAccounts({ authenticate: async cookie => ({ user_id: cookie === 'primary-secret' ? 1 : 2 }) });
  await accounts.connect('primary', 'primary-secret');
  await assert.rejects(accounts.connect('test', 'primary-secret'), /两个不同/);
  await accounts.connect('test', 'test-secret');
  assert.equal(accounts.get('primary').cookie, 'primary-secret');
  assert.equal(accounts.get('test').cookie, 'test-secret');
  assert.doesNotMatch(JSON.stringify([accounts.summary('primary'), accounts.summary('test')]), /secret/);
  accounts.clear('test'); assert.equal(accounts.summary('primary').connected, true);
});
test('broker keeps exhausted users waiting while another account and ordinary requests proceed', async t => {
  const accounts = createAccounts({ authenticate: async cookie => ({ user_id: Number(cookie) }) });
  await accounts.connect('primary', '1'); await accounts.connect('test', '2');
  const quota = createQuota({ storage: createStorage(await directory(t)), limit: 2 });
  await quota.reserve(1); await quota.reserve(1);
  const sent = []; const broker = createBroker({ accounts, quota, interval: 0, transport: {
    get: async (url, cookie) => { sent.push({ url, cookie }); return { status: 200 }; },
    post: async (url, body, cookie) => { sent.push({ url, cookie }); return { status: 200 }; },
  } }); t.after(() => broker.close());
  const controller = new AbortController();
  const blocked = broker.request('primary', 1, 'POST', SUBMIT, {}, { signal: controller.signal });
  const rejected = assert.rejects(blocked, { name: 'AbortError' });
  await Promise.all([broker.request('test', 2, 'POST', SUBMIT, {}), broker.request('primary', 1, 'GET', '/read')]);
  assert.equal(sent.length, 2); assert.equal(sent.find(item => item.url === SUBMIT).cookie, '2');
  controller.abort(); await rejected;
});
test('failed requests retain budget; 429 cooldown is shared across the account', async t => {
  const accounts = createAccounts({ authenticate: async () => ({ user_id: 1 }) }); await accounts.connect('primary', 'secret');
  const quota = createQuota({ storage: createStorage(await directory(t)) });
  const broker = createBroker({ accounts, quota, interval: 0, transport: { post: async () => ({ status: 429, retryAfter: '120', json: {} }) } });
  t.after(() => broker.close());
  await broker.request('primary', 1, 'POST', SUBMIT, {});
  const state = await quota.snapshot(1); assert.equal(state.used, 1); assert.ok(state.readyAt > Date.now() + 119000);
});
test('broker limits actual in-flight submissions to three and yields ordinary work after two', async t => {
  const accounts = createAccounts({ authenticate: async () => ({ user_id: 1 }) }); await accounts.connect('primary', 'secret');
  const quota = createQuota({ storage: createStorage(await directory(t)) });
  const releases = [], starts = []; let active = 0, peak = 0;
  const broker = createBroker({ accounts, quota, interval: 0, transport: {
    post: async () => { starts.push('submit'); active++; peak = Math.max(peak, active); await new Promise(resolve => releases.push(resolve)); active--; return { status: 200 }; },
    get: async () => { starts.push('read'); return { status: 200 }; },
  } }); t.after(() => broker.close());
  const promises = Array.from({ length: 5 }, () => broker.request('primary', 1, 'POST', SUBMIT, {}));
  const read = broker.request('primary', 1, 'GET', '/read'); await read;
  assert.deepEqual(starts.slice(0, 3), ['submit', 'submit', 'read']);
  const interval = setInterval(() => releases.splice(0).forEach(resolve => resolve()), 5);
  try { await Promise.all(promises); } finally { clearInterval(interval); }
  assert.ok(peak <= 3);
});
