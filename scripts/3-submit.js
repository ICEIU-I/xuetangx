// 3-submit.js - 【纯 HTTPS】用 answers/ 的正确答案并发自动作答（脱离浏览器）
// 用法: node scripts/3-submit.js ["作业名" ...]   不传=全部
const fs = require('fs');
const path = require('path');
const { ANSWERS_DIR, CONCURRENCY } = require('../config');
const http = require('../src/http');
const api = require('../src/api');

(async () => {
  let targets = process.argv.slice(2);
  if (!targets.length) {
    targets = fs.readdirSync(ANSWERS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
    console.log(`未指定作业，自动处理全部 ${targets.length} 套（已做的题自动跳过）`);
  }

  const me = await http.assertLoggedIn();
  console.log('登录态 OK, user_id:', me.user_id || me.id, '\n');

  const jobs = []; const meta = {};
  for (const name of targets) {
    const file = path.join(ANSWERS_DIR, name + '.json');
    if (!fs.existsSync(file)) { console.log(`跳过(无文件): ${name}`); continue; }
    const ans = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ans.leaf_id || !ans.exercise_id) { console.log(`跳过(无id): ${name}`); continue; }

    const probs = await api.getProblems(ans.exercise_id);
    const doneSet = new Set((Array.isArray(probs) ? probs : []).filter(p => p.my_count > 0).map(p => p.problem_id));
    const todo = ans.questions.filter(q => !q.error && !doneSet.has(q.problem_id));
    meta[name] = { total: ans.questions.length, already: doneSet.size, submitted: 0, correct: 0, failed: 0 };
    todo.forEach(q => jobs.push({ name, leafId: ans.leaf_id, exerciseId: ans.exercise_id, q }));
    console.log(`${name}: 共${ans.questions.length} 已做${doneSet.size} 待提交${todo.length}`);
  }
  const TOTAL = jobs.length;
  console.log(`\n>>> 总待提交 ${TOTAL} 题, 并发${CONCURRENCY}\n`);

  let done = 0;
  await api.pool(jobs, CONCURRENCY, async (job) => {
    const body = api.buildSubmitBody(job.q);
    const r = await api.submit({ leafId: job.leafId, exerciseId: job.exerciseId, problemId: job.q.problem_id, body });
    const m = meta[job.name];
    done++;
    let mark;
    if (r.ok) {
      m.submitted++;
      if (r.data.is_correct) { m.correct++; mark = '✓'; }
      else { mark = '⚠判错'; }
    } else { m.failed++; mark = `✗失败(${r.msg})`; }
    // 每题实时打印，cmd 能看到滚动进度（带时间戳，便于判断卡顿）
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] [${done}/${TOTAL}] ${mark}  ${job.name} 题${job.q.problem_id}`);
  });

  console.log('\n===== 汇总 =====');
  for (const [name, m] of Object.entries(meta)) {
    const ok = m.failed === 0 && (m.already + m.correct === m.total);
    console.log(`  ${ok ? '✅' : '⚠'} ${name}: 本次提交${m.submitted} 对${m.correct} 失败${m.failed} (原已做${m.already}/${m.total})`);
  }
})().catch(e => { console.error('出错:', e.message); process.exit(1); });
