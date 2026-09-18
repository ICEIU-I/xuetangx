import { request } from '../api.js';
import { field, json, feedback, delegate, lifetime } from '../shared/dom.js';
import { passwordField, bindPasswordToggles } from '../shared/password-field.js';
export function mountPassword(host) {
  const life = lifetime(); let busy = false;
  host.innerHTML = `<section class="surface password-panel" aria-labelledby="password-heading">
    <header class="password-heading"><h2 id="password-heading">修改密码</h2><p class="muted" id="password-hint">保存后需重新登录，其他设备也会退出。</p></header>
    <form id="password-form" class="password-form" aria-describedby="password-hint">
      <div class="password-field"><label for="current-password">当前密码</label>${passwordField({ id: 'current-password', name: 'currentPassword', autocomplete: 'current-password' })}</div>
      <div class="password-field"><label for="new-password">新密码</label>${passwordField({ id: 'new-password', name: 'password', autocomplete: 'new-password', maxLength: 256 })}</div>
      <div class="password-actions"><button class="primary" type="submit">保存并重新登录</button></div>
      <div class="password-feedback"></div>
    </form>
  </section>`;
  bindPasswordToggles(host, life);
  life.add(delegate(host, 'submit', '#password-form', async (event, form) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = '正在保存…';
    form.setAttribute('aria-busy', 'true');
    host.querySelector('.password-feedback').innerHTML = '';
    try {
      await request('/api/auth/change-password', json('POST', { currentPassword: field(form, 'currentPassword'), password: field(form, 'password') }));
      form.reset();
      window.dispatchEvent(new Event('auth-required'));
    } catch (err) {
      if (life.alive) host.querySelector('.password-feedback').innerHTML = feedback(err.message);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = '保存并重新登录';
      form.setAttribute('aria-busy', 'false');
    }
  }));
  return life.dispose;
}
