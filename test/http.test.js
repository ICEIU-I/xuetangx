const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHttpClient } = require('../src/http');

function fixture(steps, settings = {}) {
  const calls = [], waits = [];
  const requestImpl = (options, callback) => {
    calls.push(options); const step = steps[calls.length - 1] || 'success';
    const req = new EventEmitter(), socket = new EventEmitter();
    socket.getProtocol = () => null;
    req.write = () => {}; req.destroy = error => req.emit('error', error);
    req.end = () => queueMicrotask(() => {
      req.emit('socket', socket);
      if (step === 'tls') return req.emit('error', Object.assign(Error('TLS interrupted'), { code: 'ECONNRESET' }));
      if (step === 'certificate') return req.emit('error', Object.assign(Error('bad certificate'), { code: 'CERT_HAS_EXPIRED' }));
      socket.emit('secureConnect');
      if (step === 'reset') return req.emit('error', Object.assign(Error('reset'), { code: 'ECONNRESET' }));
      const res = new EventEmitter(); res.headers = {}; res.statusCode = step === 'forbidden' ? 403 : 200; callback(res);
      res.emit('data', '{"success":true');
      if (step === 'truncated') { res.complete = false; res.emit('aborted'); res.emit('close'); return; }
      res.emit('data', ',"data":{}}'); res.complete = true; res.emit('end');
    });
    return req;
  };
  const client = createHttpClient({ requestImpl, minInterval: 0, sleep: async delay => waits.push(delay), ...settings });
  return { client, calls, waits };
}

test('TLS disconnect retries with a new connection before any HTTP request is accepted', async () => {
  const { client, calls, waits } = fixture(['tls', 'success']);
  assert.equal((await client.post('/api/v1/lms/exercise/problem_apply/', {}, 'cookie')).status, 200);
  assert.equal(calls.length, 2); assert.equal(calls[1].agent, false); assert.deepEqual(waits, [1000]);
});
test('an uncertain POST or mutating GET is never replayed after TLS connected', async () => {
  for (const method of ['POST', 'GET']) {
    const { client, calls } = fixture(['reset']);
    const run = method === 'POST' ? client.post('/api/v1/lms/forum/comment/', {}, 'cookie') : client.get('/api/v1/lms/learn/user_article_finish/1/', 'cookie');
    await assert.rejects(run, /未自动重发/); assert.equal(calls.length, 1);
  }
});
test('a truncated read-only response is retried and resolves with complete JSON', async () => {
  const { client, calls } = fixture(['truncated', 'success']);
  assert.equal((await client.get('/api/v1/lms/learn/course/schedule?cid=1', 'cookie')).json.success, true);
  assert.equal(calls.length, 2);
});
test('certificate errors and HTTP 403 are not treated as temporary connection errors', async () => {
  const certificate = fixture(['certificate']);
  await assert.rejects(certificate.client.get('/api/v1/u/user/basic_profile/'), { code: 'CERT_HAS_EXPIRED' });
  assert.equal(certificate.calls.length, 1);
  const forbidden = fixture(['forbidden']);
  assert.equal((await forbidden.client.get('/api/v1/u/user/basic_profile/')).status, 403);
  assert.equal(forbidden.calls.length, 1);
});
test('retry exhaustion has a clear Chinese message and preserves the network code', async () => {
  const { client, calls } = fixture(['tls', 'tls', 'tls']);
  await assert.rejects(client.get('/api/v1/u/user/basic_profile/'), error => error.code === 'ECONNRESET' && /已重试 2 次/.test(error.message));
  assert.equal(calls.length, 3);
});
test('stop during retry wait prevents subsequent requests', async () => {
  const controller = new AbortController();
  const { client, calls } = fixture(['tls'], { sleep: async () => controller.abort() });
  await assert.rejects(client.get('/api/v1/u/user/basic_profile/', '', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});
