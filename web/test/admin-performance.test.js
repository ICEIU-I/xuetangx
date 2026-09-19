import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAccuracy, formatDuration, performanceSummary } from '../src/admin/performance-view.js';

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

test('summary has only two values and requires a valid sample', () => {
  const empty = performanceSummary(null, true);
  assert.equal((empty.match(/<dd>—<\/dd>/g) || []).length, 2);
  assert.match(empty, /aria-busy="true"/);
  const html = performanceSummary({answerAccuracyPercent: 100, gradedAnswers: 200, averageCourseDurationSeconds: 480, completedCourseJobs: 12});
  assert.equal((html.match(/<dt /g) || []).length, 2);
  assert.match(html, /答题准确率/); assert.match(html, /平均任务完成时长/);
  assert.match(html, />100%</); assert.match(html, />8 分钟</);
  assert.doesNotMatch(html, /题库冲突|<button|<a /);
  const noSamples = performanceSummary({answerAccuracyPercent: 100, gradedAnswers: 0, averageCourseDurationSeconds: 0, completedCourseJobs: 0});
  assert.equal((noSamples.match(/<dd>—<\/dd>/g) || []).length, 2);
});
