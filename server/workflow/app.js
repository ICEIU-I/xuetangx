const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { createRuntime } = require('./runtime');
const { parseCourseUrl } = require('../../src/video');
const { ROOT } = require('../../config');
const legacyKinds = { video: 'video', article: 'article', discussion: 'discussion', 'answer-bank': 'collector', homework: 'homework' };
function createWorkflowApp({ runtime = createRuntime() } = {}) {
  const app = express(); app.use(express.json({ limit: '1mb' })); app.locals.runtime = runtime;
  const handle = fn => async (req, res) => { try { await fn(req, res); } catch (error) { res.status(error.code === 'ACCOUNT_REQUIRED' ? 401 : 400).json({ ok: false, error: error.message, code: error.code }); } };
  const primary = () => { const value = runtime.accounts.get('primary'); return { role: 'primary', userId: value.userId }; };
  let courseCache = null;
  async function courseList() {
    const account = primary();
    if (!courseCache || courseCache.userId !== account.userId || courseCache.until < Date.now()) {
      const promise = runtime.catalog.listCourses(account); courseCache = { userId: account.userId, until: Date.now() + 15000, promise };
      promise.catch(() => { if (courseCache?.promise === promise) courseCache = null; });
    }
    return courseCache.promise;
  }
  const initial = () => ({ status: 'idle', message: '', total: 0, done: 0, processed: 0, correct: 0, failed: 0, result: null });
  function legacyState(kind, job) {
    const module = job?.modules[kind]; if (!module) return initial();
    const status = ['running', 'queued', 'scanning', 'waiting_answers', 'waiting_quota'].includes(module.status) ? 'running'
      : ['blocked', 'error', 'waiting_account', 'waiting_enrollment'].includes(module.status) ? 'error' : module.status;
    const results = (module.results || []).map(item => ({ ...item, leafId: item.unitId, url: `${job.course.url}/${kind}/${item.unitId}` }));
    const value = { ...module, status, jobId: job.id, course: job.course, courseUrl: job.course.url, concurrency: job.concurrency, results };
    if (kind === 'video') Object.assign(value, { mode: 'course', totalVideos: module.total || 0, processedVideos: module.processed || 0, completedVideos: module.completed || 0,
      skippedVideos: module.skipped || 0, failedVideos: module.failed || 0, recentResults: results, result: ['done', 'partial'].includes(status) ? { kind: 'batch', results } : null });
    if (kind === 'homework') Object.assign(value, { done: module.processed || 0, correct: module.completed || 0, ratePerMin: 0, etaSec: 0, skipped: module.skipped || 0 });
    if (kind === 'collector') Object.assign(value, { totalQuestions: job.coverage?.total || 0, capturedAnswers: job.coverage?.captured || 0, missingAnswers: job.coverage?.missing || 0,
      totalExercises: 0, processedExercises: 0, result: module.status === 'done' ? { course: job.course } : null });
    return value;
  }
  async function latest(kind) { const state = await runtime.snapshot(); return state.jobs.find(job => job.modules[kind]); }
  app.get('/api/session', (req, res) => res.json(runtime.accounts.summary('primary')));
  app.post('/api/cookie', handle(async (req, res) => { const connected = await runtime.accounts.connect('primary', req.body?.cookie); courseCache = null; res.json({ ok: true, user: connected.user }); }));
  app.post('/api/disconnect', (req, res) => { runtime.accounts.clear('primary'); res.json({ ok: true }); });
  app.post('/api/test-cookie', handle(async (req, res) => res.json({ ok: true, ...await runtime.accounts.connect('test', req.body?.cookie) })));
  app.post('/api/test-disconnect', (req, res) => { runtime.accounts.clear('test'); res.json({ ok: true }); });
  app.get('/api/workflow/state', handle(async (req, res) => res.json(await runtime.snapshot())));
  app.post('/api/workflow/start', handle(async (req, res) => res.status(202).json({ ok: true, job: await runtime.start(req.body) })));
  app.get('/api/workflow/:id', handle(async (req, res) => res.json({ job: await runtime.get(req.params.id) })));
  app.post('/api/workflow/:id/:action', handle(async (req, res) => res.json({ ok: true, job: await runtime.control(req.params.id, req.params.action, req.body?.module) })));
  app.get('/api/video/courses', handle(async (req, res) => res.json({ ok: true, courses: await courseList() })));
  for (const [name, kind] of Object.entries(legacyKinds)) {
    const runPath = kind === 'homework' ? '/api/run' : `/api/${name}/run`;
    const statePath = kind === 'homework' ? '/api/run-state' : `/api/${name}/state`;
    const stopPath = kind === 'homework' ? '/api/stop' : `/api/${name}/stop`;
    app.post(runPath, handle(async (req, res) => {
      const courseUrl = req.body?.courseUrl || req.body?.url;
      const videoId = kind === 'video' && req.body?.url && !req.body?.courseUrl ? Number(/\/video\/(\d+)/.exec(req.body.url)?.[1]) : undefined;
      const job = await runtime.start({ courseUrl, modules: [kind], concurrency: req.body?.concurrency,
        submitUnanswered: kind === 'collector' ? req.body?.submitUnanswered === true : true, targets: req.body?.targets, unitId: videoId });
      res.status(202).json({ ok: true, state: legacyState(kind, job) });
    }));
    app.get(statePath, handle(async (req, res) => res.json(legacyState(kind, await latest(kind)))));
    app.post(stopPath, handle(async (req, res) => { const job = await latest(kind); if (job) await runtime.control(job.id, 'stop', kind); res.json({ ok: true }); }));
    if (['video', 'article', 'discussion'].includes(kind)) app.post(`/api/${name}/scan`, handle(async (req, res) => {
      const inventory = await runtime.catalog.discover(primary(), req.body?.courseUrl);
      const units = inventory.units.filter(unit => unit.kind === kind).map(unit => ({ leafId: unit.id, title: unit.title, completed: unit.progress === 1, locked: unit.locked }));
      res.json({ ok: true, course: { ...inventory.course, videos: kind === 'video' ? units : undefined }, totalVideos: units.length, total: units.length,
        completed: units.filter(unit => unit.completed).length, [kind === 'discussion' ? 'discussions' : kind === 'article' ? 'articles' : 'videos']: units });
    }));
  }
  app.get('/api/status', handle(async (req, res) => {
    const inventory = await runtime.catalog.discover(primary(), req.query.courseUrl);
    inventory.exercises = await runtime.catalog.exercises(primary(), inventory);
    const coverage = await runtime.bank.coverage(inventory);
    const sections = inventory.exercises.map(exercise => ({ name: exercise.title, total: exercise.problems.length,
      done: exercise.problems.filter(p => Number(p.user?.my_count) > 0).length, right: exercise.problems.filter(p => p.user?.is_right === true).length, err: exercise.error,
      missing: coverage.missingItems.filter(item => item.leafId === exercise.leafId).length }));
    res.json({ ok: true, sections, totalQ: sections.reduce((n, x) => n + x.total, 0), doneQ: sections.reduce((n, x) => n + x.done, 0), rightQ: sections.reduce((n, x) => n + x.right, 0) });
  }));
  app.get('/api/answers', (req, res) => res.json({ count: 0, list: [] }));
  app.get('/api/answer-bank/:classroomId', handle(async (req, res) => {
    const course = (await courseList()).find(item => item.classroomId === Number(req.params.classroomId)); if (!course) throw new Error('该课程不属于当前正式账号');
    const database = await runtime.bank.read(course);
    if (req.query.download === '1') return res.attachment(`answers-${course.classroomId}.json`).json(database);
    const exercises = Object.values(database.exercises).filter(item => item.active !== false), questions = exercises.flatMap(item => item.questions || []);
    res.json({ database, summary: { course, totalExercises: exercises.length, processedExercises: exercises.length, totalQuestions: questions.length,
      capturedAnswers: questions.filter(q => q.answer_status === 'captured').length, missingAnswers: questions.filter(q => q.answer_status !== 'captured').length } });
  }));
  app.post('/api/video/inspect', handle(async (req, res) => {
    const target = parseCourseUrl(req.body?.url), match = /\/video\/(\d+)/.exec(req.body?.url || ''); if (!match) throw new Error('请填写视频学习页链接');
    const inventory = await runtime.catalog.discover(primary(), target.url), leafId = Number(match[1]);
    if (!inventory.units.some(unit => unit.kind === 'video' && unit.id === leafId)) throw new Error('视频不属于该课程');
    const data = await runtime.catalog.data(primary(), `/api/v1/lms/learn/leaf_info/${target.classroomId}/${leafId}/?sign=${encodeURIComponent(target.sign)}`);
    const progressResponse = await runtime.broker.request('primary', primary().userId, 'GET', '/video-log/get_video_watch_progress/?' + new URLSearchParams({ cid: data.course_id, user_id: data.user_id, classroom_id: target.classroomId, video_type: 'video', vtype: 'rate', video_id: leafId }));
    const p = progressResponse.json?.data?.[leafId] || progressResponse.json?.[leafId] || {};
    res.json({ video: { url: req.body.url.split('?')[0], title: data.name, leafId }, progress: { rate: p.rate || 0, completed: Number(p.completed) === 1, watchLength: p.watch_length || 0 }, durationSeconds: p.video_length || data.content_info?.media?.duration || null });
  }));
  app.get('/api/events', handle(async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.flushHeaders();
    const write = event => res.write(`data: ${JSON.stringify(event)}\n\n`), state = await runtime.snapshot();
    const newest = kind => state.jobs.find(job => job.modules[kind]);
    write({ type: 'hello', ...legacyState('homework', newest('homework')), video: legacyState('video', newest('video')), article: legacyState('article', newest('article')),
      discussion: legacyState('discussion', newest('discussion')), answerBank: legacyState('collector', newest('collector')), workflow: state });
    const previous = new Map();
    const off = runtime.onEvent(event => {
      if (event.type === 'workflow' && event.job.primaryId !== runtime.accounts.summary('primary').userId) return;
      write(event);
      if (event.type === 'workflow') for (const kind of Object.keys(event.job.modules)) {
        const value = legacyState(kind, event.job);
        if (kind === 'homework') {
          const type = ['done', 'partial', 'error', 'stopped'].includes(value.status) ? value.status : 'progress';
          const key = `${event.job.id}:${kind}`, hash = JSON.stringify(value);
          if (previous.get(key) !== hash) { previous.set(key, hash); write({ ...value, type, name: '课程答题', msg: value.message }); }
        } else write({ ...value, type: kind === 'collector' ? 'answer-bank' : kind });
      }
    });
    const timer = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { off(); clearInterval(timer); });
  }));
  const dist = path.join(ROOT, 'web/dist');
  if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get('/*splat', (req, res) => res.sendFile(path.join(dist, 'index.html'))); }
  else app.get('/', (req, res) => res.send('请先构建前端：npm run build-web'));
  return app;
}
module.exports = { createWorkflowApp };
