const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../src/http');
const api = require('../src/api');

test('exercise API applies explicit SKU/class/sign and treats denied queries as failures', async t => {
  const paths = [], payloads = [];
  t.mock.method(http, 'get', async path => { paths.push(path); return { status: 200, json: { success: false, msg: 'you did not buy this product' } }; });
  t.mock.method(http, 'post', async (path, body) => { payloads.push(body); return { status: 200, json: { success: true, data: { is_correct: true } } }; });
  const query = await api.getProblems(100, 'cookie', { skuId: 555 });
  assert.equal(Array.isArray(query), false); assert.match(query.error, /did not buy/);
  assert.equal(paths[0], '/api/v1/lms/exercise/get_exercise_list/100/555/');
  await api.submit({ leafId: 34, exerciseId: 100, problemId: 6, classroomId: 12, sign: 'selected-course', body: { answer: ['B'], answers: {} } }, 'cookie');
  assert.equal(payloads[0].classroom_id, 12); assert.equal(payloads[0].sign, 'selected-course');
});
