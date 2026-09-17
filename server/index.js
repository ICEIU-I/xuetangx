// server/index.js - 本地控制台后端：Express REST + SSE + 静态托管。仅监听 127.0.0.1。
const express = require('express');
const path = require('path');
const fs = require('fs');
const { ANSWERS_DIR } = require('../config');
const api = require('../src/api');
const session = require('./session');
const runner = require('./runner');
const video = require('../src/video');
const videoRunner = require('./video-runner');
const answerBank = require('../src/answer-bank');
const answerRunner = require('./answer-runner');
const article = require('../src/article');
const articleRunner = require('./article-runner');
const discussion = require('../src/discussion');
const discussionRunner = require('./discussion-runner');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8788;
const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');

// —— 会话 ——
app.get('/api/session', (req, res) => res.json(session.summary()));

app.post('/api/cookie', async (req, res) => {
  try {
    if (req.body?.cookie?.trim() !== session.getCookie()) { videoRunner.reset(); answerRunner.reset(); articleRunner.reset(); discussionRunner.reset(); }
    const user = await session.setCookie(req.body && req.body.cookie);
    res.json({ ok: true, user });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/disconnect', (req, res) => { videoRunner.reset(); answerRunner.reset(); articleRunner.reset(); discussionRunner.reset(); session.clear(); res.json({ ok: true }); });

// —— 指定课程的讨论单元逐条发布“1” ——
app.post('/api/discussion/scan', async (req, res) => {
  if (!session.isConnected()) return res.status(400).json({ error: '请先连接登录态' });
  try { res.json({ ok: true, ...await discussion.scanCourse(req.body?.courseUrl, session.getCookie()) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/discussion/run', (req, res) => {
  try {
    if ([runner, videoRunner, answerRunner, articleRunner].some(task => task.getState().status === 'running')) throw new Error('请先停止其他执行任务');
    res.status(202).json({ ok: true, state: discussionRunner.start({ courseUrl: req.body?.courseUrl }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/discussion/stop', (req, res) => res.json({ ok: true, state: discussionRunner.stop() }));
app.get('/api/discussion/state', (req, res) => res.json(discussionRunner.getState()));

// —— 标记指定课程的全部图文为已看完 ——
app.post('/api/article/scan', async (req, res) => {
  if (!session.isConnected()) return res.status(400).json({ error: '请先连接登录态' });
  try { res.json({ ok: true, ...await article.scanCourse(req.body?.courseUrl, session.getCookie()) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/article/run', (req, res) => {
  try {
    if ([runner, videoRunner, answerRunner, discussionRunner].some(task => task.getState().status === 'running')) throw new Error('请先停止其他执行任务');
    res.status(202).json({ ok: true, state: articleRunner.start({ courseUrl: req.body?.courseUrl }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/article/stop', (req, res) => res.json({ ok: true, state: articleRunner.stop() }));
app.get('/api/article/state', (req, res) => res.json(articleRunner.getState()));

// —— 按课程采集答案并写入本地 JSON 数据库 ——
app.post('/api/answer-bank/run', (req, res) => {
  try {
    if ([runner, videoRunner, articleRunner, discussionRunner].some(task => task.getState().status === 'running')) throw new Error('请先停止其他执行任务');
    res.status(202).json({ ok: true, state: answerRunner.start({ courseUrl: req.body?.courseUrl, submitUnanswered: req.body?.submitUnanswered }) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/answer-bank/stop', (req, res) => res.json({ ok: true, state: answerRunner.stop() }));
app.get('/api/answer-bank/state', (req, res) => res.json(answerRunner.getState()));
app.get('/api/answer-bank/:classroomId', async (req, res) => {
  try {
    const database = await answerBank.read(req.params.classroomId);
    if (!database) return res.status(404).json({ error: '该课程尚无本地答案，请先采集' });
    if (req.query.download === '1') return res.attachment(`answers-${Number(req.params.classroomId)}.json`).json(database);
    res.json({ database, summary: answerBank.summary(database) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// —— 视频进度：查询、任务启动与停止 ——
app.post('/api/video/inspect', async (req, res) => {
  if (!session.isConnected()) return res.status(400).json({ ok: false, error: '未连接，请先设置 Cookie' });
  try {
    const result = await video.inspect(req.body?.url, session.getCookie());
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/video/run', (req, res) => {
  try {
    if ([answerRunner, articleRunner, discussionRunner].some(task => task.getState().status === 'running')) throw new Error('请先停止其他执行任务');
    res.status(202).json({ ok: true, state: videoRunner.start({ courseUrl: req.body?.courseUrl, concurrency: req.body?.concurrency, url: req.body?.url, durationSeconds: req.body?.durationSeconds }) });
  }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/video/stop', (req, res) => res.json({ ok: true, state: videoRunner.stop() }));
app.get('/api/video/state', (req, res) => res.json(videoRunner.getState()));
app.post('/api/video/scan', async (req, res) => {
  if (!session.isConnected()) return res.status(400).json({ ok: false, error: '未连接，请先设置 Cookie' });
  try { res.json({ ok: true, ...await video.scanCourse(req.body?.courseUrl, session.getCookie()) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get('/api/video/courses', async (req, res) => {
  if (!session.isConnected()) return res.status(400).json({ ok: false, error: '未连接，请先设置 Cookie' });
  try { res.json({ ok: true, courses: await video.listCourses(session.getCookie()) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// —— 作业列表概览（answers/）——
app.get('/api/answers', (req, res) => {
  const files = fs.readdirSync(ANSWERS_DIR).filter(f => f.endsWith('.json'));
  const list = files.map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(ANSWERS_DIR, f), 'utf8'));
    return { name: d.section || f.replace(/\.json$/, ''), total: (d.questions || []).length, hasId: !!(d.leaf_id && d.exercise_id) };
  });
  res.json({ count: list.length, list });
});

// —— 状态查询（每套查 my_count / is_right）。并发 3 防限速/代理超时 ——
app.get('/api/status', async (req, res) => {
  if (!session.isConnected()) return res.status(400).json({ ok: false, error: '未连接' });
  const cookie = session.getCookie();
  const files = fs.readdirSync(ANSWERS_DIR).filter(f => f.endsWith('.json'));
  const items = files.map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(ANSWERS_DIR, f), 'utf8'));
    return { name: d.section || f.replace(/\.json$/, ''), exerciseId: d.exercise_id, total: (d.questions || []).length };
  });
  const out = [];
  await api.pool(items, 3, async (it) => {
    if (!it.exerciseId) { out.push({ name: it.name, total: it.total, done: 0, right: 0, err: 'no-id' }); return; }
    const probs = await api.getProblems(it.exerciseId, cookie);
    if (!Array.isArray(probs)) { out.push({ name: it.name, total: it.total, done: 0, right: 0, err: 'query' }); return; }
    out.push({
      name: it.name, total: probs.length,
      done: probs.filter(p => p.my_count > 0).length,
      right: probs.filter(p => p.is_right === true).length,
    });
  });
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const totalQ = out.reduce((s, x) => s + x.total, 0);
  const doneQ = out.reduce((s, x) => s + x.done, 0);
  const rightQ = out.reduce((s, x) => s + x.right, 0);
  res.json({ ok: true, sections: out, totalQ, doneQ, rightQ });
});

// —— 跑作业 ——
app.post('/api/run', async (req, res) => {
  try {
    if ([answerRunner, articleRunner, discussionRunner].some(task => task.getState().status === 'running')) return res.status(400).json({ ok: false, error: '请先停止其他执行任务' });
    const targets = (req.body && req.body.targets) || null;
    runner.startRun(targets).catch((e) => console.error('[startRun error]', e)); // 异步跑，事件走 SSE
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/stop', (req, res) => { runner.stopRun(); res.json({ ok: true }); });
app.get('/api/run-state', (req, res) => res.json(runner.getState()));

// —— SSE 实时事件 ——
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', ...runner.getState(), video: videoRunner.getState(), answerBank: answerRunner.getState(), article: articleRunner.getState(), discussion: discussionRunner.getState() })}\n\n`);
  const off = runner.onEvent((evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
  const offVideo = videoRunner.onEvent((evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
  const offAnswers = answerRunner.onEvent((evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
  const offArticles = articleRunner.onEvent((evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
  const offDiscussions = discussionRunner.onEvent((evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { off(); offVideo(); offAnswers(); offArticles(); offDiscussions(); clearInterval(ping); });
});

// —— 静态前端 ——
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  // Express 5: 通配用 /*splat（不能再用裸 '*'）
  app.get('/*splat', (req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.send('<h2>前端未构建</h2><p>先 cd web && npm install && npm run build</p>'));
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`控制台后端已启动: http://127.0.0.1:${PORT}`);
  console.log(WEB_DIST && fs.existsSync(WEB_DIST) ? '(前端已构建)' : '(前端未构建,先 build web)');
});
