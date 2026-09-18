import { request } from '../api.js';
import { field, json, feedback, delegate, lifetime } from '../shared/dom.js';
export function mountPassword(host) {
  const life = lifetime(); let busy = false;
  host.innerHTML = '<section class="surface"><h2>修改密码</h2><p class="muted">保存后，所有设备和访问令牌将退出。</p><form id="password-form"><label for="current-password">当前密码</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required><label for="new-password">新密码</label><input id="new-password" name="password" type="password" autocomplete="new-password" maxlength="256" required><button class="primary">保存并重新登录</button></form><div class="password-feedback"></div></section>';
  life.add(delegate(host,'submit','#password-form',async (event,form) => { event.preventDefault(); if (busy) return; busy = true; const button = form.querySelector('button'); button.disabled = true; try { await request('/api/auth/change-password',json('POST',{ currentPassword:field(form,'currentPassword'), password:field(form,'password') })); form.reset(); window.dispatchEvent(new Event('auth-required')); } catch (err) { if (life.alive) host.querySelector('.password-feedback').innerHTML = feedback(err.message); } finally { busy = false; button.disabled = false; } }));
  return life.dispose;
}
