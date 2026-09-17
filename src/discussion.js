const { concurrency: getConcurrency, workers } = require('./tasks');
const { setTimeout: wait } = require('node:timers/promises');
const http = require('./http');
const courses = require('./video');
const defaultJournal = require('./discussion-journal');
const CONTENT = '1';
function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label}无效`);
  return number;
}
const finished = value => value === 1 || value === '1';

function createDiscussionService({ transport = http, courseService = courses, journal = defaultJournal, sleep = wait, now = Date.now, interval = 1500, maxRetries = 3, verificationDelays = [0, 1000, 2000] } = {}) {
  let nextRequest = 0;
  async function request(method, endpoint, body, cookie, context) {
    for (let attempt = 0; ; attempt++) {
      context.signal?.throwIfAborted();
      const slot = Math.max(now(), nextRequest);
      nextRequest = slot + interval;
      if (slot > now()) await sleep(slot - now(), undefined, { signal: context.signal });
      context.signal?.throwIfAborted();
      const opts = { signal: context.signal, headers: { xtbz: 'xt', Referer: context.courseUrl, 'X-Requested-With': 'XMLHttpRequest' } };
      const response = await (method === 'GET' ? transport.get(endpoint, cookie, opts) : transport.post(endpoint, body, cookie, opts));
      if (response.status === 429 && attempt < maxRetries) {
        const hint = Number(/(\d+(?:\.\d+)?)\s*seconds?/.exec(response.json?.detail || '')?.[1]);
        const header = response.retryAfter;
        const ms = header != null && Number.isFinite(Number(header)) ? Number(header) * 1000
          : header && Number.isFinite(Date.parse(header)) ? Date.parse(header) - now() : Number.isFinite(hint) ? hint * 1000 : 60000;
        const delay = Math.max(1000, ms + 1000);
        context.onProgress({ stage: 'waiting', message: `平台限速，等待 ${Math.ceil(delay / 1000)} 秒后继续` });
        await sleep(delay, undefined, { signal: context.signal }); continue;
      }
      if (response.status !== 200 || response.json?.success !== true) {
        const error = new Error(http.responseError(response, '讨论接口请求'));
        error.stopBatch = [401, 403, 429].includes(response.status);
        error.definitelyRejected = [401, 403, 429].includes(response.status);
        throw error;
      }
      return response.json.data;
    }
  }

  async function scanCourse(courseUrl, cookie, { signal, onProgress = () => {} } = {}) {
    const target = courses.parseCourseUrl(courseUrl);
    const enrolled = await courseService.listCourses(cookie, signal, onProgress);
    const course = enrolled.find(item => item.classroomId === target.classroomId && item.sign === target.sign && item.courseSign === target.courseSign);
    if (!course) throw new Error('指定课程不在当前账号的已选课程中');
    const context = { signal, onProgress, courseUrl: course.url };
    const query = new URLSearchParams({ cid: course.classroomId, sign: course.sign });
    const directory = await request('GET', `/api/v1/lms/learn/course/chapter?${query}`, null, cookie, context);
    if (!Array.isArray(directory?.course_chapter)) throw new Error('无法识别课程目录');
    const found = new Map();
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Number(node.leaf_type) === 4 && node.id) {
        const leafId = positiveId(node.id, '讨论单元 ID');
        found.set(leafId, { leafId, title: node.name || `讨论 ${leafId}`, locked: !!node.is_locked });
      }
      for (const child of Object.values(node)) walk(child);
    }
    walk(directory.course_chapter);
    const schedule = await request('GET', `/api/v1/lms/learn/course/schedule?${query}`, null, cookie, context);
    if (!schedule?.leaf_schedules || typeof schedule.leaf_schedules !== 'object') throw new Error('无法识别课程进度');
    const discussions = [...found.values()].map(item => ({ ...item, completed: finished(schedule.leaf_schedules[item.leafId]) }));
    return { course, discussions, total: discussions.length, completed: discussions.filter(item => item.completed).length };
  }

  async function completeCourse({ courseUrl, concurrency = 1 }, cookie, { signal, onProgress = () => {} } = {}) {
    concurrency = getConcurrency(concurrency);
    const target = courses.parseCourseUrl(courseUrl);
    return journal.withLock(target.classroomId, async () => {
      onProgress({ stage: 'scanning', message: '扫描指定课程的全部讨论题…' });
      const { course, discussions } = await scanCourse(courseUrl, cookie, { signal, onProgress });
      const context = { signal, onProgress, courseUrl: course.url };
      const result = { course, concurrency, content: CONTENT, total: discussions.length, processed: 0, completed: 0, skipped: 0, failed: 0, results: [] };
      const update = extra => onProgress({ ...result, ...extra });
      await workers(discussions, concurrency, async unit => {
        signal?.throwIfAborted();
        update({ stage: 'checking', current: unit.title, message: `处理 ${result.processed + 1}/${result.total}：${unit.title}` });
        const item = { leafId: unit.leafId, title: unit.title };
        try {
          if (unit.completed) { item.status = 'skipped'; result.skipped++; }
          else {
            if (unit.locked) throw new Error('讨论单元尚未开放或被锁定');
            const leaf = await request('GET', `/api/v1/lms/learn/leaf_info/${course.classroomId}/${unit.leafId}/?sign=${encodeURIComponent(course.sign)}`, null, cookie, context);
            if (Number(leaf?.id) !== unit.leafId || Number(leaf.classroom_id) !== course.classroomId || Number(leaf.leaf_type) !== 4) throw new Error('讨论详情与指定课程不匹配');
            if (leaf.is_deleted || leaf.is_locked || leaf.locked_reason || leaf.upgrade_sku_id) throw new Error('当前账号无法访问该讨论');
            const userId = positiveId(leaf.user_id, '当前用户 ID'), skuId = positiveId(leaf.sku_id, 'SKU ID');
            const query = new URLSearchParams({ product_sign: course.sign, leaf_id: unit.leafId, classroom_id: course.classroomId, topic_type: 4, channel: 'xt' });
            const topic = await request('GET', `/api/v1/lms/forum/unit/discussion/?${query}`, null, cookie, context);
            if (Number(topic?.classroom_id) !== course.classroomId || Number(topic.chapter_id) !== unit.leafId) throw new Error('讨论主题与学习单元不匹配');
            const topicId = positiveId(topic.id, '讨论主题 ID'), toUser = positiveId(topic.user_id, '主题作者 ID');
            const count = Number(topic.user_comment_num);
            if (!Number.isInteger(count) || count < 0) throw new Error('无法确认当前账号是否已发表，未重复发布');
            const previous = await journal.get(course.classroomId, userId, unit.leafId);
            let posted = false;
            if (count === 0 && (!previous || previous.state === 'rejected')) {
              const record = { state: 'posting', topicId, content: CONTENT };
              await journal.set(course.classroomId, userId, unit.leafId, record);
              update({ stage: 'posting', current: unit.title, message: `${unit.title}：发布“1”` });
              try {
                const data = await request('POST', `/api/v1/lms/forum/comment/?classroom_id=${course.classroomId}&leaf_id=${unit.leafId}`,
                  { to_user: toUser, topic_id: topicId, content: { text: CONTENT, upload_images: [] } }, cookie, context);
                const commentId = positiveId(data?.data?.id ?? data?.id, '已发布评论 ID');
                await journal.set(course.classroomId, userId, unit.leafId, { ...record, state: 'posted', commentId });
                item.commentId = commentId; posted = true;
              } catch (error) {
                await journal.set(course.classroomId, userId, unit.leafId, { ...record, state: error.definitelyRejected ? 'rejected' : 'unknown' });
                throw error;
              }
            }
            let confirmed = false;
            for (const delay of verificationDelays) {
              signal?.throwIfAborted();
              if (delay) await sleep(delay, undefined, { signal });
              const progress = await request('POST', '/api/v1/lms/learn/chapter/schedule', { leaf_id: unit.leafId, classroom_id: course.classroomId, sku_id: skuId }, cookie, context);
              if (finished(progress?.leaf_schedule)) { confirmed = true; break; }
            }
            if (!confirmed) throw new Error('已发表或上次发布结果待核对，后端尚未确认完成；未重复发帖');
            await journal.set(course.classroomId, userId, unit.leafId, { ...(previous || {}), state: 'complete', topicId, content: CONTENT, ...(item.commentId ? { commentId: item.commentId } : {}) });
            item.status = posted ? 'completed' : 'skipped'; result[posted ? 'completed' : 'skipped']++;
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          item.status = 'failed'; item.error = error.message; result.failed++;
          if (error.stopBatch) result.stoppedReason = error.message;
        }
        result.processed++; result.results.push(item);
        update({ message: `${result.processed}/${result.total} · 新完成 ${result.completed} · 已完成跳过 ${result.skipped} · 失败 ${result.failed}` });
      }, { signal, shouldStop: () => !!result.stoppedReason });
      signal?.throwIfAborted(); return result;
    });
  }
  return { scanCourse, completeCourse };
}
module.exports = { createDiscussionService, ...createDiscussionService() };
