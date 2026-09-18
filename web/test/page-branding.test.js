import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('tab branding uses a compact, font-independent pixel flight favicon', () => {
  const html = source('../index.html');
  const icon = source('../src/assets/ccf-icon.svg');
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/src\/assets\/ccf-icon\.svg"/);
  assert.doesNotMatch(html, /<text|data:image/);
  assert.match(icon, /viewBox="0 0 32 32"/);
  assert.match(icon, /shape-rendering="crispEdges"/);
  assert.match(icon, /<title>CCF/);
  for (const color of ['#ff6b73', '#69c8ef', '#ffd15c']) assert.ok(icon.includes(color));
  assert.doesNotMatch(icon, /<text|<script|<image|font-family/);
  for (const part of ['head', 'fist', 'arm', 'body', 'legs', 'cape']) assert.ok(icon.includes(`id="${part}"`));
});

test('browser tab keeps only CCF with no dynamic page suffix', () => {
  assert.match(source('../index.html'), /<title>CCF<\/title>/);
  for (const path of ['../src/router.js', '../src/auth/login.js']) {
    assert.doesNotMatch(source(path), /document\.title|setPageTitle|CCF ·|· CCF/);
  }
});
