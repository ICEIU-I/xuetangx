const { parseCourseUrl } = require('../../../src/video');
const legacyKinds = { video: 'video', article: 'article', discussion: 'discussion', 'answer-bank': 'collector', homework: 'homework' };
function register(app, { runtime, handle, primary, courseList, legacyState, latest, invalidateCourses }) {
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
}
module.exports = { register };
