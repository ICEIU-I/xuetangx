import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceStatus, overviewLinks, conflictRows, systemDetails } from '../src/admin/overview-view.js';

test('overview shows three relevant navigation counts without duplicate metrics', () => {
  const html = overviewLinks({users:7,capturedAnswers:230,availableCollectors:1});
  assert.equal((html.match(/<a /g) || []).length, 3);
  for (const path of ['/admin/users','/admin/answers','/admin/collectors']) assert.ok(html.includes(`href="${path}"`));
  assert.match(html, />230</); assert.doesNotMatch(html, /正常用户|进程恢复|待核对操作|答案采集/);
  assert.match(overviewLinks(null), /—/);
});
test('service check distinguishes unknown and not-ready status', () => {
  assert.match(serviceStatus(null), /检查中/);
  assert.match(serviceStatus({ready:true}), /运行正常/);
  assert.match(serviceStatus({ready:false}), /服务未就绪/);
});
test('conflicts are concise escaped rows with navigation and distinct empty states', () => {
  const html = conflictRows([{title:'<img src=x>',problemId:125,classroomId:25}], '');
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/);
  assert.match(html, /href="\/admin\/answers\?course=25"/);
  assert.match(conflictRows([],''), /暂无题库冲突/);
  assert.match(conflictRows([],'physics'), /没有匹配的记录/);
});
test('technical metrics stay inside closed details', () => {
  assert.equal(systemDetails(null), '');
  const html = systemDetails({runningJobs:2,pendingOperations:0});
  assert.match(html, /<details /); assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /运行任务/); assert.match(html, />2</);
});
