import test from 'node:test';
import assert from 'node:assert/strict';
import { mountOverview } from '../src/admin/overview.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const traffic = (range, views) => ({range, interval:'day', points:views.map((value, index) => ({start:Date.UTC(2026, 8, 10 + index), views:value}))});
const metricResponse = value => ({ready:true,runningJobs:2,performance:{answerAccuracyPercent:0,gradedAnswers:1,completedCourseJobs:1,averageCourseDurationSeconds:60},traffic:value});
const chart = html => html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
const selectedRange = html => [...html.matchAll(/id="traffic-range-([^"]+)"[^>]*aria-pressed="true"/g)].map(([, range]) => range);

function mountWithFakeRequests(t) {
  const original = Object.fromEntries(['document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests = [], listeners = new Map();
  const host = {
    innerHTML: '', contains: target => target?.host === host, querySelectorAll: () => [],
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      const group = listeners.get(name);
      group?.delete(listener);
      if (!group?.size) listeners.delete(name);
    },
  };
  Object.defineProperty(globalThis, 'document', {configurable:true, value:{cookie:'',activeElement:null}});
  Object.defineProperty(globalThis, 'fetch', {configurable:true, value:(url, options) => new Promise(resolve => requests.push({url,options,resolve}))});
  const dispose = mountOverview(host);
  t.after(() => {
    dispose();
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  function click(id, inside = true) {
    const button = {id, host:inside ? host : null};
    // Each delegated selector must match independently, including child clicks.
    const target = {closest:selector => selector === `#${id}` ? button : null};
    for (const listener of [...(listeners.get('click') || [])]) listener({target});
  }
  async function succeed(index, value) {
    requests[index].resolve({ok:true,json:async()=>metricResponse(value)});
    await settle();
  }
  async function fail(index) {
    requests[index].resolve({ok:false,status:503,json:async()=>({error:'刷新失败'})});
    await settle();
  }
  return {host, requests, listeners, click, succeed, fail, dispose};
}

test('overview range switching dispatches the matching delegate, deduplicates and preserves the last successful range', async t => {
  const {host, requests, listeners, click, succeed, fail, dispose} = mountWithFakeRequests(t);
  assert.equal(listeners.get('click').size, 3, 'refresh and both range delegates must coexist');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/admin/metrics?trafficRange=7d');
  assert.equal(requests[0].options.method, undefined);
  assert.match(host.innerHTML, /aria-busy="true"/);
  assert.equal((host.innerHTML.match(/<strong>—<\/strong>/g) || []).length, 7, 'loading placeholders include three navigation counts and four task metrics');
  click('metrics-refresh'); click('traffic-range-30d'); click('traffic-range-7d');
  assert.equal(requests.length, 1, 'all controls share the pending-request guard');

  await succeed(0, traffic('7d', [0, 3, 2]));
  assert.deepEqual(selectedRange(host.innerHTML), ['7d']);
  const sevenDayChart = chart(host.innerHTML);
  assert.ok(sevenDayChart);
  assert.match(host.innerHTML, /<strong>0<\/strong>\s*<span[^>]*>%<\/span>/);
  assert.match(host.innerHTML, /<strong>1<\/strong>\s*<span[^>]*>分钟<\/span>/);
  assert.match(host.innerHTML, /已完成任务/); assert.match(host.innerHTML, /运行中任务/);
  assert.match(host.innerHTML, /<strong>2<\/strong>/);
  assert.doesNotMatch(host.innerHTML, /题库冲突/);
  click('unrelated'); click('traffic-range-30d', false);
  assert.equal(requests.length, 1, 'unmatched selectors and outside-host targets do not dispatch');

  click('traffic-range-30d');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/api/admin/metrics?trafficRange=30d');
  assert.deepEqual(selectedRange(host.innerHTML), ['7d'], 'selection tracks displayed data until the new range succeeds');
  assert.equal(chart(host.innerHTML), sevenDayChart);
  click('traffic-range-30d'); click('metrics-refresh'); click('traffic-range-7d');
  assert.equal(requests.length, 2);
  await succeed(1, traffic('30d', [8, 4, 9, 12]));
  assert.deepEqual(selectedRange(host.innerHTML), ['30d']);
  const thirtyDayChart = chart(host.innerHTML);
  assert.ok(thirtyDayChart); assert.notEqual(thirtyDayChart, sevenDayChart);

  click('metrics-refresh');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, '/api/admin/metrics?trafficRange=30d', 'refresh retains the selected range');
  click('metrics-refresh'); assert.equal(requests.length, 3);
  await fail(2);
  assert.match(host.innerHTML, /刷新失败/);
  assert.deepEqual(selectedRange(host.innerHTML), ['30d']);
  assert.equal(chart(host.innerHTML), thirtyDayChart);
  assert.match(host.innerHTML, /<strong>0<\/strong>\s*<span[^>]*>%<\/span>/);
  assert.match(host.innerHTML, /aria-busy="false"/);

  click('traffic-range-7d');
  assert.equal(requests.length, 4);
  assert.equal(requests[3].url, '/api/admin/metrics?trafficRange=7d');
  await fail(3);
  assert.deepEqual(selectedRange(host.innerHTML), ['30d'], 'a failed switch must not relabel the old chart');
  assert.equal(chart(host.innerHTML), thirtyDayChart);
  click('metrics-refresh');
  assert.equal(requests.length, 5);
  assert.equal(requests[4].url, '/api/admin/metrics?trafficRange=30d', 'failed switching must not change the next refresh range');

  for (const request of requests) {
    assert.equal(request.options.method, undefined, 'overview only issues read requests');
    assert.equal(request.options.credentials, 'same-origin');
  }
  const beforeDispose = host.innerHTML;
  dispose();
  assert.equal(listeners.size, 0, 'all delegates are removed individually');
  assert.equal(requests[4].options.signal.aborted, true);
  click('metrics-refresh'); assert.equal(requests.length, 5);
  await succeed(4, traffic('7d', [99]));
  assert.equal(host.innerHTML, beforeDispose, 'late responses must not redraw a disposed page');
});
