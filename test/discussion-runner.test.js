const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDiscussionRunner } = require('../server/discussion-runner');
const courseUrl = 'https://www.xuetangx.com/learn/space/s/c/12/discussion/34';
const sessions = { isConnected: () => true, getCookie: () => 'private-cookie' };

test('discussion runner validates input and preserves partial results', async () => {
  const runner = createDiscussionRunner({ sessions, service: { completeCourse: async input => {
    assert.equal(input.courseUrl, courseUrl); return { total: 2, failed: 1 };
  } } });
  assert.throws(() => runner.start({}), /链接/);
  runner.start({ courseUrl }); assert.throws(() => runner.start({ courseUrl }), /已有/);
  await runner.waitForIdle(); assert.equal(runner.getState().status, 'partial');
  assert.doesNotMatch(JSON.stringify(runner.getState()), /private-cookie/);
});

test('changing accounts aborts publication and discards late results', async () => {
  let finish, signal;
  const runner = createDiscussionRunner({ sessions, service: { completeCourse: (input, cookie, context) => {
    signal = context.signal; return new Promise(resolve => { finish = resolve; });
  } } });
  runner.start({ courseUrl }); await new Promise(resolve => setImmediate(resolve)); runner.reset();
  assert.equal(signal.aborted, true); finish({ total: 2, failed: 0 }); await runner.waitForIdle();
  assert.equal(runner.getState().status, 'idle'); assert.equal(runner.getState().result, null);
});
