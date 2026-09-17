const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
test('a busy parent receives every completed item and the terminal result before child exit', async t => {
  const child = fork(path.resolve(__dirname, '../../server/workflow/worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  const units = Array.from({ length: 80 }, (_, index) => ({ id: 100 + index, leafType: 3, progress: 1, title: '已完成的图文学习单元'.repeat(8) + index }));
  let terminal, lastProgress, errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  child.on('message', message => {
    if (message.type === 'ready') {
      child.send({ type: 'init', input: { kind: 'article', course: { classroomId: 12, sign: 's' }, units, concurrency: 3 } });
      // Reproduce backpressure while the master is busy serializing course snapshots.
      const until = Date.now() + 150; while (Date.now() < until) {}
    }
    if (message.type === 'progress') lastProgress = message.data.processed;
    if (message.type === 'result') terminal = message.result;
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, errors); assert.equal(lastProgress, 80); assert.equal(terminal?.skipped, 80); assert.equal(terminal.results.length, 80);
});
