const homework = require('../src/homework');
const http = require('../src/http');
const { COOKIE } = require('../config');
const { parseCourseUrl } = require('../src/video');
(async () => {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('用法：npm run verify -- <课程链接>');
  parseCourseUrl(args[0]); await http.assertLoggedIn(COOKIE);
  const result = await homework.scan(args[0], COOKIE);
  console.log(JSON.stringify({ ...result, sections: result.sections.map(({ jobs, ...section }) => ({ ...section, readyToSubmit: jobs.length })) }, null, 2));
  if (result.sections.some(section => section.err)) process.exitCode = 2;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
