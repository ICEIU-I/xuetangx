const { setTimeout: sleep } = require('node:timers/promises');
const { COOKIE } = require('../../config');
const { parseCourseUrl } = require('../../src/video');
const { concurrency } = require('../../src/tasks');
async function main(mode) {
  const args = process.argv.slice(2), urls = args.filter(value => !value.startsWith('--'));
  const allowed = new Set(['--complete', '--course', '--submit-unanswered']);
  if (args.some(value => value.startsWith('--') && !allowed.has(value) && !value.startsWith('--concurrency=') && !value.startsWith('--duration='))) throw new Error('未知参数');
  if (mode !== 'check' && urls.length !== 1) throw new Error(`用法：npm run ${mode} -- <课程学习页链接> [--concurrency=3]`);
  if (mode !== 'check') parseCourseUrl(urls[0]);
  const limit = concurrency(args.find(value => value.startsWith('--concurrency='))?.slice(14));
  const base = `http://127.0.0.1:${process.env.PORT || 8788}`;
  async function api(endpoint, body) {
    let response;
    try { response = await fetch(base + endpoint, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { throw new Error('本地主调度器未启动，请先运行 npm run serve；CLI 不再直接访问平台'); }
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
  }
  // Credentials are sent only to the local master and are never inherited by execution workers.
  if (COOKIE) await api('/api/cookie', { cookie: COOKIE });
  if (process.env.TEST_COOKIE) await api('/api/test-cookie', { cookie: process.env.TEST_COOKIE });
  const session = await api('/api/session'); if (!session.connected) throw new Error('请在控制台连接正式账号，或设置 COOKIE 环境变量');
  if (mode === 'check') { console.log(JSON.stringify({ connected: true, userId: session.userId }, null, 2)); return; }
  if (mode === 'verify') { console.log(JSON.stringify(await api('/api/status?' + new URLSearchParams({ courseUrl: urls[0] })), null, 2)); return; }
  if (['video', 'article', 'discussion'].includes(mode) && !args.includes('--complete')) {
    const endpoint = mode === 'video' && !args.includes('--course') && /\/video\/\d+/.test(urls[0]) ? '/api/video/inspect' : `/api/${mode}/scan`;
    console.log(JSON.stringify(await api(endpoint, { courseUrl: urls[0], url: urls[0] }), null, 2)); return;
  }
  const kind = { submit: 'homework', 'collect-answers': 'collector' }[mode] || mode;
  const { job } = await api('/api/workflow/start', { courseUrl: urls[0], concurrency: limit,
    ...(mode !== 'complete-course' ? { modules: [kind] } : {}),
    ...(kind === 'collector' ? { submitUnanswered: args.includes('--submit-unanswered') } : {}),
    ...(kind === 'video' && !args.includes('--course') ? { unitId: Number(/\/video\/(\d+)/.exec(urls[0])?.[1]) || undefined } : {}) });
  const controller = new AbortController(), stop = () => controller.abort(); process.once('SIGINT', stop);
  let previous = '';
  try {
    for (;;) {
      const { job: state } = await api(`/api/workflow/${job.id}`);
      const text = JSON.stringify({ id: state.id, status: state.status, coverage: state.coverage, modules: Object.fromEntries(Object.entries(state.modules).map(([name, value]) => [name, { status: value.status, processed: value.processed, total: value.total, message: value.message }])) });
      if (text !== previous) { console.log(text); previous = text; }
      if (['done', 'partial', 'stopped', 'paused'].includes(state.status)) { console.log(JSON.stringify(state, null, 2)); if (state.status !== 'done') process.exitCode = 2; return; }
      if (state.status === 'waiting_input') { console.log('等待测试账号或人工处理；可在网页连接账号后继续，任务已保留。'); process.exitCode = 2; return; }
      await sleep(1000, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (controller.signal.aborted) { await api(`/api/workflow/${job.id}/pause`, {}); console.log('任务已暂停，进度已保存'); process.exitCode = 2; }
    else throw error;
  } finally { process.removeListener('SIGINT', stop); }
}
module.exports = { main };
