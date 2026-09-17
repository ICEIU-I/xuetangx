const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHomeworkService } = require('../src/homework');
const { createHomeworkRunner } = require('../server/runner');
const course = { classroomId: 12, sign: 'real-course', courseSign: 'real-course', url: 'https://www.xuetangx.com/learn/space/real-course/real-course/12' };

function fixture({ queryError = false, done = false } = {}) {
  const submits = [], queries = [];
  const service = createHomeworkService({ courseService: { listCourses: async () => [course] },
    answers: { read: async () => ({ course, exercises: Object.fromEntries([31, 32, 33, 34, 35].map(id => [id, {
      leaf_id: id, exercise_id: id + 100, sku_id: 999, section: '章节' + id,
      questions: [{ problem_id: id + 1000, type: 'choice', answer: 'B', answer_status: 'captured' }],
    }])) }) },
    transport: { get: async endpoint => {
      const id = Number(/leaf_info\/12\/(\d+)/.exec(endpoint)[1]); assert.match(endpoint, /sign=real-course/);
      return { status: 200, json: { success: true, data: { id, classroom_id: 12, leaf_type: 6, sku_id: 78, content_info: { leaf_type_id: id + 100 } } } };
    } },
    exerciseApi: {
      getProblems: async (id, cookie, options) => { queries.push({ id, options }); return queryError ? { error: 'permission error' } : [{ problem_id: id + 900, type: 'SingleChoice', my_count: done ? 1 : 0, is_right: done, optionKeys: ['A', 'B'] }]; },
      submit: async job => { submits.push(job); return { ok: true, data: { is_correct: true } }; },
    },
  });
  return { service, submits, queries };
}
test('homework loads all database exercises and uses live SKU, class and sign for submission', async () => {
  const { service, submits, queries } = fixture();
  const result = await service.complete({ courseUrl: course.url }, 'cookie');
  assert.equal(result.total, 5); assert.equal(result.correct, 5); assert.equal(result.concurrency, 3);
  assert.ok(queries.every(query => query.options.skuId === 78));
  assert.ok(submits.every(job => job.classroomId === 12 && job.sign === 'real-course' && job.skuId === 78 && job.body.answer[0] === 'B'));
});
test('failed state queries prevent all submissions instead of assuming unanswered', async () => {
  const { service, submits } = fixture({ queryError: true });
  await assert.rejects(service.complete({ courseUrl: course.url }, 'cookie'), /查询失败，未提交/);
  assert.equal(submits.length, 0);
});
test('already answered questions are skipped and are not reported as failures', async () => {
  const { service, submits } = fixture({ done: true });
  const result = await service.complete({ courseUrl: course.url }, 'cookie');
  assert.equal(result.skipped, 5); assert.equal(result.total, 0); assert.equal(result.failed, 0); assert.equal(submits.length, 0);
});
test('homework runner guards duplicate starts and supports cancellation', async () => {
  let runningSignal;
  const runner = createHomeworkRunner({ sessions: { isConnected: () => true, getCookie: () => 'secret' }, service: { complete: async (input, cookie, { signal }) => {
    assert.equal(input.concurrency, 3); runningSignal = signal;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } });
  runner.startRun({ courseUrl: course.url }); assert.throws(() => runner.startRun({ courseUrl: course.url }), /已有/);
  await new Promise(resolve => setImmediate(resolve)); runner.stopRun(); await runner.waitForIdle();
  assert.equal(runningSignal.aborted, true); assert.equal(runner.getState().status, 'stopped');
});
