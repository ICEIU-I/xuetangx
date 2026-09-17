const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { ROOT } = require('../../config');
const { createRuntime } = require('./runtime');
const { createContext } = require('./routes/context');
function createWorkflowApp({ runtime = createRuntime() } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.locals.runtime = runtime;
  const context = createContext(runtime);
  for (const name of ['accounts', 'jobs', 'advanced', 'events']) require('./routes/' + name).register(app, context);
  const dist = path.join(ROOT, 'web/dist');
  if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get('/*splat', (req, res) => res.sendFile(path.join(dist, 'index.html'))); }
  else app.get('/', (req, res) => res.send('请先构建前端：npm run build-web'));
  return app;
}
module.exports = { createWorkflowApp };
