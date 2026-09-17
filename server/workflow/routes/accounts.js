function register(app, { runtime, handle, primary, courseList, legacyState, latest, invalidateCourses }) {
  app.get('/api/session', (req, res) => res.json(runtime.accounts.summary('primary')));
  app.post('/api/cookie', handle(async (req, res) => { const connected = await runtime.accounts.connect('primary', req.body?.cookie); invalidateCourses(); res.json({ ok: true, user: connected.user }); }));
  app.post('/api/disconnect', (req, res) => { runtime.accounts.clear('primary'); res.json({ ok: true }); });
  app.post('/api/test-cookie', handle(async (req, res) => res.json({ ok: true, ...await runtime.accounts.connect('test', req.body?.cookie) })));
  app.post('/api/test-disconnect', (req, res) => { runtime.accounts.clear('test'); res.json({ ok: true }); });
}
module.exports = { register };
