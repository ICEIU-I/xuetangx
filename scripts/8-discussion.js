// npm run discussion -- '<课程或讨论题学习页链接>' [--complete]
const discussions = require('../src/discussion');
const { parseCourseUrl } = require('../src/video');
const http = require('../src/http');
const { COOKIE } = require('../config');

async function main() {
  const args = process.argv.slice(2), urls = args.filter(arg => !arg.startsWith('--'));
  if (urls.length !== 1 || args.some(arg => arg.startsWith('--') && arg !== '--complete')) throw new Error('用法：npm run discussion -- <课程或讨论题链接> [--complete]；默认只查询');
  parseCourseUrl(urls[0]); await http.assertLoggedIn(COOKIE);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    const callbacks = { signal: controller.signal, onProgress: state => console.log(state.message) };
    const result = args.includes('--complete') ? await discussions.completeCourse({ courseUrl: urls[0] }, COOKIE, callbacks) : await discussions.scanCourse(urls[0], COOKIE, callbacks);
    console.log(JSON.stringify(result, null, 2));
    if (result.failed || result.stoppedReason) process.exitCode = 2;
  } finally { process.removeListener('SIGINT', stop); }
}
main().catch(error => { console.error(error.name === 'AbortError' ? '讨论题任务已停止' : error.message); process.exitCode = 1; });
