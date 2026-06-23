// 4-verify.js - 【纯 HTTPS】查服务器逐题核对完成情况（脱离浏览器）
// 用法: node scripts/4-verify.js
const fs = require('fs');
const path = require('path');
const { ANSWERS_DIR } = require('../config');
const http = require('../src/http');
const api = require('../src/api');

(async () => {
  const me = await http.assertLoggedIn();
  console.log('登录态 OK, user_id:', me.user_id || me.id, '\n');

  const items = fs.readdirSync(ANSWERS_DIR).filter(f => f.endsWith('.json')).map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(ANSWERS_DIR, f), 'utf8'));
    return { name: f.replace(/\.json$/, ''), exerciseId: d.exercise_id };
  });

  let totalQ = 0, doneQ = 0, rightQ = 0;
  const undone = []; const wrong = []; const noId = [];

  await api.pool(items, 3, async (it) => {
    if (!it.exerciseId) { noId.push(it.name); return; }
    const probs = await api.getProblems(it.exerciseId);
    if (!Array.isArray(probs)) { undone.push(it.name + '(查询失败)'); return; }
    probs.forEach((p, i) => {
      totalQ++;
      if (p.my_count > 0) doneQ++; else undone.push(`${it.name} 第${i + 1}题`);
      if (p.is_right === true) rightQ++;
      else if (p.my_count > 0) wrong.push(`${it.name} 第${i + 1}题`);
    });
  });

  console.log('=== 逐题核对（服务器真实状态）===');
  console.log(`套数: ${items.length} | 总题: ${totalQ} | 已作答: ${doneQ} | 判对: ${rightQ}`);
  if (noId.length) console.log('\n缺 id:', noId.join(' | '));
  console.log('\n未作答(遗漏):', undone.length ? undone.length + ' 题\n  ' + undone.join('\n  ') : '无 ✅');
  console.log('\n已答但判错:', wrong.length ? wrong.length + ' 题\n  ' + wrong.join('\n  ') : '无');
})().catch(e => { console.error('出错:', e.message); process.exit(1); });
