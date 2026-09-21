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
  const state = { session: { connected: true, user: { user_id: 101 } }, courses: [{ classroomId: 31384299 }], score: emptyScore() };
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
  const state = { session: { connected: true, user: { user_id: 101 } }, courses: [{ classroomId: 31384299 }], score: emptyScore() };
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

test('score refresh preserves all enrolled courses and sends the selected URL', async () => {
  const first={classroomId:1,url:'course-1',title:'Fixed',fixed:true},second={classroomId:2,url:'course-2',title:'Other',enrolled:true};
  const state={session:{connected:true,user:{user_id:101}},courses:[first,second],selectedCourseUrl:second.url,score:emptyScore()};let requested;
  const scores=createCourseScore({state,client:{workflowCourseScore:async(signal,url)=>{requested=url;return {primaryId:101,course:{...second,title:'Updated'},available:true,score:92};}}});
  await scores.load();assert.equal(requested,second.url);assert.equal(state.courses.length,2);assert.equal(state.courses[0].title,'Fixed');assert.equal(state.courses[1].title,'Updated');assert.equal(state.courses[1].enrolled,true);assert.equal(state.score.value,92);scores.dispose();
});
test('late scores from another selected course never replace the current score', async () => {
 const first={classroomId:1,url:'one'},second={classroomId:2,url:'two'};
 const state={session:{connected:true,user:{user_id:101}},courses:[first,second],selectedCourseUrl:first.url,score:emptyScore()};const responses=new Map();
 const scores=createCourseScore({state,client:{workflowCourseScore:(_,url)=>new Promise(r=>responses.set(url,r))}});
 const old=scores.load();state.selectedCourseUrl=second.url;const current=scores.load();responses.get('two')({primaryId:101,course:second,available:true,score:22});await current;responses.get('one')({primaryId:101,course:first,available:true,score:99});await old;assert.equal(state.score.value,22);assert.equal(state.courses.length,2);scores.dispose();
});
test('task detail uses that task course, not the homepage selection', async () => {
 const first={classroomId:1,url:'one'},second={classroomId:2,url:'two'};let requested;
 const state={session:{connected:true,user:{user_id:101}},courses:[first,second],selectedCourseUrl:first.url,detailId:'other-job',jobs:[{id:'other-job',primaryId:101,course:second}],score:emptyScore()};
 const scores=createCourseScore({state,client:{workflowCourseScore:async(_,url)=>{requested=url;return {primaryId:101,course:second,available:true,score:12};}}});await scores.load();assert.equal(requested,'two');assert.equal(state.selectedCourseUrl,'one');scores.dispose();
});
test('no selected course means no grade request', async () => {
 const state={session:{connected:true,user:{user_id:101}},courses:[],score:emptyScore()};let count=0;const scores=createCourseScore({state,client:{workflowCourseScore:async()=>{count++;}}});await scores.load();assert.equal(count,0);scores.dispose();
});
