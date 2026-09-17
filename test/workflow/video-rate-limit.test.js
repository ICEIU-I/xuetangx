const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: wait } = require('node:timers/promises');
const { createAccounts } = require('../../server/workflow/accounts');
const { createBroker, SUBMIT } = require('../../server/workflow/broker');
const { createRequestClient } = require('../../server/workflow/request-client');
const { createServerLimits } = require('../../server/workflow/server-limits');
const { createRuntime } = require('../../server/workflow/runtime');
const account = { role: 'primary', userId: 1 };
const heartbeat = '/video-log/heartbeat/';
const success = data => ({ status: 200, json: { success: true, data } });
async function setup(t, transport) {
  const accounts = createAccounts({ authenticate: async cookie => ({ user_id: Number(cookie) }) });
  await accounts.connect('primary', '1'); await accounts.connect('test', '2');
  const limits = createServerLimits();
  const broker = createBroker({ accounts, serverLimits: limits, transport });
  t.after(() => broker.close());
  return { broker, limits, call: createRequestClient({ broker }) };
}

test('video 429 shares its cooldown with every same-account request, without blocking another account', async t => {
  const sent = [];
  const { broker, limits } = await setup(t, {
    post: async (endpoint, body, cookie) => { sent.push({ endpoint, cookie }); return { status: 429, retryAfter: '120' }; },
    get: async (endpoint, cookie) => { sent.push({ endpoint, cookie }); return success({}); },
  });
  await broker.request('primary', 1, 'POST', heartbeat, {});
  assert.ok(limits.snapshot(1).requestReadyAt > Date.now());
  const controller = new AbortController(), options = { signal: controller.signal };
  const pending = [broker.request('primary', 1, 'GET', '/video-log/get_video_watch_progress/', null, options),
    broker.request('primary', 1, 'POST', heartbeat, {}, options), broker.request('primary', 1, 'POST', SUBMIT, {}, options)];
  const stopped = pending.map(promise => assert.rejects(promise, { name: 'AbortError' }));
  await broker.request('test', 2, 'GET', '/read');
  assert.equal(sent.length, 2); controller.abort(); await Promise.all(stopped);
});

test('video progress queries retry HTTP 429 and explicit throttle responses after the server delay', async t => {
  for (const status of [429, 200]) {
    const times = [], waits = [];
    const { call } = await setup(t, { get: async () => {
      times.push(Date.now()); return times.length === 1 ? { status, retryAfter: '0.03', json: { success: false, detail: 'Request was throttled.' } } : success({ completed: true });
    } });
    const response = await call(account, 'GET', '/video-log/get_video_watch_progress/', null, { onWait: state => waits.push(state) });
    assert.equal(response.status, 200); assert.equal(times.length, 2); assert.ok(times[1] - times[0] >= 30);
    assert.ok(waits.some(state => state.reason === 'rate_limited'));
  }
});

test('video throttling has a bounded retry budget and stopping during cooldown prevents replay', async t => {
  let posts = 0;
  const { call } = await setup(t, { post: async () => { posts++; return { status: 429, retryAfter: '0.01' }; } });
  await assert.rejects(call(account, 'POST', heartbeat, {}), error => error.code === 'RATE_LIMITED' && /已冷却重试 3 次/.test(error.message));
  assert.equal(posts, 4);
  const controller = new AbortController();
  await assert.rejects(call(account, 'POST', heartbeat, {}, { signal: controller.signal, onWait: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(posts, 4);
});

test('question 429 retry remains owned by submission journal without multiplying retry attempts', async t => {
  let posts = 0;
  const { call } = await setup(t, { post: async () => { posts++; return { status: 429, retryAfter: '0.01' }; } });
  assert.equal((await call(account, 'POST', SUBMIT, {})).status, 429); assert.equal(posts, 1);
});

test('uncertain video network failures are not replayed as explicit rejections', async t => {
  let posts = 0;
  const { call } = await setup(t, { post: async () => { posts++; throw Object.assign(Error('connection lost'), { code: 'ECONNRESET', connectionEstablished: true }); } });
  await assert.rejects(call(account, 'POST', heartbeat, {}), { code: 'ECONNRESET' }); assert.equal(posts, 1);
});

test('real video worker retries only the rejected heartbeat batch and confirms completion', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'video-429-'));
  const accounts = createAccounts({ authenticate: async () => ({ user_id: 1 }) }); await accounts.connect('primary', '1');
  const batches = [], starts = [], states = []; let completed = false;
  const transport = {
    async get(endpoint) {
      if (endpoint.includes('/user-courses/')) return success({ pages: 1, product_list: [{ classroom_id: 12, sign: 's', course_sign: 's', name: 'Video course' }] });
      if (endpoint.includes('/course/chapter')) return success({ course_chapter: [{ id: 31, leaf_type: 0, name: 'Test video' }] });
      if (endpoint.includes('/course/schedule')) return success({ leaf_schedules: { 31: 0 } });
      if (endpoint.includes('/leaf_info/')) return success({ id: 31, classroom_id: 12, leaf_type: 0, course_id: 10, user_id: 1, sku_id: 78, content_info: { media: { ccid: 'test', type: 'video', duration: 260 } } });
      if (endpoint.includes('/get_video_watch_progress/')) return success({ 31: { completed: completed ? 1 : 0, video_length: 260 } });
      if (endpoint.includes('/playurl/')) return success({ duration: 260, sources: { quality: ['https://cdn.example.test/video.mp4'] } });
      throw Error('Unexpected GET: ' + endpoint);
    },
    async post(endpoint, body) {
      assert.equal(endpoint, heartbeat); batches.push(structuredClone(body)); starts.push(Date.now());
      if (batches.length === 2) return { status: 429, retryAfter: '0.03' };
      if (body.heart_data.some(event => event.et === 'videoend')) completed = true;
      return success({});
    },
  };
  const runtime = createRuntime({ directory: path.join(directory, 'state'), bankDirectory: path.join(directory, 'bank'), accounts, transport });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  runtime.onEvent(event => { if (event.job) states.push(event.job.modules.video?.status); });
  const job = await runtime.start({ courseUrl: 'https://www.xuetangx.com/learn/space/s/s/12', modules: ['video'] });
  const deadline = Date.now() + 5000; let result;
  do { result = await runtime.get(job.id); if (['done', 'partial'].includes(result.status)) break; assert.ok(Date.now() < deadline); await wait(10); } while (true);
  assert.equal(result.status, 'done', JSON.stringify(result.modules)); assert.equal(result.modules.video.completed, 1);
  assert.equal(batches.length, 3); assert.equal(batches[0].heart_data.length, 50);
  assert.deepEqual(batches[1], batches[2], 'retry must preserve page id, timestamps and sequence of the rejected batch');
  assert.equal(batches[1].heart_data[0].sq, 51); assert.ok(starts[2] - starts[1] >= 30);
  assert.ok(states.includes('waiting_rate_limit')); assert.equal(result.modules.video.failed, 0);
});
