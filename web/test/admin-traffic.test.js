import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficSummary } from '../src/admin/traffic-view.js';

test('traffic summary renders selectable ranges and gaps without invented values', () => {
  const html = trafficSummary({range:'7d', interval:'day', points:[
    {start: Date.UTC(2026, 8, 13), views:null},
    {start: Date.UTC(2026, 8, 14), views:0},
    {start: Date.UTC(2026, 8, 15), views:3},
    {start: Date.UTC(2026, 8, 16), views:null},
    {start: Date.UTC(2026, 8, 17), views:2},
  ]}, '7d');
  assert.match(html, /访问量/);
  assert.match(html, /id="traffic-range-7d"[^>]*aria-pressed="true"/);
  assert.match(html, /id="traffic-range-30d"[^>]*aria-pressed="false"/);
  assert.match(html, /<svg/);
  assert.equal((html.match(/<circle\b/g) || []).length, 3, 'only observed values, including zero, produce points');
  assert.equal((html.match(/<polyline\b/g) || []).length, 2, 'unknown periods split the plotted line');
  assert.match(html, /<title>9\/14：0 次<\/title>/);
  assert.doesNotMatch(html, /<title>9\/(13|16)：/);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
  assert.match(html, /9\/15/);
});

test('traffic summary uses empty state for no observed points and supports 30 days', () => {
  const html = trafficSummary({range:'30d', interval:'day', points:Array.from({length:30}, (_, i) => ({start:i, views:null}))}, '30d');
  assert.match(html, /id="traffic-range-30d"[^>]*aria-pressed="true"/);
  assert.match(html, /暂无访问数据/);
  assert.doesNotMatch(html, /<svg/);
});

test('traffic range controls describe the displayed dataset and are disabled while loading', () => {
  const data = {range:'7d', interval:'day', points:[{start:Date.UTC(2026, 8, 19),views:0}]};
  const html = trafficSummary(data, '30d', true);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /id="traffic-range-7d"[^>]*aria-pressed="true"[^>]*disabled/);
  assert.match(html, /id="traffic-range-30d"[^>]*aria-pressed="false"[^>]*disabled/);
  assert.equal((html.match(/type="button"/g) || []).length, 2);
  assert.match(html, /role="group" aria-label="时间范围"/);
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="访问量趋势图"/);
  assert.match(html, /<title>9\/19：0 次<\/title>/);
  assert.doesNotMatch(html, /暂无访问数据/);
  const empty = trafficSummary(null, '30d', true);
  assert.match(empty, /id="traffic-range-30d"[^>]*aria-pressed="true"[^>]*disabled/);
});

test('non-numeric or absent traffic values remain unknown instead of becoming zero', () => {
  const html = trafficSummary({range:'7d', interval:'day', points:[null, undefined, ...[null, undefined, NaN, Infinity, '4', false].map(views => ({start:Date.UTC(2026, 8, 19),views}))]});
  assert.match(html, /暂无访问数据/);
  assert.doesNotMatch(html, /<svg|NaN|Infinity|undefined/);
});
