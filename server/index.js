// 服务入口只负责应用选择、主进程锁、监听与关闭。
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../config');
const PORT = process.env.PORT || 8788;
const WEB_DIST = path.join(ROOT, 'web/dist');
function createApp(options = {}) {
  if (Object.keys(options).length && !options.runtime) return require('./compat/app').createLegacyApp(options);
  return require('./workflow/app').createWorkflowApp(options);
}

if (require.main === module) {
  const { acquireServerLock } = require('./workflow/server-lock');
  const release = acquireServerLock();
  const app = createApp();
  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`控制台后端已启动: http://127.0.0.1:${PORT}`);
    console.log(fs.existsSync(WEB_DIST) ? '(前端已构建)' : '(前端未构建,先 build web)');
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await app.locals.runtime?.close(); server.closeAllConnections(); server.close(); release(); process.exit(0);
  };
  server.on('error', error => { release(); console.error(error.message); process.exit(1); });
  process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('exit', release);
}
module.exports = { createApp };
