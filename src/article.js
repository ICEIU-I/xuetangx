const { setTimeout: wait } = require('node:timers/promises');
const http = require('./http');
const courses = require('./video');

function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label}无效`);
  return number;
}
const finished = value => value === true || value === 1 || value === '1';

function createArticleService({ transport = http, courseService = courses, sleep = wait, now = Date.now, interval = 1500, maxRetries = 3, verificationDelays = [0, 1000, 2000] } = {}) {
  let nextRequest = 0;
  async function get(endpoint, cookie, context) {
    for (let attempt = 0; ; attempt++) {
      context.signal?.throwIfAborted();
      if (nextRequest > now()) await sleep(nextRequest - now(), undefined, { signal: context.signal });
      context.signal?.throwIfAborted();
      nextRequest = now() + interval;
      const response = await transport.get(endpoint, cookie, { signal: context.signal,
        headers: { xtbz: 'xt', Referer: context.courseUrl, 'X-Requested-With': 'XMLHttpRequest' } });
      if (response.status === 429 && attempt < maxRetries) {
        const hint = Number(/(\d+(?:\.\d+)?)\s*seconds?/.exec(response.json?.detail || '')?.[1]);
        const header = response.retryAfter;
        const milliseconds = header != null && Number.isFinite(Number(header)) ? Number(header) * 1000
          : header && Number.isFinite(Date.parse(header)) ? Date.parse(header) - now() : Number.isFinite(hint) ? hint * 1000 : 60000;
        const delay = Math.max(1000, milliseconds + 1000);
        context.onProgress({ stage: 'waiting', message: `平台限速，等待 ${Math.ceil(delay / 1000)} 秒后继续` });
        await sleep(delay, undefined, { signal: context.signal });
        continue;
      }
      if (response.status !== 200 || response.json?.success !== true) {
        const error = new Error(`图文接口请求失败（HTTP ${response.status}）`);
        error.stopBatch = [401, 403, 429].includes(response.status);
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
    const directory = await get(`/api/v1/lms/learn/course/chapter?${query}`, cookie, context);
    if (!Array.isArray(directory?.course_chapter)) throw new Error('无法识别课程目录');
    const found = new Map();
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Number(node.leaf_type) === 3 && node.id) {
        const leafId = positiveId(node.id, '图文 ID');
        found.set(leafId, { leafId, title: node.name || `图文 ${leafId}`, locked: !!node.is_locked });
      }
      for (const child of Object.values(node)) walk(child);
    }
    walk(directory.course_chapter);
    const schedule = await get(`/api/v1/lms/learn/course/schedule?${query}`, cookie, context);
    if (!schedule?.leaf_schedules || typeof schedule.leaf_schedules !== 'object') throw new Error('无法识别课程进度');
    const articles = [...found.values()].map(item => ({ ...item, completed: finished(schedule.leaf_schedules[item.leafId]) }));
    return { course, articles, total: articles.length, completed: articles.filter(item => item.completed).length };
  }

  async function readLeaf(course, article, cookie, context) {
    const leaf = await get(`/api/v1/lms/learn/leaf_info/${course.classroomId}/${article.leafId}/?sign=${encodeURIComponent(course.sign)}`, cookie, context);
    if (Number(leaf?.id) !== article.leafId || Number(leaf.classroom_id) !== course.classroomId || Number(leaf.leaf_type) !== 3) throw new Error('图文详情与选定课程不匹配');
    if (leaf.is_deleted || leaf.is_locked || leaf.locked_reason || leaf.upgrade_sku_id) throw new Error('该图文未开放或当前账号无访问权限');
    return leaf;
  }

  async function completeCourse({ courseUrl }, cookie, { signal, onProgress = () => {} } = {}) {
    onProgress({ stage: 'scanning', message: '扫描选定课程的全部图文…' });
    const inventory = await scanCourse(courseUrl, cookie, { signal, onProgress });
    const { course, articles } = inventory;
    const context = { signal, onProgress, courseUrl: course.url };
    const result = { course, total: articles.length, processed: 0, completed: 0, skipped: 0, failed: 0, results: [] };
    const update = extra => onProgress({ ...result, ...extra });
    for (const article of articles) {
      signal?.throwIfAborted();
      update({ stage: 'marking', current: article.title, message: `处理 ${result.processed + 1}/${result.total}：${article.title}` });
      const item = { leafId: article.leafId, title: article.title };
      try {
        let alreadyCompleted = article.completed;
        if (!alreadyCompleted) {
          if (article.locked) throw new Error('该图文尚未开放或被锁定');
          const leaf = await readLeaf(course, article, cookie, context);
          alreadyCompleted = finished(leaf.finish);
          if (!alreadyCompleted) {
            const query = new URLSearchParams({ cid: course.classroomId, sid: positiveId(leaf.sku_id, 'SKU ID') });
            // 虽然使用 GET，这个接口会修改进度；仅在明确收到 429 时重试。
            await get(`/api/v1/lms/learn/user_article_finish/${article.leafId}/?${query}`, cookie, context);
            let confirmed = false;
            for (const delay of verificationDelays) {
              signal?.throwIfAborted();
              if (delay) await sleep(delay, undefined, { signal });
              if (finished((await readLeaf(course, article, cookie, context)).finish)) { confirmed = true; break; }
            }
            if (!confirmed) throw new Error('标记请求已发送，但后端尚未确认已看完');
          }
        }
        item.status = alreadyCompleted ? 'skipped' : 'completed';
        result[alreadyCompleted ? 'skipped' : 'completed']++;
      } catch (error) {
        if (signal?.aborted) throw error;
        item.status = 'failed'; item.error = error.message; result.failed++;
        if (error.stopBatch) result.stoppedReason = error.message;
      }
      result.processed++; result.results.push(item);
      update({ message: `${result.processed}/${result.total} · 新标记 ${result.completed} · 已完成跳过 ${result.skipped} · 失败 ${result.failed}` });
      if (result.stoppedReason) break;
    }
    signal?.throwIfAborted();
    return result;
  }
  return { scanCourse, completeCourse };
}

module.exports = { createArticleService, ...createArticleService() };
