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
