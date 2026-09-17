const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createBank } = require('../server/workflow/bank');
const { createStorage } = require('../server/workflow/storage');
const { fingerprint, storedAnswer } = require('../server/workflow/questions');
const { createWorkerActions } = require('../server/workflow/worker-actions');
const course = { classroomId: 12, sign: 's', courseSign: 's', url: 'https://www.xuetangx.com/learn/space/s/s/12' };
const problem = id => ({ problem_id: id, content: { Type: 'SingleChoice', Body: '题目' + id, Options: [{ key: 'A', value: 'a' }, { key: 'B', value: 'b' }], Version: 'v1' }, user: { my_count: 0 } });
const exercise = { leafId: 34, exerciseId: 56, skuId: 78, title: '测试', problems: [problem(101), problem(102)] };
const inventory = { course, exercises: [exercise] };

test('bank coverage validates question version and legacy v1 bank format', () => {
  const p = problem(101), record = { type: 'choice', answer: 'B', answer_status: 'captured', fingerprint: createHash('sha256').update(JSON.stringify(p.content)).digest('hex') };
  assert.equal(storedAnswer(p, record).answer, 'B');
  assert.equal(storedAnswer({ ...p, content: { ...p.content, Body: 'changed' } }, record), null);
});
test('concurrent answers persist before notifications and wrong test-account versions are rejected', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-bank-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bank = createBank({ directory: root }), notifications = [];
  bank.onAnswer(event => notifications.push(event));
  await Promise.all(exercise.problems.map(p => bank.save(inventory, exercise, p, { is_show_answer: true, answer: ['B'], my_answer: ['A'] }, { source: 'submission_response', role: 'test' })));
  assert.equal((await bank.coverage(inventory)).captured, 2);
  assert.equal((await createStorage(root).read('12')).exercises['34'].questions.length, 2);
  assert.equal(notifications.length, 2);
  const changed = problem(101); changed.content.Version = 'v2';
  await assert.rejects(bank.save(inventory, exercise, changed, { is_show_answer: true, answer: ['B'] }, {}), /不匹配/);
});
test('formal worker submits a newly available answer before collection finishes', async () => {
  let listener, submitted = 0, producerDone = false;
  const controller = new AbortController();
  const actions = createWorkerActions({ signal: controller.signal, progress() {}, subscribe(fn) { listener = fn; return () => {}; }, rpc: async (method, args) => {
    if (method === 'submit-question') { assert.equal(producerDone, false); assert.deepEqual(args.body.answer, ['B']); submitted++; return { is_correct: true }; }
    if (method === 'request') return { status: 200, json: { success: true, data: { problems: [{ ...problem(101), user: { my_count: 1, is_right: true } }, problem(102)] } } };
  } });
  const running = actions.run({ kind: 'homework', course, exercises: [exercise], ready: [], producerFinished: false, concurrency: 3 });
  await new Promise(resolve => setImmediate(resolve));
  listener({ type: 'answer-ready', answer: { leafId: 34, problemId: 101, fingerprint: fingerprint(problem(101)), answer: { type: 'choice', answer: 'B' } } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(submitted, 1);
  producerDone = true; listener({ type: 'answers-complete' });
  const result = await running; assert.equal(result.completed, 1); assert.equal(result.failed, 1);
});
test('fatal authorization error ends all waiting homework workers instead of hanging', async () => {
  const actions = createWorkerActions({ signal: new AbortController().signal, progress() {}, rpc: async () => { throw Object.assign(Error('login expired'), { code: 'ACCOUNT_REQUIRED' }); } });
  await assert.rejects(actions.run({ kind: 'homework', course, exercises: [exercise], ready: [{ leafId: 34, problemId: 101, fingerprint: fingerprint(problem(101)), answer: { type: 'choice', answer: 'B' } }], producerFinished: false }), /login expired/);
});
test('collector refuses mismatched questions and never submits the wrong version', async () => {
  let submissions = 0;
  const actions = createWorkerActions({ signal: new AbortController().signal, progress() {}, rpc: async () => { submissions++; } });
  const result = await actions.run({ kind: 'collector', course, exercises: [exercise], missing: [{ leafId: 34, problemId: 101, fingerprint: 'different' }] });
  assert.equal(submissions, 0); assert.equal(result.failed, 1);
});
