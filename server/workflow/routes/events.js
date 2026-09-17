function register(app, { runtime, handle, primary, courseList, legacyState, latest, invalidateCourses }) {
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
}
module.exports = { register };
