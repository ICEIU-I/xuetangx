import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('pixel loading uses indeterminate stepped motion with reduced-motion support', () => {
  const css = source('../src/styles/loading.css');
  assert.match(css, /steps\(4,end\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /animation:none/);
  assert.doesNotMatch(css, /rotate\(/);
});
test('authentication and page loading expose status without extra branding copy', () => {
  const login = source('../src/auth/login.js');
  assert.match(login, /busy \? '<div class="pixel-loader" role="status">/);
  assert.doesNotMatch(login, /本站账号|登录后在课程任务中连接学堂在线|auth-note/);
  assert.doesNotMatch(source('../src/workspace/shell.js'), /管理中心/);
  for (const file of ['main.js','tasks/detail.js','tasks/history.js','admin/user-progress.js']) {
    assert.match(source(`../src/${file}`), /loading-state" role="status"/);
  }
});
