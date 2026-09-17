// 视频元数据、进度上报与后端回查。所有标识从当前账号可访问的视频详情获取。
const { randomUUID } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const http = require('./http');

const MAX_DURATION = 24 * 60 * 60;
const BATCH_SIZE = 50;

function positiveId(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} 无效`);
  return number;
}

function parseCourseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请粘贴完整的学堂在线视频学习页链接'); }
  if (url.protocol !== 'https:' || !['www.xuetangx.com', 'xuetangx.com'].includes(url.hostname)
    || url.port || url.username || url.password) throw new Error('仅支持学堂在线 HTTPS 视频学习页链接');
  const match = /^\/learn\/space\/([^/]+)\/([^/]+)\/(\d+)(?:\/(?:video|article|exercise|exam)\/\d+)?\/?$/.exec(url.pathname);
  if (!match) throw new Error('请使用 /learn/space/…/班级ID 开头的课程或视频学习页链接');
  return {
    url: `https://www.xuetangx.com/learn/space/${match[1]}/${match[2]}/${match[3]}`,
    sign: decodeURIComponent(match[1]), courseSign: decodeURIComponent(match[2]), classroomId: positiveId(match[3], '班级 ID'),
  };
}

function parseVideoUrl(value) {
  const course = parseCourseUrl(value);
  const match = /\/video\/(\d+)\/?$/.exec(new URL(value).pathname);
  if (!match) throw new Error('视频链接应包含 /video/视频ID');
  const leafId = positiveId(match[1], '视频 ID');
  return { url: `${course.url}/video/${leafId}`, sign: course.sign, classroomId: course.classroomId, leafId };
}

function responseJson(response, label) {
  if ([401, 403, 429].includes(response.status)) {
    const error = new Error(response.status === 429 ? `${label}遇到限速，请稍后重试` : response.status === 403
      ? `${label}被平台拒绝（HTTP 403），可能是访问限制，请稍后重试或在官网检查`
      : `${label}失败：登录态失效，请重新连接`);
    error.stopBatch = true;
    throw error;
  }
  const data = response.json;
  if (response.status !== 200 || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label}失败（HTTP ${response.status}）`);
  }
  if (data.success === false || (data.code != null && ![0, '0'].includes(data.code))) {
    throw new Error(`${label}被平台拒绝${data.code != null ? `（code ${data.code}）` : ''}，请在课程页面检查访问状态`);
  }
  return data;
}

function progressFrom(data, leafId) {
  const record = data[leafId] ?? data.data?.[leafId];
  if (!record) return { rate: 0, completed: false, watchLength: 0, lastPoint: 0, videoLength: 0 };
  const number = key => {
    const value = Number(record[key] ?? 0);
    if (!Number.isFinite(value) || value < 0) throw new Error(`平台进度字段 ${key} 无效`);
    return value;
  };
  return {
    rate: Math.min(1, number('rate')), completed: record.completed === true || Number(record.completed) === 1,
    watchLength: number('watch_length'), lastPoint: number('last_point'), videoLength: number('video_length'),
  };
}

function validateDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION) {
    throw new Error('无法确定视频时长，请填写播放器显示的总时长（秒，最多 86400）');
  }
  return Math.ceil(duration);
}

function createVideoService({ transport = http, sleep = wait, now = Date.now, pageId = () => randomUUID().slice(0, 8), batchDelay = 300, verifyDelays = [0, 1000, 2000, 4000, 6000], maxRateLimitRetries = 3, minRequestInterval = 750 } = {}) {
  const options = (url, signal, onProgress) => ({ signal, onRateLimit: ms => onProgress?.({ stage: 'waiting', message: `平台限速，等待 ${Math.ceil(ms / 1000)} 秒后自动继续…` }),
    headers: { xtbz: 'xt', 'X-Requested-With': 'XMLHttpRequest', Referer: url } });

  let rateLimitUntil = 0;
  let nextRequestAt = 0;
  async function request(method, path, body, cookie, opts) {
    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      for (;;) {
        let remaining;
        while ((remaining = rateLimitUntil - now()) > 0) {
          opts.onRateLimit?.(remaining);
          await sleep(remaining, undefined, { signal: opts.signal });
          opts.signal?.throwIfAborted();
        }
        const slot = Math.max(now(), nextRequestAt);
        nextRequestAt = slot + minRequestInterval;
        if (slot > now()) await sleep(slot - now(), undefined, { signal: opts.signal });
        opts.signal?.throwIfAborted();
        if (rateLimitUntil <= now()) break;
      }
      const response = await (method === 'get' ? transport[method](path, cookie, opts) : transport[method](path, body, cookie, opts));
      // 仅重试明确被拒绝的 429；网络中断或其他响应不重放写请求。
      if (response.status !== 429 || attempt >= maxRateLimitRetries) return response;
      const header = response.retryAfter;
      const detail = String(response.json?.detail || response.json?.msg || '').match(/(\d+(?:\.\d+)?)\s*(?:seconds?|秒)/i);
      let ms = 60000;
      if (header != null && Number.isFinite(Number(header))) ms = Number(header) * 1000 + 1000;
      else if (header && Number.isFinite(Date.parse(header))) ms = Date.parse(header) - now() + 1000;
      else if (detail) ms = Number(detail[1]) * 1000 + 1000;
      ms = Math.max(1000, Math.ceil(ms));
      rateLimitUntil = Math.max(rateLimitUntil, now() + ms);
    }
  }
  const get = (path, cookie, opts) => request('get', path, null, cookie, opts);
  const post = (path, body, cookie, opts) => request('post', path, body, cookie, opts);

  async function getProgress(video, cookie, signal, onProgress) {
    const query = new URLSearchParams({ cid: video.courseId, user_id: video.userId,
      classroom_id: video.classroomId, video_type: 'video', vtype: 'rate', video_id: video.leafId });
    return progressFrom(responseJson(await get(`/video-log/get_video_watch_progress/?${query}`, cookie,
      options(video.url, signal, onProgress)), '查询视频进度'), video.leafId);
  }

  async function inspect(url, cookie, { signal, onProgress } = {}) {
    signal?.throwIfAborted();
    const target = parseVideoUrl(url);
    const response = responseJson(await get(`/api/v1/lms/learn/leaf_info/${target.classroomId}/${target.leafId}/?sign=${encodeURIComponent(target.sign)}`, cookie,
      options(target.url, signal, onProgress)), '查询视频详情');
    const leaf = response.data;
    if (!leaf || Number(leaf.id) !== target.leafId || Number(leaf.classroom_id) !== target.classroomId) {
      throw new Error('平台返回的视频或班级与链接不匹配');
    }
    if (leaf.is_deleted || leaf.is_locked || leaf.locked_reason || leaf.upgrade_sku_id) throw new Error('当前账号无法访问该视频，请先在课程页面确认');
    const media = leaf.content_info?.media;
    if (Number(leaf.leaf_type) !== 0 || !media?.ccid || (media.type && media.type !== 'video')) throw new Error('该学习单元不是受支持的点播视频');
    const video = { ...target, title: leaf.name || `视频 ${target.leafId}`, courseId: positiveId(leaf.course_id, '课程 ID'),
      userId: positiveId(leaf.user_id, '用户 ID'), skuId: positiveId(leaf.sku_id, 'SKU ID'), cc: String(media.ccid) };
    const progress = await getProgress(video, cookie, signal, onProgress);
    let playback = null;
    if (!progress.completed) {
      playback = responseJson(await get(`/api/v1/lms/service/playurl/${encodeURIComponent(video.cc)}/?appid=10000`, cookie,
        options(video.url, signal, onProgress)), '查询视频播放信息').data;
      const sources = playback?.sources || playback?.m3u8?.sources || {};
      const source = Object.entries(sources).filter(([key]) => key.startsWith('quality')).flatMap(([, value]) => value).find(value => typeof value === 'string' && /^https?:\/\//.test(value));
      if (source) video.cdnHost = new URL(source).hostname;
    }
    const duration = progress.videoLength || Number(media.duration) || Number(playback?.duration) || Number(playback?.m3u8?.duration) || 0;
    return { video, progress, durationSeconds: duration > 0 && duration <= MAX_DURATION ? duration : null };
  }

  async function complete({ url, durationSeconds }, cookie, { signal, onProgress = () => {} } = {}) {
    onProgress({ stage: 'loading', message: '查询视频详情与后端进度…', sent: 0, total: 0 });
    const initial = await inspect(url, cookie, { signal, onProgress });
    const { video, progress: before } = initial;
    if (before.completed) return { ...initial, before, alreadyCompleted: true, batchesSent: 0 };
    const duration = validateDuration(initial.durationSeconds || durationSeconds);
    const total = Math.ceil(duration / 5) + 4;
    const base = { i: 5, p: 'web', n: video.cdnHost || 'other', lob: 'plat2', fp: 0, tp: 0, sp: 1,
      u: video.userId, uip: '', c: video.courseId, v: video.leafId, skuid: video.skuId,
      classroomid: String(video.classroomId), cc: video.cc, d: duration,
      pg: `${video.leafId}_${pageId()}`, t: 'video', cards_id: 0, slide: 0, v_url: '' };
    let sequence = 0, timestamp = 0, sent = 0, batchesSent = 0;
    function event(et, cp) {
      timestamp = Math.max(now(), timestamp + 1);
      return { ...base, et, cp, ts: String(timestamp), sq: ++sequence };
    }
    // 覆盖完整时间轴，避免把拖动留下的 last_point 误认为连续已看区间。
    function* events() {
      for (const type of ['loadstart', 'loadeddata', 'play', 'playing']) yield event(type, 0);
      for (let cp = 5; cp < duration; cp += 5) yield event('heartbeat', cp);
      yield event('videoend', duration);
    }
    let batch = [];
    async function sendBatch() {
      signal?.throwIfAborted();
      responseJson(await post('/video-log/heartbeat/', { heart_data: batch }, cookie, options(video.url, signal, onProgress)), '上报视频进度');
      sent += batch.length;
      batchesSent++;
      onProgress({ stage: 'sending', message: `已发送 ${sent}/${total} 条记录`, sent, total, title: video.title });
      batch = [];
    }
    for (const item of events()) {
      batch.push(item);
      if (batch.length === BATCH_SIZE) {
        await sendBatch();
        if (sent < total) await sleep(batchDelay, undefined, { signal });
      }
    }
    if (batch.length) await sendBatch();
    onProgress({ stage: 'verifying', message: '上报结束，等待后端确认完成状态…', sent, total });
    let progress;
    for (const ms of verifyDelays) {
      signal?.throwIfAborted();
      if (ms) await sleep(ms, undefined, { signal });
      progress = await getProgress(video, cookie, signal, onProgress);
      if (progress.completed) return { video, before, progress, durationSeconds: duration, alreadyCompleted: false, batchesSent };
    }
    throw new Error(`上报已发送，但后端尚未确认完成（当前 ${((progress?.rate || 0) * 100).toFixed(2)}%）。请刷新进度，勿将发送成功当作完成`);
  }

  async function listCourses(cookie, signal, onProgress) {
    const courses = new Map();
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      signal?.throwIfAborted();
      const data = responseJson(await get(`/api/v1/lms/user/user-courses/?status=1&page=${page}`, cookie,
        options('https://www.xuetangx.com/mine', signal, onProgress)), '查询课程列表').data;
      if (!Array.isArray(data?.product_list)) throw new Error('平台课程列表格式发生变化');
      pages = Number(data.pages ?? 1);
      if (!Number.isInteger(pages) || pages < 0 || pages > 100) throw new Error('平台课程分页信息无效');
      if (!data.product_list.length && page < pages) throw new Error('平台返回了不完整的课程列表');
      for (const item of data.product_list) {
        const classroomId = positiveId(item.classroom_id, '班级 ID');
        if (!item.sign || !item.course_sign) throw new Error('课程缺少学习链接标识');
        courses.set(classroomId, { classroomId, sign: String(item.sign), courseSign: String(item.course_sign), title: item.name || `课程 ${classroomId}`,
          url: `https://www.xuetangx.com/learn/space/${encodeURIComponent(item.sign)}/${encodeURIComponent(item.course_sign)}/${classroomId}` });
      }
    }
    return [...courses.values()];
  }

  async function scanCourse(courseUrl, cookie, { signal, onProgress = () => {} } = {}) {
    const target = parseCourseUrl(courseUrl);
    onProgress({ stage: 'discovering', message: '查询指定已选课程…' });
    const enrolled = await listCourses(cookie, signal, onProgress);
    const course = enrolled.find(item => item.classroomId === target.classroomId && item.sign === target.sign && item.courseSign === target.courseSign);
    if (!course) throw new Error('指定课程不在当前账号正在上课的已选课程中');
    signal?.throwIfAborted();
    onProgress({ stage: 'discovering', message: `读取课程目录：${course.title}`, currentCourse: course.title });
    const query = new URLSearchParams({ cid: course.classroomId, sign: course.sign });
    const data = responseJson(await get(`/api/v1/lms/learn/course/chapter?${query}`, cookie,
      options('https://www.xuetangx.com/mine', signal, onProgress)), '查询课程目录').data;
    if (!Array.isArray(data?.course_chapter)) throw new Error('平台课程目录格式发生变化');
    const found = new Map();
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.leaf_type != null && Number(node.leaf_type) === 0 && node.id) {
        const leafId = positiveId(node.id, '视频 ID');
        found.set(leafId, { leafId, title: node.name || `视频 ${leafId}`, locked: !!node.is_locked,
          url: `https://www.xuetangx.com/learn/space/${encodeURIComponent(course.sign)}/${encodeURIComponent(course.courseSign)}/${course.classroomId}/video/${leafId}` });
      }
      for (const child of Object.values(node)) if (child && typeof child === 'object') visit(child);
    }
    visit(data.course_chapter);
    course.videos = [...found.values()];
    const schedule = responseJson(await get(`/api/v1/lms/learn/course/schedule?${query}`, cookie,
      options(course.url, signal, onProgress)), '查询课程进度').data;
    if (!schedule?.leaf_schedules || typeof schedule.leaf_schedules !== 'object') throw new Error('平台课程进度格式发生变化');
    for (const video of course.videos) video.completed = Number(schedule.leaf_schedules[video.leafId]) === 1;
    return { course, totalVideos: course.videos.length };
  }

  async function completeCourse({ courseUrl, concurrency = 1 }, cookie, { signal, onProgress = () => {} } = {}) {
    concurrency = Number(concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('视频并发数须为 1–3');
    const inventory = await scanCourse(courseUrl, cookie, { signal, onProgress });
    const { videos, ...course } = inventory.course;
    const result = { kind: 'batch', course, concurrency, totalVideos: inventory.totalVideos,
      processedVideos: 0, completedVideos: 0, skippedVideos: 0, failedVideos: 0,
      results: [] };
    const active = new Map();
    function update(extra = {}) {
      const { results, ...counts } = result;
      onProgress({ ...counts, recentResults: results.slice(-10), activeVideos: [...active.values()], ...extra });
    }
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < videos.length && !result.stoppedReason) {
        signal?.throwIfAborted();
        const target = videos[nextIndex++];
        active.set(target.leafId, { leafId: target.leafId, title: target.title, stage: 'loading' });
        update({ currentCourse: course.title, title: target.title, sent: 0, total: 0, message: `正在处理：${target.title}` });
        const item = { course: course.title, title: target.title, url: target.url, leafId: target.leafId };
        try {
          let videoResult;
          if (target.completed) {
            videoResult = { alreadyCompleted: true, progress: { rate: 1, completed: true } };
            item.confirmation = 'course_schedule';
          } else {
            if (target.locked) throw new Error('学习单元尚未开放或被锁定');
            videoResult = await complete({ url: target.url }, cookie, { signal, onProgress: progress => {
              active.set(target.leafId, { ...active.get(target.leafId), ...progress, title: target.title });
              update({ ...progress, currentCourse: course.title, title: target.title });
            } });
            item.confirmation = 'video_watch_progress';
          }
          item.status = videoResult.alreadyCompleted ? 'skipped' : 'completed';
          item.rate = videoResult.progress.rate;
          item.completed = videoResult.progress.completed;
          result[videoResult.alreadyCompleted ? 'skippedVideos' : 'completedVideos']++;
        } catch (error) {
          if (signal?.aborted) throw error;
          item.status = 'failed'; item.error = error.message; result.failedVideos++;
          if (error.stopBatch) result.stoppedReason = error.message;
        }
        result.processedVideos++;
        result.results.push(item);
        active.delete(target.leafId);
        update({ message: `${result.processedVideos}/${result.totalVideos} · 新完成 ${result.completedVideos} · 已完成跳过 ${result.skippedVideos} · 失败 ${result.failedVideos}` });
      }
    }
    // 等待所有工作线程收尾；停止后不遗留仍在上报的任务。
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, videos.length) }, worker));
    signal?.throwIfAborted();
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    return result;
  }

  return { inspect, complete, listCourses, scanCourse, completeCourse };
}

module.exports = { parseVideoUrl, parseCourseUrl, createVideoService, ...createVideoService() };
