// 0-check-cookie.js - 验证 .env 里的 COOKIE 是否有效（纯 HTTPS，不开浏览器）
// 用法: node scripts/0-check-cookie.js
const http = require('../src/http');

(async () => {
  console.log('用纯 HTTPS 验证 cookie...\n');
  try {
    const me = await http.assertLoggedIn();
    console.log('✅ cookie 有效，已登录');
    console.log('   user_id:', me.user_id || me.id);
    console.log('   学号:', me.school_number || '(无)');
    console.log('   院系:', me.department || '(无)');

    // 再验证能否访问课程数据
    const r = await http.get('/api/v1/lms/exercise/get_exercise_list/6672817/14935198/');
    console.log('\n课程数据访问:', r.status === 200 ? '✅ 正常' : `⚠ status ${r.status}`);
  } catch (e) {
    console.log('❌', e.message);
    process.exit(1);
  }
})();
