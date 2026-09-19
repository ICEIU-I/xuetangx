import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountPassword } from '../src/settings/password.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('shared password panel groups fields and separates the submit action', () => {
  const listeners = new Map();
  const host = {
    innerHTML: '',
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  const dispose = mountPassword(host);
  assert.match(host.innerHTML, /class="surface password-panel" aria-labelledby="password-heading"/);
  assert.equal((host.innerHTML.match(/class="password-field"/g) || []).length, 2);
  assert.match(host.innerHTML, /class="password-actions"><button class="primary" type="submit"/);
  assert.match(host.innerHTML, /aria-describedby="password-hint"/);
  assert.match(host.innerHTML, /保存后需重新登录，其他设备也会退出。/);
  for (const name of ['current-password', 'new-password']) {
    assert.ok(host.innerHTML.includes(`for="${name}"`));
    assert.ok(host.innerHTML.includes(`id="${name}"`));
    assert.ok(host.innerHTML.includes(`autocomplete="${name}"`));
  }
  assert.ok(listeners.has('submit'));
  dispose();
  assert.equal(listeners.size, 0);
});

test('password layout caps desktop widths and uses full-width mobile actions', () => {
  const css = source('../src/styles/settings-password.css');
  assert.match(css, /\.surface\.password-panel\s*\{[^}]*max-width:\s*560px/s);
  assert.match(css, /\.password-panel \.password-form\s*\{[^}]*gap:\s*20px[^}]*max-width:\s*500px/s);
  assert.match(css, /\.password-panel \.password-field\s*\{[^}]*gap:\s*8px/s);
  assert.match(css, /\.password-panel \.password-actions\s*\{[^}]*padding-top:\s*20px[^}]*border-top:/s);
  assert.match(css, /@media\s*\(max-width:\s*600px\)[\s\S]*\.password-actions button\s*\{\s*width:\s*100%/);
  assert.ok(source('../src/styles/user.css').includes('@import "./settings-password.css";'));
});

test('both settings pages retain shared password handling and sign-in revocation', () => {
  for (const path of ['../src/settings/page.js', '../src/admin/settings.js']) {
    assert.match(source(path), /mountPassword\(/);
  }
  const js = source('../src/settings/password.js');
  assert.match(js, /if \(busy\) return/);
  assert.match(js, /request\('\/api\/auth\/change-password', json\('POST', \{ currentPassword: field\(form, 'currentPassword'\), password: field\(form, 'password'\) \}\)\)/);
  assert.match(js, /form\.reset\(\)/);
  assert.match(js, /window\.dispatchEvent\(new Event\('auth-required'\)\)/);
  assert.match(js, /form\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(js, /form\.setAttribute\('aria-busy', 'false'\)/);
  assert.ok(js.includes('form.querySelector(\'button[type="submit"]\')'));
  assert.match(js, /bindPasswordToggles\(host, life\)/);
});
