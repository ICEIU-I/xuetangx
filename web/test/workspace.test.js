import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace } from '../src/features/workspace/store.js';
import { finished, percent, summary, wizardStep, latestJob, actions, loginState } from '../src/features/workspace/presentation.js';

const course = { url: 'https://www.xuetangx.com/learn/space/ncepu0702bt1359/ncepu0702bt1359/31384299', classroomId: 31384299, title: '大学物理2' };
const session = { connected: true, user: { user_id: 101, name: '学习者' } };
const module = { status: 'running', total: 38, completed: 37, skipped: 0, wrongExisting: 0, failed: 1 };
const job = (changes = {}) => ({ id: 'job-1', primaryId: 101, course, status: 'running', revision: 1, createdAt: 100, modules: { video: module, article: {status:'done',total:0}, discussion: {status:'done',total:0}, homework: {status:'done',total:0} }, ...changes });
function harness(override = {}, initialSession = session, jobs = []) {
  let snapshot = { accounts: { primary: initialSession }, jobs, pagination: { total: jobs.length }, rateLimits: {} };
  let receive, handlers, disposed = false;
  const storage = new Map();
  const client = { session: async () => initialSession, workflowCourses: async () => ({ courses: [course] }), workflowState: async () => snapshot, workflowJob: async id => ({ job: snapshot.jobs.find(j => j.id === id) }), workflowStart: async () => ({ job: job() }), workflowControl: async (id, action) => ({ job: job({ id, status: action === 'pause' ? 'paused' : 'queued', revision: 3 }) }), ...override };
  const workspace = createWorkspace({ client, subscribe: (r, h) => { receive = r; handlers = h; return { close: () => { disposed = true; } }; }, storage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) }, owner: 'one', pollMs: 100000 });
  return { ...workspace, client, storage, setSnapshot: s => { snapshot = s; }, receive: event => receive(event), streamError: () => handlers.error(), disposed: () => disposed };
}

test('wizard: first visit, connected, resumed, paused and completed', () => {
  assert.equal(wizardStep({ connected: false }, null), 1);
  assert.equal(wizardStep(session, null), 2);
  for (const status of ['running','paused','stopped','partial','done']) assert.equal(wizardStep(session, job({status})), 3);
  assert.equal(latestJob([job({ primaryId: 202, createdAt: 900 }),job()], session, course).id, 'job-1');
  assert.deepEqual(actions(job({status:'paused'}), session), ['resume','stop']);
  assert.deepEqual(actions(job({status:'done'}), session), []);
  assert.equal(actions(job({status:'partial'}), {connected:false}).includes('resume'), false);
});
test('actual completion excludes failures, retrying and incorrect answers', () => {
  assert.equal(finished(module),37); assert.equal(percent(module),97);
  assert.equal(percent({...module,completed:999,total:1000}),99);
  assert.equal(percent({...module,completed:38,status:'running'}),99);
  assert.equal(percent({...module,completed:38,status:'done'}),100);
  assert.equal(finished({...module,completed:0,skipped:7,wrongExisting:2}),5);
  assert.equal(summary(job({modules:{video:{status:'queued',total:0}}})).known,false);
  assert.equal(summary(job()).percent,97);
});
test('QR status follows expiry and never invents scanned state', () => {
  assert.equal(loginState({status:'waiting_scan',expiresAt:'2026-09-18T00:00:00Z'},Date.parse('2026-09-18T00:01:00Z')),'expired');
  assert.equal(loginState({status:'connected',expiresAt:'2026-09-18T00:00:00Z'},Date.now()),'connected');
});
test('initialize restores existing task without a start mutation', async t => {
  let starts=0; const w=harness({workflowStart:async()=>{starts++;}},session,[job({status:'paused'})]); t.after(w.dispose);
  await w.initialize(); assert.equal(w.currentJob.value.status,'paused'); assert.equal(starts,0);
  w.receive({type:'workflow',job:job({status:'done',revision:4})});
  w.receive({type:'workflow',job:job({status:'running',revision:2})});
  assert.equal(w.currentJob.value.status,'done');
});
test('account change clears old task and ignores late snapshot', async t => {
  let resolve; const w=harness(); t.after(w.dispose); await w.initialize();
  w.mergeJob(job()); w.client.workflowState=()=>new Promise(r=>{resolve=r;});
  const pending=w.refresh(); w.setSession({connected:true,user:{user_id:202}});
  resolve({accounts:{primary:session},jobs:[job()]}); await pending;
  assert.equal(w.state.session.user.user_id,202); assert.equal(w.currentJob.value,null);
});
test('successful start and duplicate-click prevention', async t => {
  let resolve,calls=0;const w=harness({workflowStart:()=>{calls++;return new Promise(r=>{resolve=r;});}}); t.after(w.dispose);await w.initialize();
  const p=w.start(course.url); await w.start(course.url);assert.equal(calls,1);
  resolve({job:job()}); await p; assert.equal(w.currentJob.value.id,'job-1');assert.equal(w.state.pendingStart,null);
});
test('interrupted response recovers created job without replay', async t => {
  let w,calls=0;w=harness({workflowStart:async()=>{calls++;w.setSnapshot({accounts:{primary:session},jobs:[job()]});throw new TypeError('network interrupted');}});t.after(w.dispose);await w.initialize();
  await w.start(course.url);assert.equal(w.currentJob.value.id,'job-1');assert.equal(calls,1);assert.equal(w.state.pendingStart,null);
});
test('unresolved interrupted start survives refresh and blocks repeated writes', async t => {
  let calls=0;const w=harness({workflowStart:async()=>{calls++;throw new TypeError('offline');}});t.after(w.dispose);await w.initialize();
  await w.start(course.url);await w.start(course.url);await w.checkStart();assert.equal(calls,1);assert.ok(w.state.pendingStart);assert.equal(w.storage.size,1);
  w.receive({type:'workflow',job:job()});assert.equal(w.state.pendingStart,null);assert.equal(w.storage.size,0);
});
test('definite rejection permits retry and pause never becomes auto-resume', async t => {
  let calls=0;const w=harness({workflowStart:async()=>{calls++;throw Object.assign(new Error('需要重新连接'),{code:'ACCOUNT_REQUIRED'});}});t.after(w.dispose);await w.initialize();
  await w.start(course.url);assert.equal(w.state.pendingStart,null);assert.match(w.state.error,/重新连接/);await w.start(course.url);assert.equal(calls,2);
  w.mergeJob(job());await w.control('job-1','pause');assert.equal(w.currentJob.value.status,'paused');
  await w.refresh();assert.equal(w.currentJob.value.status,'paused');
});
test('SSE failure uses read-only refresh and disposal closes the subscription', async () => {
  const w=harness({},session,[job()]);await w.initialize();w.streamError();assert.equal(w.state.stream,'reconnecting');w.dispose();assert.equal(w.disposed(),true);w.receive({type:'workflow',job:job({revision:8,status:'done'})});assert.equal(w.state.jobs[0].status,'running');
});

const otherCourse={url:'https://www.xuetangx.com/learn/space/math/math/42',classroomId:42,title:'高等数学',enrolled:true};
test('selected enrolled course drives jobs and start, without forcing the fixed course', async t => {
 let requested,starts=0;const other=job({id:'job-math',course:otherCourse,status:'paused'});
 const w=harness({workflowCourses:async()=>({courses:[{...course,fixed:true},otherCourse]}),workflowStart:async url=>{starts++;requested=url;return {job:other};}},session,[job(),other]);t.after(w.dispose);
 await w.initialize();w.selectCourse(otherCourse.url);assert.equal(w.currentJob.value.id,'job-math');assert.equal(starts,0);await w.start(w.state.selectedCourseUrl);assert.equal(requested,otherCourse.url);assert.equal(starts,1);assert.equal(w.state.courses.length,2);
 w.selectCourse(course.url);assert.equal(w.currentJob.value.id,'job-1');await w.loadCourses();assert.equal(w.state.selectedCourseUrl,course.url);
});
test('course refresh retains a non-fixed selection and explicitly reports upstream failure', async t=>{
 let warning=false;const w=harness({workflowCourses:async()=>warning?{courses:[course],warning:'upstream unavailable'}:{courses:[course,otherCourse]}});t.after(w.dispose);await w.initialize();w.selectCourse(otherCourse.url);await w.loadCourses();assert.equal(w.state.selectedCourseUrl,otherCourse.url);warning=true;await w.loadCourses();assert.equal(w.state.courses.length,2);assert.equal(w.state.selectedCourseUrl,otherCourse.url);assert.match(w.state.coursesWarning,/unavailable/);
});
test('old account course-list response is ignored after account switch', async t=>{
 let resolve;const w=harness();t.after(w.dispose);await w.initialize();w.client.workflowCourses=()=>new Promise(r=>resolve=r);const pending=w.loadCourses();w.setSession({connected:true,user:{user_id:202}});resolve({courses:[course,otherCourse],primaryId:101});await pending;assert.deepEqual(w.state.courses,[]);assert.equal(w.state.selectedCourseUrl,'');
});
test('pending startup locks course switching and cannot create another course task', async t=>{
 const w=harness({workflowCourses:async()=>({courses:[course,otherCourse]}),workflowStart:async()=>{throw new TypeError('offline');}});t.after(w.dispose);await w.initialize();await w.start(course.url);w.selectCourse(otherCourse.url);assert.equal(w.state.selectedCourseUrl,course.url);assert.equal(w.state.pendingStart.courseUrl,course.url);
});
test('selection finds the chosen course task outside the first page', async t=>{
 const other=job({id:'old-math',course:otherCourse,status:'done'});const w=harness({workflowCourses:async()=>({courses:[course,otherCourse]}),workflowState:async offset=>({accounts:{primary:session},jobs:offset===100?[other]:[job()],pagination:{total:101}})});t.after(w.dispose);await w.initialize();w.selectCourse(otherCourse.url);await new Promise(r=>setImmediate(r));assert.equal(w.currentJob.value.id,'old-math');
});

test('completed homework tool task returns homepage to start without mutating old results', async t=>{
 const old=job({id:'homework-only',status:'done',modules:{homework:{status:'done',total:290,completed:290},collector:{status:'done',total:290,captured:290}}});
 const before=JSON.stringify(old);let starts=0,options;
 const w=harness({workflowStart:async(url,concurrency,extra)=>{starts++;options=extra;return {job:job({id:'whole-new',createdAt:200})};}},session,[old]);t.after(w.dispose);
 await w.initialize();assert.equal(w.currentJob.value,null);assert.equal(wizardStep(w.state.session,w.currentJob.value),2);assert.equal(starts,0);
 await w.start(course.url);assert.equal(starts,1);assert.equal(w.currentJob.value.id,'whole-new');assert.deepEqual(options,{});assert.equal(JSON.stringify(w.state.jobs.find(j=>j.id==='homework-only')),before);
});
test('late full task from an earlier page remains visible after a newer tool completion',async t=>{
 const tool=job({id:'tool-new',createdAt:500,status:'done',modules:{homework:{status:'done',total:1,completed:1}}});
 const whole=job({id:'whole-old',createdAt:100,status:'paused'});
 const w=harness({workflowState:async offset=>({accounts:{primary:session},jobs:offset===100?[whole]:[tool],pagination:{total:101}})},session,[tool]);t.after(w.dispose);await w.initialize();assert.equal(w.currentJob.value.id,'whole-old');
});
test('interrupted whole-course start ignores a newly seen completed homework task',async t=>{
 let w,calls=0;
 w=harness({workflowStart:async()=>{calls++;w.setSnapshot({accounts:{primary:session},jobs:[job({id:'unrelated-tool',status:'done',modules:{homework:{status:'done',total:1,completed:1}}})]});throw new TypeError('offline');}});t.after(w.dispose);await w.initialize();await w.start(course.url);assert(w.state.pendingStart);assert.equal(w.currentJob.value,null);await w.start(course.url);assert.equal(calls,1);
 w.receive({type:'workflow',job:job({id:'whole-actual'})});assert.equal(w.state.pendingStart,null);assert.equal(w.currentJob.value.id,'whole-actual');
});
