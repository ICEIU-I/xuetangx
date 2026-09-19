import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serviceStatus, overviewLinks, systemDetails } from '../src/admin/overview-view.js';

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
test('overview no longer renders or requests question conflicts', () => {
  const source = readFileSync(new URL('../src/admin/overview.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /conflicts|题库冲突|listSearch|pager/);
  assert.match(source, /performanceSummary\(metrics, busy\)/);
  assert.match(source, /\/api\/admin\/metrics/);
});
test('technical metrics stay inside closed details', () => {
  assert.equal(systemDetails(null), '');
  const html = systemDetails({runningJobs:2,pendingOperations:0});
  assert.match(html, /<details /); assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /运行任务/); assert.match(html, />2</);
});
