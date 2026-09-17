const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
test('CLI connects only to the local master and submits a single orchestrated job', async t => {
  const requests = []; let finished = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, method: req.method, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/session') return res.end(JSON.stringify({ connected: true, userId: 1 }));
    if (req.url === '/api/workflow/start') return res.end(JSON.stringify({ job: { id: 'demo' } }));
    if (req.url === '/api/workflow/demo') { finished = true; return res.end(JSON.stringify({ job: { id: 'demo', status: 'done', modules: {} } })); }
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const child = spawn(process.execPath, [path.resolve('scripts/9-complete-course.js'), 'https://www.xuetangx.com/learn/space/s/s/12'], {
    env: { ...process.env, COOKIE: '', TEST_COOKIE: '', PORT: String(server.address().port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, output); assert.equal(finished, true);
  const start = requests.find(item => item.url === '/api/workflow/start'); assert.equal(start.body.concurrency, 3);
  assert.equal(start.body.courseUrl, 'https://www.xuetangx.com/learn/space/s/s/12');
  assert.equal(requests.filter(item => item.method === 'POST').length, 1);
});
