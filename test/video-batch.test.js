const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVideoService } = require('../src/video');
const courseUrl = 'https://www.xuetangx.com/learn/space/s1/c1/1';
const secondCourseUrl = 'https://www.xuetangx.com/learn/space/s2/c2/2';

function batchFixture({ locked = false, limit = false, badDirectory = false } = {}) {
  const writes = [], pages = [], directoryIds = [];
  const done = new Set([101]);
  const service = createVideoService({ sleep: async () => {}, verifyDelays: [0], maxRateLimitRetries: 0, minRequestInterval: 0, transport: {
    async get(path) {
      const url = new URL(path, 'https://www.xuetangx.com');
      let data;
      if (path.includes('user-courses')) {
        const page = Number(url.searchParams.get('page')); pages.push(page);
        data = { pages: 2, count: 2, product_list: [{ classroom_id: page, sign: 's' + page, course_sign: 'c' + page, name: '课程' + page }] };
      } else if (path.includes('/course/chapter')) {
        const cid = Number(url.searchParams.get('cid'));
        directoryIds.push(cid);
        if (badDirectory && cid === 2) return { status: 500, json: {} };
        data = { course_chapter: [{ children: [{ leaf_list: [
          { id: cid * 100 + 1, leaf_type: 0, name: '视频1' },
          { id: cid * 100 + 1, leaf_type: 0, name: '同一个视频的重复目录引用' },
          { id: cid * 100 + 2, leaf_type: 0, name: '视频2', is_locked: locked && cid === 1 },
          { id: cid * 100 + 3, leaf_type: 6, name: '作业' },
        ] }] }] };
      } else if (path.includes('/course/schedule')) {
        data = { leaf_schedules: Object.fromEntries([...done].map(id => [id, 1])) };
      } else if (path.includes('/leaf_info/')) {
        const [, cid, leaf] = /leaf_info\/(\d+)\/(\d+)/.exec(path);
        data = { id: Number(leaf), classroom_id: Number(cid), course_id: Number(cid) + 10, user_id: 99, sku_id: Number(cid) + 20, leaf_type: 0,
          name: '视频' + leaf, content_info: { media: { ccid: 'cc-' + leaf, type: 'video', duration: 12 } } };
      } else if (path.includes('get_video_watch_progress')) {
        const id = Number(url.searchParams.get('video_id'));
        return { status: 200, json: { code: 0, data: { [id]: { completed: done.has(id) ? 1 : 0, rate: done.has(id) ? 1 : 0, video_length: 12 } } } };
      } else if (path.includes('playurl')) data = { duration: 12 };
      else throw new Error('Unexpected path: ' + path);
      return { status: 200, json: { success: true, data } };
    },
    async post(path, body) {
      writes.push(body);
      if (limit) return { status: 429, json: {} };
      done.add(body.heart_data[0].v);
      return { status: 200, json: {} };
    },
  } });
  return { service, writes, pages, directoryIds };
}

test('finds enrolled courses across pages but scans only the chosen course', async () => {
  const { service, writes, pages, directoryIds } = batchFixture();
  const inventory = await service.scanCourse(courseUrl, 'cookie');
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(directoryIds, [1]);
  assert.equal(inventory.course.classroomId, 1);
  assert.equal(inventory.totalVideos, 2);
  assert.equal(writes.length, 0);
});

test('one call completes the chosen course, skips completed videos and never writes another course', async () => {
  const { service, writes } = batchFixture();
  let peak = 0;
  const result = await service.completeCourse({ courseUrl }, 'cookie', { onProgress: state => { peak = Math.max(peak, state.activeVideos?.length || 0); } });
  assert.equal(peak, 1);
  assert.equal(result.processedVideos, 2);
  assert.equal(result.completedVideos, 1);
  assert.equal(result.skippedVideos, 1);
  assert.equal(result.failedVideos, 0);
  assert.equal(writes.length, 1);
  assert.ok(writes.flatMap(body => body.heart_data).every(event => event.classroomid === '1'));
  assert.ok(result.results.every(item => item.completed));
  const repeated = await service.completeCourse({ courseUrl }, 'cookie');
  assert.equal(repeated.skippedVideos, 2);
  assert.equal(writes.length, 1);
});

test('locked videos are reported as failures, never counted as completed skips', async () => {
  const { service, writes } = batchFixture({ locked: true });
  const result = await service.completeCourse({ courseUrl }, 'cookie');
  assert.equal(result.failedVideos, 1);
  assert.equal(result.skippedVideos, 1);
  assert.equal(writes.length, 0);
});

test('invalid selection and inaccessible directories fail without any writes', async () => {
  const { service, writes } = batchFixture({ badDirectory: true });
  await assert.rejects(service.completeCourse({ courseUrl: secondCourseUrl }, 'cookie'), /查询课程目录失败/);
  await assert.rejects(service.completeCourse({ courseUrl: courseUrl.replace('/1', '/3') }, 'cookie'), /已选课程/);
  assert.equal(writes.length, 0);
});

test('rate limiting stops the remaining batch instead of hammering other videos', async () => {
  const { service, writes } = batchFixture({ limit: true });
  const result = await service.completeCourse({ courseUrl }, 'cookie');
  assert.equal(writes.length, 1);
  assert.equal(result.processedVideos, 2);
  assert.match(result.stoppedReason, /限速/);
});

test('stopping after a video prevents all later videos from being submitted', async () => {
  const { service, writes } = batchFixture();
  const controller = new AbortController();
  await assert.rejects(service.completeCourse({ courseUrl: secondCourseUrl, concurrency: 1 }, 'cookie', { signal: controller.signal, onProgress: state => {
    if (state.processedVideos === 1) controller.abort();
  } }), { name: 'AbortError' });
  assert.equal(writes.length, 1);
});

test('video concurrency is bounded and processes only the selected course', async () => {
  const { service, writes } = batchFixture();
  let peak = 0;
  const result = await service.completeCourse({ courseUrl: secondCourseUrl, concurrency: 2 }, 'cookie', {
    onProgress: state => { peak = Math.max(peak, state.activeVideos?.length || 0); },
  });
  assert.equal(peak, 2);
  assert.equal(result.completedVideos, 2);
  assert.ok(writes.flatMap(body => body.heart_data).every(event => event.classroomid === '2'));
  await assert.rejects(service.completeCourse({ courseUrl, concurrency: 4 }, 'cookie'), /并发数/);
});
