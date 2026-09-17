const { setTimeout: sleep } = require('node:timers/promises');
const { SUBMIT } = require('./broker');
const errorOf = (message, code) => Object.assign(new Error(message), { code });
function createRequestClient({ broker }) {
  async function call(account, method, endpoint, body, { signal, onWait } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await broker.request(account.role, account.userId, method, endpoint, body, { signal, onWait });
        if (response.status === 401) throw errorOf('账号登录已失效，请重新连接', 'ACCOUNT_REQUIRED');
        if (response.status === 403) throw errorOf('平台拒绝访问（HTTP 403），请检查官网或稍后继续', 'ACCESS_DENIED');
        return response;
      } catch (error) {
        // Generic write results are never replayed. Quota-requiring writes are retried explicitly below.
        const safe = error.connectionEstablished === false || (method === 'GET' && !/user_article_finish|forum\/unit\/discussion/.test(endpoint));
        if (signal?.aborted || !safe || !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code) || attempt >= 2 || endpoint === SUBMIT) throw error;
        await sleep(1000 * (attempt + 1), undefined, { signal });
      }
    }
  }
  return call;
}
module.exports = { createRequestClient };
