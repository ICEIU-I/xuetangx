const { concurrency: getConcurrency } = require('../src/tasks');
// npm run collect-answers -- '<课程链接>' [--submit-unanswered]
const bank = require('../src/answer-bank');
const http = require('../src/http');
const { COOKIE } = require('../config');
const { parseCourseUrl } = require('../src/video');

async function main() {
  const args = process.argv.slice(2), urls = args.filter(arg => !arg.startsWith('--'));
  if (urls.length !== 1 || args.some(arg => arg.startsWith('--') && arg !== '--submit-unanswered' && !arg.startsWith('--concurrency='))) throw new Error('用法：npm run collect-answers -- <课程学习页链接> [--submit-unanswered]');
  const concurrency = getConcurrency(args.find(arg => arg.startsWith('--concurrency='))?.slice(14));
  parseCourseUrl(urls[0]);
  await http.assertLoggedIn(COOKIE);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    const submitUnanswered = args.includes('--submit-unanswered');
    console.log(submitUnanswered ? '提交采集模式：未做题将提交测试选项，消耗作答机会并可能影响成绩。' : '读取模式：只获取后端已公开的标准答案。');
    const result = await bank.collect({ courseUrl: urls[0], submitUnanswered, concurrency }, COOKIE,
      { signal: controller.signal, onProgress: state => console.log(state.message) });
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete) process.exitCode = 2;
  } finally { process.removeListener('SIGINT', stop); }
}
main().catch(error => { console.error(error.name === 'AbortError' ? '已停止；已获取答案保留在 JSON 中' : error.message); process.exitCode = 1; });
