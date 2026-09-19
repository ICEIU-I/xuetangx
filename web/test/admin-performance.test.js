import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAccuracy, formatDuration, performanceSummary } from '../src/admin/performance-view.js';

const summaryValues = html => [...html.matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/g)].map(([, value]) => value.replace(/<[^>]*>/g, '').replace(/\s+/g, ''));
const metrics = (performance = {}, runningJobs = 2) => ({performance: {answerAccuracyPercent: 100, gradedAnswers: 200, averageCourseDurationSeconds: 480, completedCourseJobs: 12, ...performance}, runningJobs});

test('accuracy distinguishes no data, zero and non-perfect results', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 101, '99']) assert.equal(formatAccuracy(value), '—');
  assert.equal(formatAccuracy(0), '0%');
  assert.equal(formatAccuracy(100), '100%');
  assert.equal(formatAccuracy(999 / 1000 * 100), '99.9%');
  assert.equal(formatAccuracy(99.999), '99.9%');
  assert.equal(formatAccuracy(97.24), '97.2%');
});

test('duration is compact, readable and never invents missing averages', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, '60']) assert.equal(formatDuration(value), '—');
  assert.equal(formatDuration(0.5), '不足 1 秒');
  assert.equal(formatDuration(12), '12 秒');
  assert.equal(formatDuration(60), '1 分钟');
  assert.equal(formatDuration(125), '2 分钟 5 秒');
  assert.equal(formatDuration(3600), '1 小时');
  assert.equal(formatDuration(3661), '1 小时 1 分钟');
});

test('summary renders four concise metrics with separate values and units', () => {
  const html = performanceSummary(metrics());
  assert.equal((html.match(/<dt\b/g) || []).length, 4);
  for (const label of ['答题准确率', '平均耗时', '已完成任务', '运行中任务']) assert.ok(html.includes(label));
  assert.deepEqual(summaryValues(html), ['100%', '8分钟', '12', '2']);
  assert.match(html, /<strong>100<\/strong>\s*<span[^>]*>%<\/span>/);
  assert.match(html, /<strong>8<\/strong>\s*<span[^>]*>分钟<\/span>/);
  assert.doesNotMatch(html, /题库冲突|<button|<a\b|<canvas|<svg/);
  assert.match(html, /aria-busy="false"/);
});

test('unknown values stay unknown while zero counts remain visible', () => {
  for (const value of [null, undefined, {}, {performance: null}]) {
    assert.deepEqual(summaryValues(performanceSummary(value, true)), ['—', '—', '—', '—']);
  }
  assert.match(performanceSummary(null, true), /aria-busy="true"/);
  const noSamples = performanceSummary(metrics({gradedAnswers: 0, completedCourseJobs: 0, averageCourseDurationSeconds: 0}, 0));
  assert.deepEqual(summaryValues(noSamples), ['—', '—', '0', '0']);
  const zeroAccuracy = performanceSummary(metrics({answerAccuracyPercent: 0}));
  assert.equal(summaryValues(zeroAccuracy)[0], '0%');
});

test('summary rejects invalid values and invalid sample counts without coercion', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, '3', 0.5, true, false, '<img src=x>']) {
    const html = performanceSummary({...metrics({gradedAnswers: value, completedCourseJobs: value}), runningJobs: value});
    assert.deepEqual(summaryValues(html), ['—', '—', '—', '—']);
  }
  for (const value of [undefined, null, NaN, Infinity, -1, '60', true, false, '<img src=x>']) {
    const html = performanceSummary(metrics({answerAccuracyPercent: value, averageCourseDurationSeconds: value}));
    assert.deepEqual(summaryValues(html), ['—', '—', '12', '2']);
  }
  assert.equal(summaryValues(performanceSummary(metrics({answerAccuracyPercent: 101})))[0], '—');
  assert.equal(summaryValues(performanceSummary(metrics({answerAccuracyPercent: 99.999})))[0], '99.9%');
});

test('compact average retains an exact duration and scope in its tooltip', () => {
  const html = performanceSummary(metrics({averageCourseDurationSeconds: 125}));
  assert.equal(summaryValues(html)[1], '2.1分钟');
  assert.match(html, /title="[^"]*2 分钟 5 秒[^"]*"/);
  assert.match(html, /排队/); assert.match(html, /暂停/); assert.match(html, /等待/);
  const long = performanceSummary(metrics({averageCourseDurationSeconds: 5400}));
  assert.equal(summaryValues(long)[1], '1.5小时');
  assert.match(long, /title="[^"]*1 小时 30 分钟[^"]*"/);
});
