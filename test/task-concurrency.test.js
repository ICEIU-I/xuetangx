const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { workers } = require('../src/tasks');
const { createApp } = require('../server');
const { createVideoRunner } = require('../server/video-runner');
const { createArticleRunner } = require('../server/article-runner');
const { createDiscussionRunner } = require('../server/discussion-runner');
const { createAnswerRunner } = require('../server/answer-runner');
const { createHomeworkRunner } = require('../server/runner');
const courseUrl = 'https://www.xuetangx.com/learn/space/a/a/12';

test('default worker limit is one and stopping waits for active operations', async () => {
  let active = 0, peak = 0, finished = 0;
  await workers([1, 2, 3, 4, 5, 6], undefined, async () => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; finished++;
  });
  assert.equal(peak, 1); assert.equal(finished, 6);
});

test('HTTP routes allow all task types concurrently and stopping one does not stop others', async t => {
  const sessions = { isConnected: () => true, getCookie: () => 'cookie', summary: () => ({ connected: true }), clear() {} };
  const gates = [];
  const hold = async (input, cookie, { signal }) => {
    assert.equal(input.concurrency ?? 1, 1);
    return new Promise((resolve, reject) => { gates.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  };
  const videoRunner = createVideoRunner({ sessions, service: { completeCourse: hold } });
  const articleRunner = createArticleRunner({ sessions, service: { completeCourse: hold } });
  const discussionRunner = createDiscussionRunner({ sessions, service: { completeCourse: hold } });
  const answerRunner = createAnswerRunner({ sessions, collector: { collect: hold } });
  const runner = createHomeworkRunner({ sessions, service: { complete: hold } });
  const all = [videoRunner, articleRunner, discussionRunner, answerRunner, runner];
  const app = createApp({ session: sessions, videoRunner, articleRunner, discussionRunner, answerRunner, runner });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { all.forEach(task => task.reset()); await Promise.all(all.map(task => task.waitForIdle())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const send = endpoint => fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl }) });
  const paths = ['/api/video/run', '/api/article/run', '/api/discussion/run', '/api/answer-bank/run', '/api/run'];
  const responses = await Promise.all(paths.map(send));
  assert.ok(responses.every(response => response.status === 202));
  assert.ok(all.every(task => task.getState().status === 'running'));
  assert.ok((await Promise.all(paths.map(send))).every(response => response.status >= 400));
  await send('/api/article/stop'); await articleRunner.waitForIdle();
  assert.equal(articleRunner.getState().status, 'stopped');
  assert.ok([videoRunner, discussionRunner, answerRunner, runner].every(task => task.getState().status === 'running'));
});
