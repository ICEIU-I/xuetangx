const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { createRuntime } = require('../../server/workflow/runtime');
const { createAccounts } = require('../../server/workflow/accounts');

test('real homework child recovers a dropped submission, logs retry, and confirms the final result', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'retry-runtime-'));
  const accounts = createAccounts({ authenticate: async () => ({ user_id: 1 }) });
  await accounts.connect('primary', 'fixture-cookie');
  const courseUrl = 'https://www.xuetangx.com/learn/space/s/s/12';
  const problem = { problem_id: 101, content: { Type: 'SingleChoice', Body: 'Test', Options: [{ key: 'A' }, { key: 'B' }] } };
  let posts = 0, reads = 0, accepted = false;
  const response = data => ({ status: 200, json: { success: true, data } });
  const transport = {
    async get(endpoint) {
      if (endpoint.includes('/user-courses/')) return response({ pages: 1, product_list: [{ classroom_id: 12, sign: 's', course_sign: 's', name: 'Test course' }] });
      if (endpoint.includes('/course/chapter')) return response({ course_chapter: [{ id: 34, leaf_type: 6, name: 'Exercise' }] });
      if (endpoint.includes('/course/schedule')) return response({ leaf_schedules: { 34: 0 } });
      if (endpoint.includes('/leaf_info/12/34/')) return response({ id: 34, classroom_id: 12, leaf_type: 6, sku_id: 78, content_info: { leaf_type_id: 56 } });
      if (endpoint.includes('/get_exercise_list/56/78/')) {
        reads++;
        return response({ problems: [{ ...problem, user: { my_count: accepted ? 1 : 0, is_right: accepted } }] });
      }
      throw Error(`Unexpected request: ${endpoint}`);
    },
    async post(endpoint, body) {
      assert.equal(endpoint, '/api/v1/lms/exercise/problem_apply/'); assert.deepEqual(body.answer, ['B']);
      if (++posts === 1) throw Object.assign(Error('request timed out before acceptance'), { code: 'ETIMEDOUT', connectionEstablished: true });
      accepted = true; return response({ is_correct: true });
    },
  };
  const runtime = createRuntime({ directory: path.join(directory, 'state'), bankDirectory: path.join(directory, 'bank'), accounts, transport, interval: 0 });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await runtime.ready;
  const account = { role: 'primary', userId: 1 };
  const inventory = await runtime.catalog.discover(account, courseUrl);
  inventory.exercises = await runtime.catalog.exercises(account, inventory);
  await runtime.bank.save(inventory, inventory.exercises[0], problem, { is_show_answer: true, answer: ['B'] }, { source: 'fixture' });
  const job = await runtime.start({ courseUrl, modules: ['homework'] });
  const deadline = Date.now() + 15000;
  let result;
  do {
    result = await runtime.get(job.id);
    if (['done', 'partial'].includes(result.status)) break;
    assert.ok(Date.now() < deadline, 'homework should settle after bounded reconciliation');
    await wait(20);
  } while (true);
  assert.equal(result.status, 'done', JSON.stringify(result.modules));
  assert.equal(result.modules.homework.completed, 1); assert.equal(result.modules.homework.failed, 0);
  assert.equal(posts, 2); assert.ok(reads >= 5, 'discovery, three fresh checks and final verification must execute');
  assert.ok(result.logs.some(log => log.message.includes('自动重试 1/2')));
});
