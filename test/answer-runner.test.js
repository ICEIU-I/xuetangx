const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnswerRunner } = require('../server/answer-runner');
const courseUrl = 'https://www.xuetangx.com/learn/space/a/a/12';
const sessions = { isConnected: () => true, getCookie: () => 'secret-cookie' };

test('answer runner validates scope and forwards explicit submission mode', async () => {
  const runner = createAnswerRunner({ sessions, collector: { collect: async (input, cookie) => {
    assert.equal(input.submitUnanswered, true); assert.equal(cookie, 'secret-cookie'); return { complete: true };
  } } });
  assert.throws(() => runner.start({ courseUrl, submitUnanswered: 'true' }), /模式/);
  runner.start({ courseUrl, submitUnanswered: true });
  assert.throws(() => runner.start({ courseUrl }), /已有/);
  await runner.waitForIdle();
  assert.equal(runner.getState().status, 'done');
  assert.doesNotMatch(JSON.stringify(runner.getState()), /secret-cookie/);
});

test('missing answers are reported as partial, not successful completion', async () => {
  const runner = createAnswerRunner({ sessions, collector: { collect: async () => ({ complete: false, missingAnswers: 2 }) } });
  runner.start({ courseUrl }); await runner.waitForIdle();
  assert.equal(runner.getState().status, 'partial');
});

test('account reset aborts the job and discards its old result', async () => {
  let finish, capturedSignal;
  const runner = createAnswerRunner({ sessions, collector: { collect: (input, cookie, { signal }) => { capturedSignal = signal; return new Promise(resolve => { finish = resolve; }); } } });
  runner.start({ courseUrl }); await new Promise(resolve => setImmediate(resolve));
  runner.reset(); assert.equal(capturedSignal.aborted, true);
  finish({ complete: true }); await runner.waitForIdle();
  assert.equal(runner.getState().status, 'idle');
  assert.equal(runner.getState().result, null);
});
