// 使用指定课程的 JSON 答案库答题，实时解析课程参数。
const homework = require('../src/homework');
const http = require('../src/http');
const { COOKIE } = require('../config');
const { concurrency: getConcurrency } = require('../src/tasks');
const { parseCourseUrl } = require('../src/video');
async function main() {
  const args = process.argv.slice(2), urls = args.filter(value => !value.startsWith('--'));
  if (urls.length !== 1 || args.some(value => value.startsWith('--') && !value.startsWith('--concurrency='))) throw new Error('用法：npm run submit -- <课程链接> [--concurrency=3]');
  parseCourseUrl(urls[0]);
  const concurrency = getConcurrency(args.find(value => value.startsWith('--concurrency='))?.slice(14));
  await http.assertLoggedIn(COOKIE);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    const result = await homework.complete({ courseUrl: urls[0], concurrency }, COOKIE, { signal: controller.signal,
      onProgress: event => console.log(event.msg || `${event.name || ''} ${event.done ?? ''}/${event.total ?? ''} ${event.mark || ''}`) });
    console.log(JSON.stringify(result, null, 2));
    if (result.failed || result.missing) process.exitCode = 2;
  } finally { process.removeListener('SIGINT', stop); }
}
main().catch(error => { console.error(error.name === 'AbortError' ? '已停止' : error.message); process.exitCode = 1; });
