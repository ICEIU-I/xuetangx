const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../../config');
function acquireServerLock(directory = path.join(ROOT, 'data/workflow')) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const file = path.join(directory, 'master.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const value = fs.readFileSync(file, 'utf8'), pid = Number(value); let dead = false;
      if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
      if (!dead || attempt) throw new Error('已有主调度进程在运行；请复用该服务，避免重复分配账号额度');
      if (fs.readFileSync(file, 'utf8') === value) fs.unlinkSync(file);
    }
  }
}
module.exports = { acquireServerLock };
