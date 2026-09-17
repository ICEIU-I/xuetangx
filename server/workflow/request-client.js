const { setTimeout: sleep } = require('node:timers/promises');
const { SUBMIT } = require('./broker');
const { transientCodes } = require('../../src/network/errors');
const { isRateLimited } = require('./server-limits');
const errorOf = (message, code) => Object.assign(new Error(message), { code });
function createRequestClient({ broker, maxAccessRetries = 2, maxRateLimitRetries = 3 }) {
  async function call(account, method, endpoint, body, { signal, onWait } = {}) {
    let accessRetries = 0, rateLimitRetries = 0, networkRetries = 0;
    for (;;) {
      try {
        const response = await broker.request(account.role, account.userId, method, endpoint, body, { signal, onWait });
        if (response.status === 401) throw errorOf('账号登录已失效，请重新连接', 'ACCOUNT_REQUIRED');
        if (response.status === 403) {
          // An explicit rejection can be retried only through the account cooldown queue.
          if (accessRetries++ < maxAccessRetries) continue;
          throw errorOf(`平台持续拒绝访问（HTTP 403），已冷却重试 ${maxAccessRetries} 次；请检查官网后重试该模块`, 'ACCESS_DENIED');
        }
        // Question submissions already own their bounded 429 retry loop and durable journal.
        if (endpoint.split('?')[0] !== SUBMIT && isRateLimited(response)) {
          if (rateLimitRetries++ < maxRateLimitRetries) continue;
          throw errorOf(`平台持续限流（HTTP ${response.status}），已冷却重试 ${maxRateLimitRetries} 次；请稍后重试该模块`, 'RATE_LIMITED');
        }
        return response;
      } catch (error) {
        // Generic write results are never replayed. Question submissions handle explicit server-limit retries in operations.js.
        const safe = error.connectionEstablished === false || (method === 'GET' && !/user_article_finish|forum\/unit\/discussion/.test(endpoint));
        if (signal?.aborted || !safe || !transientCodes.has(error.code) || networkRetries >= 2 || endpoint === SUBMIT) throw error;
        await sleep(1000 * ++networkRetries, undefined, { signal });
      }
    }
  }
  return call;
}
module.exports = { createRequestClient };
