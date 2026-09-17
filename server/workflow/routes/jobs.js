function register(app, { runtime, handle, primary, courseList, legacyState, latest, invalidateCourses }) {
  app.get('/api/workflow/state', handle(async (req, res) => res.json(await runtime.snapshot())));
  app.post('/api/workflow/start', handle(async (req, res) => res.status(202).json({ ok: true, job: await runtime.start(req.body) })));
  app.get('/api/workflow/:id', handle(async (req, res) => res.json({ job: await runtime.get(req.params.id) })));
  app.post('/api/workflow/:id/:action', handle(async (req, res) => res.json({ ok: true, job: await runtime.control(req.params.id, req.params.action, req.body?.module) })));
}
module.exports = { register };
