const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRuntime } = require('../../server/workflow/runtime');
const { createAccounts } = require('../../server/workflow/accounts');
const { createStorage } = require('../../server/workflow/storage');
const courseUrl = 'https://www.xuetangx.com/learn/space/s/s/12';
const problem = id => ({ problem_id: id, index: id, content: { Type: 'SingleChoice', Body: `题目${id}`, Options: [{ key: 'A', value: 'a' }, { key: 'B', value: 'b' }], Version: 'v1' } });
async function until(predicate, timeout = 6000) {
  const start = Date.now(); while (!await predicate()) { if (Date.now() - start > timeout) throw Error('等待测试条件超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t, { withTest = false, enrolledTest = true, quotaLimit = 20, pendingMedia = false, uncertainSubmission = false, slowDiscovery = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-'));
  const accounts = createAccounts({ authenticate: async cookie => ({ user_id: Number(cookie) }) });
  await accounts.connect('primary', '1'); if (withTest) await accounts.connect('test', '2');
  const done = { 1: new Map(), 2: new Map() }, posts = [], reads = [];
  const completedMedia = new Set(pendingMedia ? [] : [31, 32, 33]);
  let uncertain = uncertainSubmission;
  const response = data => ({ status: 200, json: { success: true, data } });
  const transport = {
    async get(endpoint, cookie) {
      const userId = Number(cookie); reads.push({ endpoint, userId });
      if (slowDiscovery && endpoint.includes('/user-courses/')) await new Promise(resolve => setTimeout(resolve, 20));
      if (endpoint.includes('/user-courses/')) return response({ pages: 1, product_list: userId === 2 && !enrolledTest ? [] : [{ classroom_id: 12, sign: 's', course_sign: 's', name: '课程' }] });
      if (endpoint.includes('/course/chapter')) return response({ course_chapter: [{ id: 31, leaf_type: 0, name: '视频' }, { id: 32, leaf_type: 3, name: '图文' }, { id: 33, leaf_type: 4, name: '讨论' }, { id: 34, leaf_type: 6, name: '作业' }] });
      if (endpoint.includes('/course/schedule')) return response({ leaf_schedules: Object.fromEntries([...completedMedia].map(id => [id, 1])), total_schedule: completedMedia.size / 4 });
      const media = /leaf_info\/12\/(31|32|33)\//.exec(endpoint);
      if (media) { const id = Number(media[1]); return response({ id, classroom_id: 12, leaf_type: { 31: 0, 32: 3, 33: 4 }[id], course_id: 10, user_id: userId, sku_id: 78, finish: completedMedia.has(id), content_info: { media: { ccid: 'test-cc', type: 'video', duration: 12 } } }); }
      if (endpoint.includes('/get_video_watch_progress/')) return response({ 31: { completed: completedMedia.has(31) ? 1 : 0, video_length: 12 } });
      if (endpoint.includes('/service/playurl/')) return response({ duration: 12, sources: { quality10: ['https://cdn.example.test/video.mp4'] } });
      if (endpoint.includes('/user_article_finish/32/')) { completedMedia.add(32); return response({}); }
      if (endpoint.includes('/forum/unit/discussion/')) return response({ id: 133, classroom_id: 12, chapter_id: 33, user_id: 77, user_comment_num: completedMedia.has(33) ? 1 : 0 });
      if (endpoint.includes('/leaf_info/12/34/')) return response({ id: 34, classroom_id: 12, leaf_type: 6, user_id: userId, sku_id: userId === 1 ? 78 : 79, content_info: { leaf_type_id: 56 } });
      if (endpoint.includes('/get_exercise_list/56/')) return response({ problems: [101, 102, 103].map(id => ({ ...problem(id), user: done[userId].get(id) || { my_count: 0, is_show_answer: false } })) });
      throw Error('Unexpected GET: ' + endpoint);
    },
    async post(endpoint, body, cookie) {
      if (endpoint === '/video-log/heartbeat/') { assert.ok(body.heart_data.every(item => item.u === 1 && item.classroomid === '12')); completedMedia.add(31); return response({}); }
      if (endpoint.startsWith('/api/v1/lms/forum/comment/')) { assert.equal(body.content.text, '1'); completedMedia.add(33); return response({ data: { id: 933 } }); }
      if (endpoint === '/api/v1/lms/learn/chapter/schedule') return response({ leaf_schedule: completedMedia.has(body.leaf_id) ? 1 : 0 });
      assert.equal(endpoint, '/api/v1/lms/exercise/problem_apply/'); const userId = Number(cookie);
      posts.push({ userId, body, time: Date.now() });
      const correct = body.answer[0] === 'B';
      const data = { my_count: 1, is_show_answer: true, answer: ['B'], my_answer: body.answer, is_right: correct, is_correct: correct };
      done[userId].set(body.problem_id, data);
      if (uncertain) { uncertain = false; throw Object.assign(Error('connection lost after acceptance'), { code: 'ECONNRESET', connectionEstablished: true }); }
      return response(data);
    },
  };
  const runtime = createRuntime({ directory: path.join(root, 'runtime'), bankDirectory: path.join(root, 'bank'), accounts, transport, interval: 0, quotaOptions: { limit: quotaLimit, period: 60, guard: 1 }, forkImpl(file, args, options) {
    assert.ok(!('COOKIE' in options.env)); assert.ok(!('TEST_COOKIE' in options.env));
    return require('node:child_process').fork(file, args, options);
  } });
  await runtime.ready;
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, accounts, runtime, posts, reads, done };
}

test('real child processes stream answers from test to formal account and persist complete results', async t => {
  const { runtime, posts, root } = await fixture(t, { withTest: true, quotaLimit: 2 });
  const job = await runtime.start({ courseUrl });
  await until(async () => ['done', 'partial'].includes((await runtime.get(job.id)).status));
  const result = await runtime.get(job.id);
  assert.equal(result.status, 'done', JSON.stringify(result.modules));
  assert.equal(result.modules.homework.completed, 3);
  assert.equal(result.modules.collector.captured, 3);
  assert.equal(posts.filter(post => post.userId === 1).length, 3);
  assert.equal(posts.filter(post => post.userId === 2).length, 3);
  assert.ok(posts.filter(post => post.userId === 1).every(post => post.body.answer[0] === 'B'));
  assert.ok(posts.findIndex(post => post.userId === 1) < posts.map(post => post.userId).lastIndexOf(2));
  const saved = await createStorage(path.join(root, 'bank')).read('12'); assert.equal(saved.exercises['34'].questions.length, 3);
  assert.doesNotMatch(JSON.stringify(await createStorage(path.join(root, 'runtime/jobs')).read(job.id)), /Cookie|csrftoken|sessionid/);
});

test('missing test account lets other modules finish; connecting it resumes only missing answer work', async t => {
  const { runtime, accounts } = await fixture(t);
  const job = await runtime.start({ courseUrl });
  await until(async () => (await runtime.get(job.id)).modules.collector?.status === 'waiting_account');
  await until(async () => (await runtime.get(job.id)).modules.video.status === 'done');
  await accounts.connect('test', '2');
  await until(async () => (await runtime.get(job.id)).status === 'done');
  assert.equal((await runtime.get(job.id)).coverage.missing, 0);
});

test('unselected test course is reported while media tasks continue', async t => {
  const { runtime } = await fixture(t, { withTest: true, enrolledTest: false });
  const job = await runtime.start({ courseUrl });
  await until(async () => (await runtime.get(job.id)).modules.collector?.status === 'waiting_enrollment');
  await until(async () => (await runtime.get(job.id)).modules.article.status === 'done');
  await runtime.control(job.id, 'pause');
  assert.equal((await runtime.get(job.id)).status, 'paused');
});

test('a complete cached bank needs no test account and deduplicates standalone starts', async t => {
  const { runtime, posts } = await fixture(t);
  const inventory = await runtime.catalog.discover({ role: 'primary', userId: 1 }, courseUrl);
  inventory.exercises = await runtime.catalog.exercises({ role: 'primary', userId: 1 }, inventory);
  for (const p of inventory.exercises[0].problems) await runtime.bank.save(inventory, inventory.exercises[0], p, { is_show_answer: true, answer: ['B'] }, { source: 'fixture' });
  const first = await runtime.start({ courseUrl });
  const second = await runtime.start({ courseUrl, modules: ['homework'] }); assert.equal(first.id, second.id);
  await until(async () => (await runtime.get(first.id)).status === 'done');
  assert.equal(posts.length, 3); assert.ok(posts.every(post => post.userId === 1));
});

test('worker crash restarts only that module and resume after restart keeps durable state', async t => {
  const { runtime, accounts, root } = await fixture(t);
  const job = await runtime.start({ courseUrl });
  await until(async () => (await runtime.get(job.id)).modules.homework?.status === 'waiting_answers');
  const before = await runtime.get(job.id), pid = before.modules.homework.pid;
  process.kill(pid, 'SIGKILL');
  await until(async () => { const current = await runtime.get(job.id); return current.modules.homework.pid && current.modules.homework.pid !== pid; });
  assert.equal((await runtime.get(job.id)).modules.article.status, 'done');
  await runtime.control(job.id, 'pause');
  await runtime.close();
  const recovered = createRuntime({ directory: path.join(root, 'runtime'), bankDirectory: path.join(root, 'bank'), accounts, interval: 0 });
  t.after(() => recovered.close()); await recovered.ready;
  assert.equal((await recovered.get(job.id)).status, 'paused');
  const file = await createStorage(path.join(root, 'runtime/jobs')).read(job.id);
  assert.equal(file.primaryId, 1); assert.doesNotMatch(JSON.stringify(file), /cookie/i);
});

test('production HTTP endpoints use the same job registry and separate test-account connection', async t => {
  const { createWorkflowApp } = require('../../server/workflow/app');
  const { once } = require('node:events');
  const { runtime } = await fixture(t);
  const app = createWorkflowApp({ runtime }), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, data) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const started = await (await post('/api/workflow/start', { courseUrl })).json();
  const joined = await (await post('/api/article/run', { courseUrl })).json();
  assert.equal(joined.state.jobId, started.job.id);
  assert.equal((await post('/api/test-cookie', { cookie: '1' })).status, 400);
  assert.equal((await post('/api/test-cookie', { cookie: '2' })).status, 200);
  await until(async () => (await runtime.get(started.job.id)).status === 'done');
  const state = await (await fetch(base + '/api/workflow/state')).json();
  assert.equal(state.accounts.primary.userId, 1); assert.equal(state.accounts.test.userId, 2);
  assert.equal(state.jobs[0].coverage.captured, 3);
});

test('all four real worker types finish pending units through the master request gateway', async t => {
  const { runtime, posts } = await fixture(t, { withTest: true, pendingMedia: true, uncertainSubmission: true });
  const job = await runtime.start({ courseUrl });
  await until(async () => ['done', 'partial'].includes((await runtime.get(job.id)).status));
  const state = await runtime.get(job.id);
  assert.equal(state.status, 'done', JSON.stringify(state.modules));
  for (const kind of ['video', 'article', 'discussion']) assert.equal(state.modules[kind].completed, 1);
  assert.equal(posts.length, 6, 'the accepted but disconnected submission must not be resent');
  assert.equal(state.modules.homework.completed, 3);
});

test('pause during discovery settles preparation, and resume starts a fresh scan', async t => {
  const { runtime } = await fixture(t, { withTest: true, slowDiscovery: true });
  const job = await runtime.start({ courseUrl });
  await runtime.control(job.id, 'pause'); assert.equal((await runtime.get(job.id)).status, 'paused');
  await runtime.control(job.id, 'resume');
  await until(async () => (await runtime.get(job.id)).status === 'done');
});

test('stopping one module during discovery does not cancel initialization of the others', async t => {
  const { runtime } = await fixture(t, { withTest: true, slowDiscovery: true });
  const job = await runtime.start({ courseUrl });
  await runtime.control(job.id, 'stop', 'video');
  await until(async () => (await runtime.get(job.id)).modules.homework.status === 'done');
  const result = await runtime.get(job.id);
  assert.equal(result.modules.video.status, 'stopped'); assert.equal(result.modules.article.status, 'done');
});
