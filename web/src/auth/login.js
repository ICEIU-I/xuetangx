import { passwordField, bindPasswordToggles } from '../shared/password-field.js';
import { brandMarkup } from '../shared/brand.js';
import { request } from '../api.js';
import { escape as e, field, json, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
export function mountLogin(host, authenticated) {
  const life = lifetime();
  bindPasswordToggles(host, life);
  let mode = 'login', email = '', error = '', message = '', busy = false, config = null, token = '', resetCode = '';
  const hash = new URLSearchParams(location.hash.slice(1));
  for (const kind of ['verify', 'reset']) if (hash.has(kind)) { mode = kind; token = hash.get(kind); history.replaceState({}, '', location.pathname + location.search); }
  const titles = { login: '登录', register: '注册', forgot: '找回密码', reset: '设置新密码', verify: '验证邮箱' };
  function draw() {
    if (!life.alive) return;
    render(host, `<main class="auth-page"><a class="auth-brand" href="/" aria-label="CCF 首页">${brandMarkup()}</a><section class="auth-card"><div class="auth-window-bar" aria-hidden="true"><span class="auth-window-pixels"><i></i><i></i><i></i></span></div><div class="auth-content"><header class="card-header"><h1>${titles[mode]}</h1></header>${!config && !error ? '<div class="pixel-loader" role="status">正在连接…</div>' : ''}<form id="auth-form">
      ${mode !== 'verify' && !(mode === 'reset' && token) ? `<label for="auth-email">邮箱</label><input id="auth-email" name="email" type="email" autocomplete="${mode === 'login' ? 'username' : 'email'}" value="${e(email)}" placeholder="you@example.com" ${mode === 'reset' ? 'readonly' : ''} required>` : ''}
      ${mode === 'reset' && !token ? `<label for="auth-code">邮箱验证码</label><input id="auth-code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" value="${e(resetCode)}" placeholder="6 位验证码" required>` : ''}
      ${['login','register','reset'].includes(mode) ? `<label for="auth-password">密码</label>${passwordField({id:'auth-password',name:'password',autocomplete:mode === 'login' ? 'current-password' : 'new-password',maxLength:256})}` : ''}
      <button class="primary"${disabled(busy || !config)}>${busy ? '处理中…' : mode === 'register' ? '创建账号' : mode === 'verify' ? '确认验证邮箱' : mode === 'forgot' ? '发送验证码' : mode === 'reset' ? '设置新密码' : '登录'}</button>
      </form>${busy ? '<div class="pixel-loader" role="status">处理中…</div>' : ''}${feedback(error)}${feedback(message, 'neutral')}<div class="auth-links">${mode === 'login' ? '<button data-mode="register" class="text-button">注册账号</button>' : '<button data-mode="login" class="text-button">返回登录</button>'}${mode === 'login' && config?.emailEnabled ? '<button data-mode="forgot" class="text-button">忘记密码</button>' : ''}${email && config?.emailEnabled && config?.emailVerificationRequired && ['login','register'].includes(mode) ? `<button data-resend class="text-button"${disabled(busy)}>重发验证邮件</button>` : ''}</div></div></section></main>`);
  }
  life.add(delegate(host, 'input', '#auth-email', (_, input) => { email = input.value; }));
  life.add(delegate(host, 'click', '[data-mode]', (_, button) => { if (busy) return; mode = button.dataset.mode; error = ''; message = ''; draw(); }));
  life.add(delegate(host, 'click', '[data-resend]', async () => {
    if (busy) return; busy = true; draw();
    try { await request('/api/auth/resend', json('POST', { email })); message = '验证邮件已发送。'; } catch (err) { error = err.message; } finally { busy = false; draw(); }
  }));
  life.add(delegate(host, 'submit', '#auth-form', async (event, form) => {
    event.preventDefault(); if (busy || !config) return;
    const password = field(form, 'password'); email = field(form, 'email') || email; busy = true; error = ''; message = ''; draw();
    try {
      if (mode === 'login') { const result = await request('/api/auth/login', json('POST', { email, password })); if (life.alive) authenticated(result.user); }
      else if (mode === 'register') { await request('/api/auth/register', json('POST', { email, password })); mode = 'login'; message = config.emailVerificationRequired ? '请先通过邮件验证邮箱。' : '注册成功，请登录。'; }
      else if (mode === 'forgot') { await request('/api/auth/forgot-password', json('POST', { email })); mode = 'reset'; message = '如果邮箱已注册，验证码将发送至邮箱。'; }
      else if (mode === 'reset' && !token) { resetCode = field(form, 'code'); await request('/api/auth/verify-reset-code', json('POST', { email, code: resetCode, password })); mode = 'login'; resetCode = ''; message = '密码已更新，请登录。'; }
      else { await request(`/api/auth/${mode === 'reset' ? 'reset-password' : 'verify'}`, json('POST', { token, ...(mode === 'reset' ? { password } : {}) })); mode = 'login'; token = ''; message = '已更新，请登录。'; }
    } catch (err) { error = err.message; } finally { busy = false; draw(); }
  }));
  draw(); request('/api/auth/config').then(result => { config = result; draw(); }).catch(err => { error = err.message; draw(); });
  return life.dispose;
}
