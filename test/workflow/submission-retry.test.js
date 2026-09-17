const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSubmissions } = require('../../server/workflow/submissions');
const { createStorage } = require('../../server/workflow/storage');
const { fingerprint } = require('../../server/workflow/questions');

const problem = { problem_id: 101, content: { Type: 'SingleChoice', Body: 'Question', Options: [{ key: 'A' }, { key: 'B' }] }, user: { my_count: 0 } };
const answered = { my_count: 1, is_right: true, is_correct: true, is_show_answer: true, answer: ['B'] };
const networkError = () => Object.assign(Error('request timed out'), { code: 'ETIMEDOUT', connectionEstablished: true });
const ok = data => ({ status: 200, json: { success: true, data } });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const effects = createStorage(root), controller = new AbortController(), logs = [], events = [];
  let posts = 0, reads = 0, current = structuredClone(problem);
  const exercise = { leafId: 34, exerciseId: 56, skuId: 78, problems: [problem] };
  const actor = { kind: options.collector ? 'collector' : 'homework', account: { role: options.collector ? 'test' : 'primary', userId: 1 }, controller, input: { exercises: [exercise] } };
  const job = { course: { classroomId: 12, sign: 's' } }, args = { leafId: 34, problemId: 101, body: { answer: [options.collector ? 'A' : 'B'], answers: {} } };
  const key = `question-1-12-101-${fingerprint(problem).slice(0, 16)}`;
  const dependencies = {
    effects, report: (job, actor, message) => logs.push(message), recheckDelays: [1, 2, 4],
    wait: async (ms, value, { signal }) => { events.push(`wait:${ms}`); await options.wait?.(ms, controller); signal.throwIfAborted(); },
    bank: { read: async () => ({ exercises: { 34: { questions: [{ problem_id: 101, fingerprint: fingerprint(problem), type: 'choice', answer: 'B', answer_status: 'captured' }] } } }) },
    catalog: { data: async () => {
      events.push(`get:${++reads}`);
      if (options.get) return options.get(reads, structuredClone(current));
      return { problems: [structuredClone(current)] };
    } },
    call: async (account, method, endpoint, body) => {
      assert.equal(method, 'POST'); assert.equal(endpoint, '/api/v1/lms/exercise/problem_apply/');
      assert.equal(body.classroom_id, 12); assert.equal(body.sign, 's');
      events.push(`post:${++posts}`);
      if (options.post) return options.post(posts, user => { current.user = user; });
      current.user = answered; return ok(answered);
    },
  };
  let service = createSubmissions(dependencies);
  return { controller, logs, events, effects, key, counts: () => ({ posts, reads }),
    seed: record => effects.save(key, record), saved: () => effects.read(key),
    restart: () => { service = createSubmissions(dependencies); }, submit: () => service.submitQuestion(job, actor, args) };
}

test('timeout with three confirmed unanswered reads retries and succeeds', async t => {
  const f = await fixture(t, { post: async (count, set) => { if (count === 1) throw networkError(); set(answered); return ok(answered); } });
  assert.equal((await f.submit()).is_correct, true);
  assert.deepEqual(f.counts(), { posts: 2, reads: 3 });
  assert.deepEqual(f.events.slice(0, 8), ['post:1', 'wait:1', 'get:1', 'wait:2', 'get:2', 'wait:4', 'get:3', 'post:2']);
  assert.equal((await f.saved()).state, 'posted'); assert.equal((await f.saved()).networkRetries, 1);
  assert.ok(f.logs.some(text => text.includes('自动重试 1/2')));
});

test('accepted timeout and delayed visibility never resubmit, even when graded wrong', async t => {
  for (const correct of [true, false]) {
    const user = { ...answered, is_right: correct, is_correct: correct };
    const f = await fixture(t, { post: async () => { throw networkError(); }, get: async (n, p) => ({ problems: [{ ...p, user: n < 3 ? { my_count: 0 } : user }] }) });
    assert.equal((await f.submit()).is_correct, correct);
    assert.deepEqual(f.counts(), { posts: 1, reads: 3 }); assert.equal((await f.saved()).state, 'confirmed');
  }
});

test('failed reads, missing counts, missing questions and changed versions do not authorize retry', async t => {
  const replies = [() => { throw networkError(); }, () => ({ problems: [] }),
    (n, p) => ({ problems: [{ ...p, user: {} }] }), (n, p) => ({ problems: [{ ...p, user: { my_count: null } }] }),
    (n, p) => ({ problems: [{ ...p, user: { my_count: '' } }] }), (n, p) => ({ problems: [{ ...p, user: { my_count: false } }] }),
    (n, p) => ({ problems: [{ ...p, content: { ...p.content, Body: 'Changed' } }] })];
  for (const get of replies) {
    const f = await fixture(t, { post: async () => { throw networkError(); }, get });
    await assert.rejects(f.submit(), { code: 'REVIEW_REQUIRED' });
    assert.equal(f.counts().posts, 1); assert.equal((await f.saved()).state, 'unknown');
  }
});

test('legacy unknown and interrupted pending submissions resume after confirmed unanswered reads', async t => {
  for (const state of ['unknown', 'pending']) {
    const f = await fixture(t); await f.seed({ state, at: Date.now() - 60000 }); f.restart();
    assert.equal((await f.submit()).is_correct, true);
    assert.deepEqual(f.counts(), { posts: 1, reads: 3 });
    assert.equal((await f.saved()).networkRetries, 1);
  }
});

test('unreachable-network errors and legacy incorrectly nonretryable records recover after confirmation', async t => {
  for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN']) {
    const f = await fixture(t); await f.seed({ state: 'unknown', retryable: false, lastError: code, networkRetries: 0 });
    assert.equal((await f.submit()).is_correct, true); assert.deepEqual(f.counts(), { posts: 1, reads: 3 });
    const live = await fixture(t, { post: async count => { if (count === 1) throw Object.assign(networkError(), { code }); return ok(answered); } });
    assert.equal((await live.submit()).is_correct, true); assert.deepEqual(live.counts(), { posts: 2, reads: 3 });
  }
});

test('automatic retry budget survives recreated service and successful outcomes still reconcile', async t => {
  let accepted = false;
  const f = await fixture(t, { post: async () => { throw networkError(); }, get: async (n, p) => ({ problems: [{ ...p, user: accepted ? answered : { my_count: '0' } }] }) });
  await assert.rejects(f.submit(), { code: 'SUBMISSION_RETRY_EXHAUSTED' });
  assert.equal(f.counts().posts, 3); assert.equal((await f.saved()).networkRetries, 2);
  f.restart(); await assert.rejects(f.submit(), { code: 'SUBMISSION_RETRY_EXHAUSTED' }); assert.equal(f.counts().posts, 3);
  accepted = true; f.restart(); assert.equal((await f.submit()).is_correct, true); assert.equal(f.counts().posts, 3);
});

test('pause during reconciliation leaves recoverable state and sends no retry', async t => {
  let pause = true;
  const f = await fixture(t, { post: async () => { throw networkError(); }, wait: async (ms, controller) => { if (pause) { pause = false; controller.abort(); } } });
  await assert.rejects(f.submit(), { name: 'AbortError' });
  assert.equal(f.counts().posts, 1); assert.equal((await f.saved()).state, 'unknown');
});

test('known business rejection and authorization failure are not retried', async t => {
  const business = await fixture(t, { post: async () => ({ status: 200, json: { success: false, msg: '没有回答机会' } }) });
  await assert.rejects(business.submit(), /没有回答机会/); assert.deepEqual(business.counts(), { posts: 1, reads: 0 });
  const auth = await fixture(t, { post: async () => { throw Object.assign(Error('Forbidden'), { code: 'ACCESS_DENIED' }); } });
  await assert.rejects(auth.submit(), { code: 'ACCESS_DENIED' }); assert.deepEqual(auth.counts(), { posts: 1, reads: 0 });
});

test('HTTP 503 is checked before retry; 429 still uses the gateway instead of network retries', async t => {
  const server = await fixture(t, { post: async count => count === 1 ? { status: 503 } : ok(answered) });
  await server.submit(); assert.deepEqual(server.counts(), { posts: 2, reads: 3 });
  const throttled = await fixture(t, { post: async count => count === 1 ? { status: 429 } : ok(answered) });
  await throttled.submit(); assert.deepEqual(throttled.counts(), { posts: 2, reads: 0 }); assert.equal((await throttled.saved()).networkRetries, 0);
});

test('connection failure before sending backs off without requiring reconciliation', async t => {
  const f = await fixture(t, { post: async count => { if (count === 1) throw Object.assign(networkError(), { connectionEstablished: false }); return ok(answered); } });
  await f.submit(); assert.deepEqual(f.counts(), { posts: 2, reads: 0 }); assert.ok(f.events.includes('wait:1000'));
});

test('concurrent calls deduplicate the entire retry sequence', async t => {
  const f = await fixture(t, { post: async count => { if (count === 1) throw networkError(); return ok(answered); } });
  const results = await Promise.all([f.submit(), f.submit(), f.submit()]);
  assert.ok(results.every(r => r.is_correct)); assert.deepEqual(f.counts(), { posts: 2, reads: 3 });
});

test('accepted responses and local storage failures cannot cause extra submissions', async t => {
  const f = await fixture(t); await f.seed({ state: 'posted' });
  await assert.rejects(f.submit(), { code: 'REVIEW_REQUIRED' }); assert.equal(f.counts().posts, 0);
  const disk = await fixture(t), save = disk.effects.save;
  disk.effects.save = async (key, value) => { if (value.state === 'posted') throw Error('disk full'); return save(key, value); };
  await assert.rejects(disk.submit(), /disk full/); assert.equal(disk.counts().posts, 1);
  disk.effects.save = save; disk.restart(); assert.equal((await disk.submit()).is_correct, true); assert.equal(disk.counts().posts, 1);
});

test('test-account collection recovers accepted responses without spending another attempt', async t => {
  const f = await fixture(t, { collector: true, post: async (n, set) => { set(answered); throw networkError(); } });
  const response = await f.submit(); assert.deepEqual(response.answer, ['B']); assert.equal(response.is_show_answer, true); assert.equal(f.counts().posts, 1);
});

test('homework final reconciliation clears a timeout only when the same question is confirmed correct', async () => {
  const { createWorkerActions } = require('../../server/workflow/worker-actions');
  for (const mode of ['confirmed', 'unanswered', 'changed']) {
    let submissions = 0;
    const actions = createWorkerActions({ signal: new AbortController().signal, progress() {}, rpc: async method => {
      if (method === 'submit-question') { submissions++; throw Object.assign(Error('recheck unavailable'), { code: 'REVIEW_REQUIRED' }); }
      const fresh = structuredClone(problem);
      if (mode !== 'unanswered') fresh.user = answered;
      if (mode === 'changed') fresh.content.Body = 'New version';
      return ok({ problems: [fresh] });
    } });
    const result = await actions.run({ kind: 'homework', course: { classroomId: 12 }, concurrency: 3, producerFinished: true,
      exercises: [{ leafId: 34, exerciseId: 56, skuId: 78, problems: [problem] }],
      ready: [{ leafId: 34, problemId: 101, fingerprint: fingerprint(problem), answer: { type: 'choice', answer: 'B' } }] });
    assert.equal(submissions, 1); assert.equal(result.processed, 1);
    assert.equal(result.completed, mode === 'confirmed' ? 1 : 0); assert.equal(result.failed, mode === 'confirmed' ? 0 : 1);
    if (mode === 'confirmed') assert.equal(result.results[0].error, undefined);
  }
});
