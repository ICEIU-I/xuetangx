const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDiscussionService } = require('../src/discussion');
const { createDiscussionJournal } = require('../src/discussion-journal');
const course = { classroomId: 12, sign: 's', courseSign: 'c', title: '课程', url: 'https://www.xuetangx.com/learn/space/s/c/12' };

function fixture({ persist = true, ownComments = 0, topicOverride = {}, leafOverride = {}, publish, sleep = async () => {} } = {}) {
  const calls = [], posted = [], done = new Set([101]), records = new Map();
  let ownCount = ownComments;
  const journal = { withLock: async (id, fn) => fn(), get: async (cid, uid, lid) => records.get(`${cid}:${uid}:${lid}`), set: async (cid, uid, lid, value) => records.set(`${cid}:${uid}:${lid}`, value) };
  const service = createDiscussionService({ interval: 0, sleep, verificationDelays: [0, 0], journal,
    courseService: { listCourses: async () => [course] }, transport: {
      async get(endpoint) {
        calls.push(endpoint); let data;
        if (endpoint.includes('/course/chapter')) data = { course_chapter: [{ children: [
          { id: 101, leaf_type: 4, name: '讨论1' }, { id: 102, leaf_type: 4, name: '讨论2' }, { id: 102, leaf_type: 4, name: '重复引用' },
          { id: 103, leaf_type: 0, name: '视频评论区' }, { id: 104, leaf_type: 3, name: '图文评论区' },
        ] }] };
        else if (endpoint.includes('/course/schedule')) data = { leaf_schedules: Object.fromEntries([...done].map(id => [id, 1])) };
        else if (endpoint.includes('/leaf_info/12/102/')) data = { id: 102, classroom_id: 12, leaf_type: 4, sku_id: 78, user_id: 99, ...leafOverride };
        else if (endpoint.includes('/forum/unit/discussion/')) data = { id: 1102, classroom_id: 12, chapter_id: 102, user_id: 77, user_comment_num: ownCount, commented: 500, ...topicOverride };
        else throw Error('Unexpected endpoint: ' + endpoint);
        return { status: 200, json: { success: true, data } };
      },
      async post(endpoint, body) {
        calls.push(endpoint);
        if (endpoint.includes('/forum/comment/')) {
          posted.push({ endpoint, body });
          const response = publish?.(); if (response) return response;
          ownCount++;
          if (persist) done.add(102);
          return { status: 200, json: { success: true, data: { data: { id: 9001 } } } };
        }
        assert.equal(endpoint, '/api/v1/lms/learn/chapter/schedule');
        assert.deepEqual(body, { leaf_id: 102, classroom_id: 12, sku_id: 78 });
        return { status: 200, json: { success: true, data: { leaf_schedule: done.has(102) ? 1 : 0 } } };
      },
    } });
  return { service, calls, posted, done, records };
}

test('scans only selected-course discussion units, excluding video and article comment areas', async () => {
  const { service, calls, posted } = fixture();
  const scan = await service.scanCourse(course.url + '/discussion/102', 'cookie');
  assert.equal(scan.total, 2); assert.equal(scan.completed, 1); assert.equal(posted.length, 0);
  const length = calls.length;
  await assert.rejects(service.scanCourse(course.url.replace('/12', '/99'), 'cookie'), /已选课程/);
  assert.equal(calls.length, length);
});

test('posts exactly one 1 to each incomplete unit, uses the topic author and verifies progress', async () => {
  const { service, posted, records } = fixture();
  const result = await service.completeCourse({ courseUrl: course.url }, 'cookie');
  assert.equal(result.completed, 1); assert.equal(result.skipped, 1); assert.equal(result.failed, 0);
  assert.deepEqual(posted, [{ endpoint: '/api/v1/lms/forum/comment/?classroom_id=12&leaf_id=102',
    body: { to_user: 77, topic_id: 1102, content: { text: '1', upload_images: [] } } }]);
  assert.equal(records.get('12:99:102').state, 'complete');
  assert.equal((await service.completeCourse({ courseUrl: course.url }, 'cookie')).skipped, 2);
  assert.equal(posted.length, 1);
});

test('existing own comments prevent duplicate posts even while completion is still pending', async () => {
  const { service, posted } = fixture({ ownComments: 1, persist: false });
  const result = await service.completeCourse({ courseUrl: course.url }, 'cookie');
  assert.equal(posted.length, 0); assert.equal(result.failed, 1);
  assert.match(result.results[1].error, /未重复发帖/);
});

test('HTTP 200 publication without completion remains partial and is not posted again', async () => {
  const { service, posted } = fixture({ persist: false });
  assert.equal((await service.completeCourse({ courseUrl: course.url }, 'cookie')).failed, 1);
  assert.equal((await service.completeCourse({ courseUrl: course.url }, 'cookie')).failed, 1);
  assert.equal(posted.length, 1);
});

test('unknown publication outcomes persist in the journal and suppress retries across runs', async () => {
  const { service, posted, records } = fixture({ publish: () => { throw Error('connection lost'); } });
  await service.completeCourse({ courseUrl: course.url }, 'cookie');
  assert.equal(records.get('12:99:102').state, 'unknown');
  await service.completeCourse({ courseUrl: course.url }, 'cookie');
  assert.equal(posted.length, 1);
});

test('mismatched topic/classroom and unavailable own-comment counts cannot produce posts', async () => {
  for (const options of [{ topicOverride: { chapter_id: 999 } }, { topicOverride: { classroom_id: 99 } }, { topicOverride: { user_comment_num: undefined } }, { leafOverride: { leaf_type: 3 } }, { leafOverride: { is_locked: true } }]) {
    const { service, posted } = fixture(options);
    assert.equal((await service.completeCourse({ courseUrl: course.url }, 'cookie')).failed, 1);
    assert.equal(posted.length, 0);
  }
});

test('explicit 429 waits before retrying the rejected publication', async () => {
  let attempts = 0; const waits = [];
  const { service, posted } = fixture({ publish: () => ++attempts === 1 ? { status: 429, retryAfter: '2' } : null, sleep: async ms => waits.push(ms) });
  assert.equal((await service.completeCourse({ courseUrl: course.url }, 'cookie')).completed, 1);
  assert.equal(posted.length, 2); assert.deepEqual(waits, [3000]);
});

test('stop prevents the next discussion from being posted', async () => {
  const { service, posted } = fixture(); const controller = new AbortController();
  await assert.rejects(service.completeCourse({ courseUrl: course.url }, 'cookie', { signal: controller.signal, onProgress: state => {
    if (state.processed === 1) controller.abort();
  } }), { name: 'AbortError' });
  assert.equal(posted.length, 0);
});

test('discussion journal is atomic, persistent and isolated by course and account', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'discussion-journal-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = createDiscussionJournal(directory);
  await journal.withLock(12, async () => {
    await assert.rejects(journal.withLock(12, async () => {}), /已有/);
    await journal.set(12, 99, 102, { state: 'posted', commentId: 9001 });
  });
  assert.equal((await createDiscussionJournal(directory).get(12, 99, 102)).commentId, 9001);
  assert.equal(await journal.get(12, 100, 102), undefined);
  assert.equal(await journal.get(13, 99, 102), undefined);
});
