import test from 'node:test';import assert from 'node:assert/strict';
import { homepageJob, isWholeCourseTask, startScope, matchesPendingScope } from '../src/features/workspace/course-tasks.js';
const course={classroomId:42,url:'math'},session={connected:true,user:{user_id:101}};
const done={status:'done',total:290,completed:290},full={video:done,article:done,discussion:done,homework:done};
const job=(values={})=>({id:'tool',primaryId:101,course,createdAt:100,status:'done',modules:{homework:done,collector:done},...values});
test('completed homework/collector does not mean complete course or block start',()=>{
 assert.equal(isWholeCourseTask(job()),false);assert.equal(homepageJob([job()],session,course),null);
 for(const kind of ['video','article','discussion','collector'])assert.equal(homepageJob([job({modules:{[kind]:done}})],session,course),null);
});
test('full task requires four core modules and unrestricted targets',()=>{
 assert(isWholeCourseTask(job({modules:full})));
 assert.equal(isWholeCourseTask(job({modules:full,unitId:9})),false);
 assert.equal(isWholeCourseTask(job({modules:full,targets:['one exercise']})),false);
 const whole=job({id:'whole',modules:full});assert.equal(homepageJob([whole],session,course).id,'whole');
});
test('new completed tool task cannot conceal an unfinished full task',()=>{
 const prior=job({id:'whole',createdAt:50,status:'paused',modules:full});assert.equal(homepageJob([job(),prior],session,course).id,'whole');
 const active=job({id:'active',createdAt:25,status:'running',modules:full});assert.equal(homepageJob([prior,job(),active],session,course).id,'active');
 assert.equal(homepageJob([job({primaryId:202,modules:full}),job({course:{classroomId:99},modules:full})],session,course),null);
});
test('unfinished tool tasks keep their resume/pause controls until completed',()=>{
 for(const status of ['running','queued','waiting_input','paused','partial','blocked','error','stopped']){
  const current=job({status});assert.equal(homepageJob([current],session,course).id,'tool');
 }
});
test('whole-course pending startup cannot recover as an unrelated homework-only task',()=>{
 const scope=startScope();assert.deepEqual(scope.modules,['video','article','discussion','homework']);
 assert.equal(matchesPendingScope(job(),scope),false);assert.equal(matchesPendingScope(job({modules:full}),scope),true);
 assert.equal(matchesPendingScope(job({modules:full,unitId:9}),scope),false);
 assert.equal(matchesPendingScope(job({modules:full,targets:['one exercise']}),scope),false);
 assert.equal(matchesPendingScope(job(),startScope({modules:['homework']})),true);assert.equal(matchesPendingScope(job(),{}),true);
});
