// npm run video -- '<课程学习页URL>' --course --complete；默认单视频查询。
const video = require('../src/video');
const http = require('../src/http');
const { COOKIE } = require('../config');

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(arg => !arg.startsWith('--'));
  const course = args.includes('--course');
  const concurrencyArg = args.find(arg => arg.startsWith('--concurrency='));
  const concurrency = concurrencyArg ? Number(concurrencyArg.slice(14)) : 3;
  if (!url || args.filter(arg => !arg.startsWith('--')).length !== 1 || (course && args.some(arg => arg.startsWith('--duration=')))
    || (!course && concurrencyArg) || args.some(arg => arg.startsWith('--') && !['--complete', '--course'].includes(arg) && !arg.startsWith('--duration=') && !arg.startsWith('--concurrency='))) {
    throw new Error('用法：npm run video -- <课程链接> --course [--complete] [--concurrency=3] 或 <视频URL> [--complete] [--duration=总秒数]；默认仅查询');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('视频并发数须为 1–3');
  if (course) video.parseCourseUrl(url);
  else video.parseVideoUrl(url);
  await http.assertLoggedIn(COOKIE);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    let lastMessage = '';
    const callbacks = { signal: controller.signal, onProgress: state => {
      const message = state.currentCourse && state.title ? `${state.currentCourse} / ${state.title}：${state.message}` : state.message;
      if (message && message !== lastMessage) { console.log(message); lastMessage = message; }
    } };
    if (course) {
      const result = args.includes('--complete') ? await video.completeCourse({ courseUrl: url, concurrency }, COOKIE, callbacks) : await video.scanCourse(url, COOKIE, callbacks);
      console.log(JSON.stringify(result, null, 2));
      if (result.failedVideos || result.stoppedReason) process.exitCode = 2;
      return;
    }
    const result = args.includes('--complete')
      ? await video.complete({ url, durationSeconds: args.find(arg => arg.startsWith('--duration='))?.slice(11) }, COOKIE,
        callbacks)
      : await video.inspect(url, COOKIE, { signal: controller.signal });
    console.log(JSON.stringify({ title: result.video.title, leafId: result.video.leafId,
      durationSeconds: result.durationSeconds, progress: result.progress, alreadyCompleted: result.alreadyCompleted }, null, 2));
  } finally { process.removeListener('SIGINT', stop); }
}

main().catch(error => { console.error(error.name === 'AbortError' ? '已停止，已发送的记录可能已计入进度' : error.message); process.exitCode = 1; });
