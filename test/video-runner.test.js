const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVideoRunner } = require('../server/video-runner');
const url = 'https://www.xuetangx.com/learn/space/a/a/12/video/34';
const sessions = { isConnected: () => true, getCookie: () => 'private-cookie' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('startup errors are synchronous and concurrent video runs are rejected', async () => {
  const disconnected = createVideoRunner({ sessions: { isConnected: () => false } });
  assert.throws(() => disconnected.start({ url }), /未连接/);
  let finish;
  const runner = createVideoRunner({ sessions, service: { complete: () => new Promise(resolve => { finish = resolve; }) } });
  assert.throws(() => runner.start({ url, durationSeconds: -1 }), /时长/);
  assert.equal(runner.start({ url }).status, 'running');
  assert.throws(() => runner.start({ url }), /已有/);
  await tick();
  finish({ alreadyCompleted: true });
  await runner.waitForIdle();
  assert.equal(runner.getState().status, 'done');
  assert.doesNotMatch(JSON.stringify(runner.getState()), /private-cookie/);
});

test('stop propagates cancellation and never reports success', async () => {
  const runner = createVideoRunner({ sessions, service: { complete: async (input, cookie, { signal }) => {
    assert.equal(cookie, 'private-cookie');
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } } });
  const events = [];
  const off = runner.onEvent(event => events.push(event));
  runner.start({ url });
  await tick();
  runner.stop();
  await runner.waitForIdle();
  assert.equal(runner.getState().status, 'stopped');
  assert.ok(!events.some(event => event.status === 'done'));
  off();
});

test('account reset discards late results and prevents reuse until old work settles', async () => {
  let finish;
  const runner = createVideoRunner({ sessions, service: { complete: () => new Promise(resolve => { finish = resolve; }) } });
  runner.start({ url }); await tick();
  runner.reset();
  assert.equal(runner.getState().status, 'idle');
  assert.throws(() => runner.start({ url }), /已有/);
  finish({ alreadyCompleted: true, privateResult: 'old-account' });
  await runner.waitForIdle();
  assert.equal(runner.getState().result, null);
});

test('backend verification failure becomes an error event', async () => {
  const runner = createVideoRunner({ sessions, service: { complete: async () => { throw new Error('后端尚未确认完成'); } } });
  runner.start({ url });
  await runner.waitForIdle();
  assert.equal(runner.getState().status, 'error');
  assert.match(runner.getState().message, /后端尚未确认/);
});

test('course mode requires an explicit selection and reports partial results', async () => {
  let calls = 0;
  const runner = createVideoRunner({ sessions, service: { completeCourse: async input => {
    assert.equal(input.courseUrl, url);
    calls++; return { kind: 'batch', completedVideos: 2, skippedVideos: 1, failedVideos: 1 };
  } } });
  assert.throws(() => runner.start({ all: true }), /选择一门课程/);
  runner.start({ courseUrl: url });
  await runner.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(runner.getState().mode, 'course');
  assert.equal(runner.getState().status, 'partial');
});
