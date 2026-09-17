const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVideoService, parseVideoUrl } = require('../src/video');

const URL = 'https://www.xuetangx.com/learn/space/course/course/12/video/34?channel=test';
const incomplete = { rate: 0.2, completed: 0, watch_length: 138.6, last_point: 690, video_length: 693 };
const completed = { ...incomplete, rate: 1, completed: 1, watch_length: 694, last_point: 693 };

function fixture({ progress = [incomplete, completed], duration = 0, playDuration = 0, leaf = {}, postResponse = { status: 200, json: {} }, ...options } = {}) {
  const calls = [];
  let progressIndex = 0;
  const service = createVideoService({
    transport: {
      async get(path, cookie, opts) {
        calls.push({ method: 'GET', path, cookie, opts });
        if (path.includes('/service/playurl/')) return { status: 200, json: { success: true, data: { duration: playDuration, sources: { quality10: ['https://ali-cdn.xuetangx.com/example.mp4'] } } } };
        if (path.includes('/leaf_info/')) return { status: 200, json: { success: true, data: {
          id: 34, classroom_id: 12, course_id: 56, sku_id: 78, user_id: 90, leaf_type: 0, name: '测试视频',
          content_info: { media: { ccid: 'cc-test', type: 'video', duration } }, ...leaf,
        } } };
        const record = progress[Math.min(progressIndex++, progress.length - 1)];
        return { status: 200, json: { code: 0, data: record ? { 34: record } : {} } };
      },
      async post(path, body, cookie, opts) { calls.push({ method: 'POST', path, body, cookie, opts }); return typeof postResponse === 'function' ? postResponse() : postResponse; },
    },
    sleep: async () => {}, now: () => 10000, pageId: () => 'test-page', verifyDelays: [0, 0], maxRateLimitRetries: 0, minRequestInterval: 0, ...options,
  });
  return { service, calls };
}

test('rejects unrelated origins, credentials and non-video links before network access', async () => {
  const { service, calls } = fixture();
  for (const url of ['http://www.xuetangx.com/learn/space/a/a/12/video/34', 'https://www.xuetangx.com.evil.test/learn/space/a/a/12/video/34',
    'https://secret@www.xuetangx.com/learn/space/a/a/12/video/34', 'https://www.xuetangx.com/learn/space/a/a/12/video/0',
    'https://www.xuetangx.com/learn/space/a/a/12/exercise/34']) await assert.rejects(service.inspect(url, 'cookie'));
  assert.equal(calls.length, 0);
  assert.deepEqual(parseVideoUrl(URL), { url: URL.split('?')[0], sign: 'course', classroomId: 12, leafId: 34 });
});

test('already completed video makes no heartbeat writes and needs no duration', async () => {
  const { service, calls } = fixture({ progress: [{ ...completed, video_length: 0 }] });
  const result = await service.complete({ url: URL }, 'cookie');
  assert.equal(result.alreadyCompleted, true);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});

test('uses account metadata, covers gaps, batches <=50 and verifies the server state', async () => {
  const { service, calls } = fixture();
  const stages = [];
  const result = await service.complete({ url: URL, durationSeconds: 999 }, 'test-cookie', { onProgress: p => stages.push(p) });
  assert.match(calls[0].path, /leaf_info\/12\/34\/\?sign=course$/);
  const writes = calls.filter(c => c.method === 'POST');
  assert.equal(writes.length, 3);
  assert.ok(writes.every(c => c.body.heart_data.length <= 50 && c.cookie === 'test-cookie' && c.opts.headers.xtbz === 'xt'));
  const events = writes.flatMap(c => c.body.heart_data);
  assert.equal(events[0].cp, 0); // last_point=690 did not conceal earlier gaps.
  assert.equal(events.at(-1).et, 'videoend');
  assert.equal(events.at(-1).cp, 693); // Server duration wins over user input.
  assert.ok(events.every((e, i) => e.sq === i + 1 && e.u === 90 && e.c === 56 && e.v === 34 && e.skuid === 78 && e.classroomid === '12'));
  assert.ok(events.every((e, i) => !i || Number(e.ts) > Number(events[i - 1].ts)));
  assert.equal(stages.at(-1).stage, 'verifying');
  assert.equal(stages.at(-1).sent, events.length);
  assert.equal(stages.at(-1).total, events.length);
  assert.equal(result.progress.completed, true);
  assert.equal(calls.at(-1).method, 'GET');
});

test('HTTP 200 with empty heartbeat responses never implies completion', async () => {
  const { service, calls } = fixture({ progress: [incomplete] });
  await assert.rejects(service.complete({ url: URL }, 'cookie'), /后端尚未确认完成/);
  assert.equal(calls.filter(c => c.path.includes('get_video_watch_progress')).length, 3);
});

test('polls through backend delay without replaying writes', async () => {
  const { service, calls } = fixture({ progress: [incomplete, incomplete, completed] });
  assert.equal((await service.complete({ url: URL }, 'cookie')).progress.completed, true);
  assert.equal(calls.filter(c => c.method === 'POST').length, 3);
});

test('missing duration requires input, then supports a new unwatched video', async () => {
  const { service, calls } = fixture({ progress: [null] });
  await assert.rejects(service.complete({ url: URL }, 'cookie'), /总时长/);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  const fallback = fixture({ progress: [null, completed] });
  const result = await fallback.service.complete({ url: URL, durationSeconds: 12.5 }, 'cookie');
  assert.equal(result.durationSeconds, 13);
  assert.equal(fallback.calls.find(c => c.method === 'POST').body.heart_data.at(-1).cp, 13);
});

test('unwatched video automatically obtains duration and CDN from playback metadata', async () => {
  const { service, calls } = fixture({ progress: [null, completed], playDuration: 543 });
  const result = await service.complete({ url: URL }, 'cookie');
  assert.equal(result.durationSeconds, 543);
  const first = calls.find(c => c.method === 'POST').body.heart_data[0];
  assert.equal(first.d, 543);
  assert.equal(first.n, 'ali-cdn.xuetangx.com');
});

test('metadata mismatch, locked units and unsupported media cannot be submitted', async () => {
  for (const leaf of [{ classroom_id: 99 }, { id: 99 }, { is_locked: true }, { leaf_type: 6 }, { user_id: null }, { sku_id: 0 }]) {
    const { service, calls } = fixture({ leaf });
    await assert.rejects(service.complete({ url: URL }, 'cookie'));
    assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  }
});

test('a rejected or rate-limited POST fails immediately without blind retries', async () => {
  for (const postResponse of [{ status: 429, json: {} }, { status: 403, json: {} }, { status: 200, json: { code: 7001 } }]) {
    const { service, calls } = fixture({ postResponse });
    await assert.rejects(service.complete({ url: URL }, 'cookie'));
    assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  }
});

test('stop aborts before sending another batch', async () => {
  const controller = new AbortController();
  const { service, calls } = fixture({ sleep: async () => controller.abort() });
  await assert.rejects(service.complete({ url: URL }, 'cookie', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('429 waits for Retry-After then retries the rejected batch without advancing its sequence', async () => {
  let attempts = 0, clock = 10000;
  const waits = [], stages = [];
  const { service, calls } = fixture({ maxRateLimitRetries: 2, now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; },
    postResponse: () => ++attempts === 1 ? { status: 429, retryAfter: '2', json: {} } : { status: 200, json: {} } });
  const result = await service.complete({ url: URL }, 'cookie', { onProgress: state => stages.push(state) });
  const writes = calls.filter(call => call.method === 'POST');
  assert.equal(result.progress.completed, true);
  assert.equal(writes.length, 4);
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(waits[0], 3000);
  assert.ok(stages.some(state => state.stage === 'waiting'));
});

test('concurrent requests share a rate-limit cooldown', async () => {
  let attempts = 0, clock = 10000, signalWait;
  const enteredWait = new Promise(resolve => { signalWait = resolve; });
  const sleepers = [];
  const { service, calls } = fixture({ maxRateLimitRetries: 2, now: () => clock,
    sleep: ms => ms >= 1000 ? new Promise(resolve => { sleepers.push(resolve); signalWait(); }) : Promise.resolve(),
    postResponse: () => ++attempts === 1 ? { status: 429, retryAfter: '2', json: {} } : { status: 200, json: {} } });
  const first = service.complete({ url: URL }, 'cookie');
  await enteredWait;
  const count = calls.length;
  const second = service.inspect(URL, 'cookie');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, count);
  assert.equal(sleepers.length, 2);
  clock += 3000;
  sleepers.forEach(resolve => resolve());
  await Promise.all([first, second]);
});

test('stopping during a rate-limit wait prevents the rejected batch from being retried', async () => {
  const controller = new AbortController();
  const { service, calls } = fixture({ maxRateLimitRetries: 3, postResponse: { status: 429, json: {} }, sleep: async () => controller.abort() });
  await assert.rejects(service.complete({ url: URL }, 'cookie', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});
