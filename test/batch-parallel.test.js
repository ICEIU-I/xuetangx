const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createArticleService } = require('../src/article');
const { createDiscussionService } = require('../src/discussion');
const { createDiscussionJournal } = require('../src/discussion-journal');
const { createAnswerService } = require('../src/answer-bank');
const { createAnswerStore } = require('../src/answer-store');
const course = { classroomId: 12, sign: 's', courseSign: 'c', url: 'https://www.xuetangx.com/learn/space/s/c/12' };

for (const kind of ['article', 'discussion', 'answers']) test(`${kind} defaults to serial units and preserves every result`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-units-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const type = { article: 3, discussion: 4, answers: 6 }[kind];
  let active = 0, peak = 0;
  const done = new Set();
  const journal = createDiscussionJournal(path.join(root, 'journal'));
  const store = createAnswerStore(path.join(root, 'answers'));
  const unitIds = [101, 102, 103, 104, 105, 106];
  const response = data => ({ status: 200, json: { success: true, data } });
  const transport = {
    async get(endpoint) {
      if (endpoint.includes('/course/chapter')) return response({ course_chapter: unitIds.map(id => ({ id, leaf_type: type, name: '单元' + id })) });
      if (endpoint.includes('/course/schedule')) return response({ leaf_schedules: {} });
      if (endpoint.includes('/leaf_info/')) {
        const id = Number(/leaf_info\/12\/(\d+)/.exec(endpoint)[1]);
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve)); active--;
        return response({ id, classroom_id: 12, leaf_type: type, user_id: 99, sku_id: 78, finish: done.has(id), content_info: { leaf_type_id: id + 1000 } });
      }
      if (endpoint.includes('/user_article_finish/')) { done.add(Number(/finish\/(\d+)/.exec(endpoint)[1])); return response({}); }
      if (endpoint.includes('/forum/unit/discussion/')) {
        const id = Number(new URL(endpoint, 'https://x.test').searchParams.get('leaf_id'));
        return response({ id: id + 1000, chapter_id: id, classroom_id: 12, user_id: 77, user_comment_num: 0 });
      }
      if (endpoint.includes('/get_exercise_list/')) {
        const id = Number(/get_exercise_list\/(\d+)/.exec(endpoint)[1]);
        return response({ problems: [{ problem_id: id, index: 1, content: { Type: 'SingleChoice', Options: [{ key: 'A' }, { key: 'B' }] }, user: { is_show_answer: true, answer: ['B'], my_count: 1 } }] });
      }
      throw Error('Unexpected GET: ' + endpoint);
    },
    async post(endpoint, body) {
      if (endpoint.includes('/forum/comment/')) {
        const leafId = Number(new URL(endpoint, 'https://x.test').searchParams.get('leaf_id')); done.add(leafId);
        return response({ data: { id: leafId + 2000 } });
      }
      return response({ leaf_schedule: done.has(body.leaf_id) ? 1 : 0 });
    },
  };
  const options = { transport, courseService: { listCourses: async () => [course] }, sleep: async () => {}, interval: 0, verificationDelays: [0] };
  let result;
  if (kind === 'article') result = await createArticleService(options).completeCourse({ courseUrl: course.url }, 'cookie');
  if (kind === 'discussion') result = await createDiscussionService({ ...options, journal }).completeCourse({ courseUrl: course.url }, 'cookie');
  if (kind === 'answers') result = await createAnswerService({ transport, courses: options.courseService, store, sleep: async () => {}, requestInterval: 0 }).collect({ courseUrl: course.url }, 'cookie');
  assert.equal(peak, 1);
  if (kind === 'answers') {
    const saved = await store.read(12);
    assert.equal(result.capturedAnswers, 6);
    assert.equal(saved.lastRun.capturedAnswers, 6);
    assert.ok(Object.values(saved.exercises).every(exercise => exercise.questions[0].answer === 'B'));
  } else {
    assert.equal(result.completed, 6); assert.equal(result.failed, 0);
    if (kind === 'discussion') for (const id of unitIds) assert.equal((await journal.get(12, 99, id)).state, 'complete');
  }
});
