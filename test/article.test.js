const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createArticleService } = require('../src/article');
const course = { classroomId: 12, sign: 's', courseSign: 'c', title: '指定课程', url: 'https://www.xuetangx.com/learn/space/s/c/12' };

function fixture({ markResponse, persist = true, leafOverride = {}, locked = false, sleep = async () => {} } = {}) {
  const calls = [], done = new Set([101]);
  const service = createArticleService({ interval: 0, sleep, verificationDelays: [0, 0],
    courseService: { listCourses: async () => [course, { ...course, classroomId: 99 }] }, transport: {
      async get(endpoint) {
        calls.push(endpoint);
        let data;
        if (endpoint.includes('/course/chapter')) data = { course_chapter: [{ children: [{ leaf_list: [
          { id: 101, leaf_type: 3, name: '图文1' }, { id: 102, leaf_type: 3, name: '图文2', is_locked: locked },
          { id: 102, leaf_type: 3, name: '图文2重复引用', is_locked: locked }, { id: 103, leaf_type: 0, name: '视频' }, { id: 104, leaf_type: 6, name: '作业' },
        ] }] }] };
        else if (endpoint.includes('/course/schedule')) data = { leaf_schedules: Object.fromEntries([...done].map(value => [value, 1])) };
        else if (endpoint.includes('/leaf_info/12/')) {
          const leafId = Number(/leaf_info\/12\/(\d+)/.exec(endpoint)[1]);
          data = { id: leafId, classroom_id: '12', leaf_type: 3, sku_id: 78, finish: done.has(leafId), ...leafOverride };
        } else if (endpoint.includes('/user_article_finish/')) {
          if (markResponse) { const response = markResponse(); if (response) return response; }
          if (persist) done.add(Number(/user_article_finish\/(\d+)/.exec(endpoint)[1]));
          data = {};
        } else throw new Error('Unexpected endpoint: ' + endpoint);
        return { status: 200, json: { success: true, data } };
      },
    } });
  return { service, calls, done };
}

test('scan identifies only distinct articles of the selected course and makes no writes', async () => {
  const { service, calls } = fixture();
  const inventory = await service.scanCourse(course.url + '/article/102', 'cookie');
  assert.equal(inventory.total, 2);
  assert.equal(inventory.completed, 1);
  assert.ok(!calls.some(path => path.includes('user_article_finish')));
  await assert.rejects(service.scanCourse(course.url.replace('/12', '/123'), 'cookie'), /已选课程/);
});

test('marks all pending articles serially with the real cid/sid mapping and verifies persistence', async () => {
  const { service, calls } = fixture();
  const result = await service.completeCourse({ courseUrl: course.url }, 'cookie');
  assert.equal(result.total, 2); assert.equal(result.completed, 1); assert.equal(result.skipped, 1); assert.equal(result.failed, 0);
  const writes = calls.filter(path => path.includes('user_article_finish'));
  assert.deepEqual(writes, ['/api/v1/lms/learn/user_article_finish/102/?cid=12&sid=78']);
  assert.ok(calls.at(-1).includes('leaf_info/12/102/'));
  const repeated = await service.completeCourse({ courseUrl: course.url }, 'cookie');
  assert.equal(repeated.skipped, 2);
  assert.equal(calls.filter(path => path.includes('user_article_finish')).length, 1);
});

test('a successful mark response without persisted finish is reported as failure', async () => {
  const { service } = fixture({ persist: false });
  const result = await service.completeCourse({ courseUrl: course.url }, 'cookie');
  assert.equal(result.failed, 1); assert.equal(result.completed, 0);
  assert.match(result.results[1].error, /后端尚未确认/);
});

test('locked, wrong-class and non-article leaves cannot be marked', async () => {
  for (const options of [{ locked: true }, { leafOverride: { classroom_id: 99 } }, { leafOverride: { leaf_type: 0 } }, { leafOverride: { sku_id: 0 } }]) {
    const { service, calls } = fixture(options);
    const result = await service.completeCourse({ courseUrl: course.url }, 'cookie');
    assert.equal(result.failed, 1);
    assert.ok(!calls.some(path => path.includes('user_article_finish')));
  }
});

test('a stale course summary still skips an article whose detail already says finished', async () => {
  const { service, calls } = fixture({ leafOverride: { finish: true } });
  const result = await service.completeCourse({ courseUrl: course.url }, 'cookie');
  assert.equal(result.skipped, 2);
  assert.ok(!calls.some(path => path.includes('user_article_finish')));
});

test('only an explicit 429 is retried and access denials stop the batch', async () => {
  let attempts = 0; const waits = [];
  const limited = fixture({ markResponse: () => ++attempts === 1 ? { status: 429, retryAfter: '2', json: {} } : null, sleep: async ms => waits.push(ms) });
  assert.equal((await limited.service.completeCourse({ courseUrl: course.url }, 'cookie')).completed, 1);
  assert.deepEqual(waits, [3000]);
  const denied = fixture({ markResponse: () => ({ status: 403, json: {} }) });
  const result = await denied.service.completeCourse({ courseUrl: course.url }, 'cookie');
  assert.match(result.stoppedReason, /HTTP 403/);
  assert.equal(denied.calls.filter(path => path.includes('user_article_finish')).length, 1);
});

test('an ambiguous network error never replays the state-changing GET', async () => {
  const { service, calls } = fixture({ markResponse: () => { throw new Error('connection lost'); } });
  assert.equal((await service.completeCourse({ courseUrl: course.url }, 'cookie')).failed, 1);
  assert.equal(calls.filter(path => path.includes('user_article_finish')).length, 1);
});

test('stop prevents the next article from being marked', async () => {
  const { service, calls } = fixture(); const controller = new AbortController();
  await assert.rejects(service.completeCourse({ courseUrl: course.url }, 'cookie', { signal: controller.signal, onProgress: state => {
    if (state.processed === 1) controller.abort();
  } }), { name: 'AbortError' });
  assert.ok(!calls.some(path => path.includes('user_article_finish')));
});
