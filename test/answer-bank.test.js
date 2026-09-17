const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAnswerService, extractAnswer } = require('../src/answer-bank');
const { createAnswerStore } = require('../src/answer-store');
const course = { classroomId: 12, sign: 'course', courseSign: 'course', title: '测试课程', url: 'https://www.xuetangx.com/learn/space/course/course/12' };
const question = (problemId, visible = false) => ({ problem_id: problemId, index: problemId,
  content: { Type: 'SingleChoice', Body: '<p>测试题</p>', Options: ['A', 'B', 'C', 'D'].map(key => ({ key, value: key })) },
  user: visible ? { is_show_answer: true, answer: ['D'], my_answer: ['C'], my_count: 1 } : { is_show_answer: false, my_count: 0 } });

async function fixture(t, { visible = false, problemCount = 2, postFailure, locked = false, maxRetries = 0 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'answer-db-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createAnswerStore(directory), calls = [];
  const problems = Array.from({ length: problemCount }, (_, i) => question(101 + i, visible && i === 0));
  const service = createAnswerService({ store, courses: { listCourses: async () => [course] }, sleep: async () => {}, requestInterval: 0, submitInterval: 0, maxRetries,
    transport: {
      async get(endpoint) {
        calls.push({ method: 'GET', endpoint });
        let data;
        if (endpoint.includes('/course/chapter')) data = { course_chapter: [{ children: [{ leaf_list: [
          { id: 34, leaf_type: 6, name: '章节测试', is_locked: locked }, { id: 34, leaf_type: 6, name: '重复引用', is_locked: locked },
          { id: 35, leaf_type: 0, name: '视频' }, { id: 36, leaf_type: 4, name: '讨论' },
        ] }] }] };
        else if (endpoint.includes('/leaf_info/12/34/')) data = { id: 34, classroom_id: 12, leaf_type: 6, sku_id: 78, content_info: { leaf_type_id: 56 } };
        else if (endpoint.includes('/get_exercise_list/56/78/')) data = { problems: structuredClone(problems) };
        else throw new Error('Unexpected GET: ' + endpoint);
        return { status: 200, json: { success: true, data } };
      },
      async post(endpoint, body) {
        calls.push({ method: 'POST', endpoint, body });
        if (postFailure) return postFailure(body);
        const problem = problems.find(item => item.problem_id === body.problem_id);
        problem.user = { is_show_answer: true, my_count: 1, answer: ['D'], my_answer: body.answer };
        return { status: 200, json: { success: true, data: { ...problem.user, is_correct: false } } };
      },
    } });
  return { service, store, calls, problems, directory };
}

test('never treats my_answer as the standard answer, including incorrect submissions', () => {
  const problem = question(1);
  assert.equal(extractAnswer(problem, { is_show_answer: true, my_answer: ['C'] }), null);
  assert.equal(extractAnswer(problem, { is_show_answer: false, answer: ['D'] }), null);
  assert.equal(extractAnswer(problem, { is_show_answer: true, answer: ['D'], my_answer: ['C'] }, 'test').answer, 'D');
});

test('normalizes false judgements, multiple choice and fill answers without dropping zero', () => {
  assert.equal(extractAnswer({ content: { Type: 'Judgement' } }, { is_show_answer: true, answer: false }).answer, '错误');
  assert.deepEqual(extractAnswer({ content: { Type: 'MultiChoice', Options: [{ key: 'A' }, { key: 'C' }] } }, { is_show_answer: true, answer: ['A', 'C'] }).answers, ['A', 'C']);
  assert.deepEqual(extractAnswer({ content: { Type: 'FillBlank', Blanks: [{}, {}] } }, { is_show_answer: true, answers: { 1: [0], 2: ['x', 'X'] } }).answers, ['0', 'x']);
  assert.equal(extractAnswer({ content: { Type: 'FillBlank', Blanks: [{}, {}] } }, { is_show_answer: true, answers: { 1: ['x'] } }), null);
});

test('read-only collection saves visible answers and marks missing answers without posting', async t => {
  const { service, store, calls } = await fixture(t, { visible: true });
  const result = await service.collect({ courseUrl: course.url }, 'private-cookie');
  assert.equal(result.complete, false);
  assert.equal(result.totalExercises, 1);
  assert.equal(result.capturedAnswers, 1);
  assert.equal(result.missingAnswers, 1);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  const saved = await store.read(12);
  assert.equal(saved.exercises[34].questions[0].answer, 'D');
  assert.equal(saved.exercises[34].questions[1].answer_status, 'missing');
  assert.doesNotMatch(JSON.stringify(saved), /private-cookie|my_answer/);
});

test('explicit submission mode saves standard answers and a second run skips all writes', async t => {
  const { service, store, calls } = await fixture(t, { visible: true });
  const result = await service.collect({ courseUrl: course.url, submitUnanswered: true }, 'cookie');
  assert.equal(result.complete, true);
  assert.equal(result.capturedAnswers, 2);
  const writes = calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { leaf_id: 34, classroom_id: 12, exercise_id: 56, problem_id: 102, sign: 'course', answer: ['A'], answers: {} });
  assert.equal((await store.read(12)).exercises[34].questions[1].answer, 'D');
  await service.collect({ courseUrl: course.url, submitUnanswered: true }, 'cookie');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('scope checks reject another course before writing or submitting', async t => {
  const { service, store, calls } = await fixture(t);
  await assert.rejects(service.collect({ courseUrl: course.url.replace('/12', '/99'), submitUnanswered: true }, 'cookie'), /已选课程/);
  assert.equal(await store.read(99), null);
  assert.equal(calls.length, 0);
});

test('cancellation preserves captured answers and releases the database lock for resuming', async t => {
  const { service, store, calls } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(service.collect({ courseUrl: course.url, submitUnanswered: true }, 'cookie', {
    signal: controller.signal, onProgress: state => { if (state.capturedAnswers === 1) controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal((await store.read(12)).exercises[34].questions[0].answer, 'D');
  const result = await service.collect({ courseUrl: course.url, submitUnanswered: true }, 'cookie');
  assert.equal(result.complete, true);
  assert.equal(calls.filter(call => call.method === 'POST').length, 2);
});

test('an ambiguous failed submission is checkpointed and never automatically replayed', async t => {
  const { service, store, calls } = await fixture(t, { problemCount: 1, postFailure: () => { throw new Error('connection lost'); } });
  const first = await service.collect({ courseUrl: course.url, submitUnanswered: true }, 'cookie');
  assert.equal(first.complete, false);
  assert.equal((await store.read(12)).exercises[34].questions[0].submission.state, 'unknown');
  await service.collect({ courseUrl: course.url, submitUnanswered: true }, 'cookie');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('locked exercises and changed question versions cannot be presented as complete', async t => {
  const locked = await fixture(t, { locked: true });
  assert.equal((await locked.service.collect({ courseUrl: course.url }, 'cookie')).failedExercises, 1);
  const changed = await fixture(t, { visible: true, problemCount: 1 });
  await changed.service.collect({ courseUrl: course.url }, 'cookie');
  changed.problems[0].content.Body = 'Changed question';
  changed.problems[0].user = { is_show_answer: false, my_count: 1 };
  assert.equal((await changed.service.collect({ courseUrl: course.url }, 'cookie')).capturedAnswers, 0);
});

test('atomic JSON persistence preserves valid files and rejects corrupted databases', async t => {
  const { store, directory } = await fixture(t);
  await store.save({ version: 1, course, exercises: {} });
  assert.equal((await store.read(12)).version, 1);
  assert.deepEqual(await fs.readdir(directory), ['12.json']);
  await fs.writeFile(store.filePath(12), '{broken');
  await assert.rejects(store.read(12), /原文件未覆盖/);
  assert.equal(await fs.readFile(store.filePath(12), 'utf8'), '{broken');
});

test('a live course lock rejects a concurrent writer', async t => {
  const { store } = await fixture(t);
  await store.withLock(12, async () => { await assert.rejects(store.withLock(12, async () => {}), /已有答案采集任务/); });
  await store.withLock(12, async () => {});
});
