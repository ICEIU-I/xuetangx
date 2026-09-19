import test from 'node:test';
import assert from 'node:assert/strict';
import { mountOverview } from '../src/admin/overview.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('overview refresh is read-only, deduplicated, preserves values on errors and cleans up', async t => {
  const original = Object.fromEntries(['document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests = [], listeners = new Map();
  const host = {
    innerHTML: '', contains: target => Boolean(target?.button), querySelectorAll: () => [],
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
  };
  Object.defineProperty(globalThis, 'document', {configurable:true, value:{cookie:'',activeElement:null}});
  Object.defineProperty(globalThis, 'fetch', {configurable:true, value:(url, options) => new Promise(resolve => requests.push({url,options,resolve}))});
  t.after(() => {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const dispose = mountOverview(host);
  t.after(dispose);
  const refresh = () => listeners.get('click')({target:{closest:()=>({button:true})}});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/admin/metrics');
  assert.equal(requests[0].options.method, undefined);
  assert.match(host.innerHTML, /aria-busy="true"/);
  refresh(); assert.equal(requests.length, 1);
  requests[0].resolve({ok:true,json:async()=>({ready:true,performance:{answerAccuracyPercent:0,gradedAnswers:1,completedCourseJobs:1,averageCourseDurationSeconds:60}})});
  await settle();
  assert.match(host.innerHTML, />0%</); assert.match(host.innerHTML, />1 分钟</);
  assert.doesNotMatch(host.innerHTML, /题库冲突/);
  refresh(); refresh(); assert.equal(requests.length, 2);
  requests[1].resolve({ok:false,status:503,json:async()=>({error:'刷新失败'})});
  await settle();
  assert.match(host.innerHTML, /刷新失败/); assert.match(host.innerHTML, />0%</);
  assert.match(host.innerHTML, /aria-busy="false"/);
  refresh(); assert.equal(requests.length, 3);
  const beforeDispose = host.innerHTML;
  dispose(); assert.equal(listeners.size, 0); assert.equal(requests[2].options.signal.aborted, true);
  requests[2].resolve({ok:true,json:async()=>({ready:false})});
  await settle();
  assert.equal(host.innerHTML, beforeDispose, 'late responses must not redraw a disposed page');
});
