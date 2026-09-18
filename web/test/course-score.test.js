import test from 'node:test';
import assert from 'node:assert/strict';
import { createCourseScore, emptyScore } from '../src/features/course-score/store.js';

test('course score is kept with the account that requested it', async () => {
  const state = { session: { connected: true, user: { user_id: 101 } }, courses: [{ classroomId: 31384299, title: '大学物理（2）(2026秋)' }], score: emptyScore() };
  let resolve;
  const scores = createCourseScore({ state, client: { workflowCourseScore: () => new Promise(r => { resolve = r; }) } });
  const pending = scores.load();
  state.session = { connected: true, user: { user_id: 202 } };
  resolve({ primaryId: 101, available: true, score: 88.5 });
  await pending;
  assert.equal(state.score.available, false);
  scores.dispose();
});

test('zero is a valid platform score', async () => {
  const state = { session: { connected: true, user: { user_id: 101 } }, courses: [], score: emptyScore() };
  const scores = createCourseScore({ state, client: { workflowCourseScore: async () => ({ primaryId: 101, available: true, score: 0 }) } });
  await scores.load();
  assert.equal(state.score.value, 0);
  assert.equal(state.score.available, true);
  scores.dispose();
});

test('course score refreshes in the foreground without overlapping requests', async () => {
  const state = { session: { connected: true, user: { user_id: 101 } }, courses: [{ classroomId: 31384299 }], score: emptyScore() };
  let now = 1000, scheduled, calls = 0, resolve;
  const scores = createCourseScore({ state, interval: 15000, now: () => now, schedule: fn => (scheduled = fn, 1), cancel: () => {}, client: { workflowCourseScore: () => { calls++; return new Promise(r => { resolve = r; }); } } });
  const unwatch = scores.watch();
  const pending = scores.load();
  assert.equal(calls, 1);
  assert.equal(scores.load(), pending);
  resolve({ primaryId: 101, available: true, score: 70, breakdown: [] });
  await pending;
  assert.equal(state.score.value, 70);
  assert.equal(typeof scheduled, 'function');
  now += 15000;
  scheduled();
  assert.equal(calls, 2);
  unwatch(); scores.dispose();
});

test('a transient refresh keeps the last score and waits before retrying', async () => {
  const state = { session: { connected: true, user: { user_id: 101 } }, courses: [], score: emptyScore() };
  let now = 0;
  const scores = createCourseScore({ state, interval: 15000, now: () => now, schedule: () => 1, cancel: () => {}, client: { workflowCourseScore: async () => ({ primaryId: 101, available: true, score: 88 }) } });
  await scores.load();
  assert.equal(state.score.value, 88);
  const next = createCourseScore({ state, interval: 15000, now: () => now, schedule: () => 1, cancel: () => {}, client: { workflowCourseScore: async () => { throw new Error('暂时不可用'); } } });
  await next.load();
  assert.equal(state.score.value, 88);
  assert.equal(state.score.stale, true);
  next.dispose(); scores.dispose();
});
