import { passwordField, bindPasswordToggles } from '../shared/password-field.js';
import { brandMarkup } from '../shared/brand.js';
import { request } from '../api.js';
import { escape as e, field, json, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
import { registrationCodeFields, registrationCooldown } from './registration-code.js';

export function mountLogin(host, authenticated) {
  const life = lifetime();
  bindPasswordToggles(host, life);
  let mode = 'login', email = '', error = '', message = '', busy = false, config = null, token = '', code = '', draftPassword = '', resendAt = 0;
  const hash = new URLSearchParams(location.hash.slice(1));
  for (const kind of ['verify', 'reset']) if (hash.has(kind)) { mode = kind; token = hash.get(kind); history.replaceState({}, '', location.pathname + location.search); }
  const titles = { login: '登录', register: '注册', forgot: '找回密码', reset: '设置新密码', verify: '验证邮箱' };
  function snapshot() {
    const password = host.querySelector('#auth-password'), inputCode = host.querySelector('#auth-code');
    if (password) draftPassword = password.value;
    if (inputCode) code = inputCode.value;
  }
  function clearSecrets() { token = ''; code = ''; draftPassword = ''; }
  function draw(keepDraft = true) {
    if (!life.alive) return;
    if (keepDraft) snapshot();
    render(host, `<main class="auth-page"><a class="auth-brand" href="/" aria-label="CCF 首页">${brandMarkup()}</a><section class="auth-card"><div class="auth-window-bar" aria-hidden="true"><span class="auth-window-pixels"><i></i><i></i><i></i></span></div><div class="auth-content"><header class="card-header"><h1>${titles[mode]}</h1></header>${!config && !error ? '<div class="pixel-loader" role="status">正在连接…</div>' : ''}<form id="auth-form">
      ${mode !== 'verify' && !(mode === 'reset' && token) ? `<label for="auth-email">邮箱</label><input id="auth-email" name="email" type="email" autocomplete="${mode === 'login' ? 'username' : 'email'}" value="${e(email)}" placeholder="you@example.com" ${mode === 'reset' ? 'readonly' : ''} required>` : ''}
      ${mode === 'reset' && !token ? `<label for="auth-code">邮箱验证码</label><input id="auth-code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" value="${e(code)}" placeholder="6 位验证码" required>` : ''}
      ${['login','register','reset'].includes(mode) ? `<label for="auth-password">${mode === 'reset' ? '新密码' : '密码'}</label>${passwordField({id:'auth-password',name:'password',autocomplete:mode === 'login' ? 'current-password' : 'new-password',maxLength:256})}` : ''}
      ${mode === 'register' && config?.emailVerificationRequired ? registrationCodeFields({code,busy,remaining:registrationCooldown(resendAt),emailEnabled:config.emailEnabled}) : ''}
      <button class="primary"${disabled(busy || !config || (mode === 'register' && config.emailVerificationRequired && !config.emailEnabled))}>${busy ? '处理中…' : mode === 'register' ? '创建账号' : mode === 'verify' ? '确认验证邮箱' : mode === 'forgot' ? '发送验证码' : mode === 'reset' ? '设置新密码' : '登录'}</button>
      </form>${busy ? '<div class="pixel-loader" role="status">处理中…</div>' : ''}${feedback(error)}${feedback(message, 'neutral')}<div class="auth-links">${mode === 'login' ? '<button data-mode="register" class="text-button">注册账号</button>' : '<button data-mode="login" class="text-button">返回登录</button>'}${mode === 'login' && config?.emailEnabled ? '<button data-mode="forgot" class="text-button">忘记密码</button>' : ''}${email && config?.emailEnabled && config?.emailVerificationRequired && mode === 'login' ? `<button data-resend class="text-button"${disabled(busy)}>重发旧账号验证邮件</button>` : ''}</div></div></section></main>`);
    const input = host.querySelector('#auth-password'); if (input) input.value = draftPassword;
  }
  async function refreshConfig() { const result = await request('/api/auth/config'); if (life.alive) config = result; }
  async function handleError(err) {
    error = err.message;
    if (['EMAIL_CODE_REQUIRED', 'REGISTRATION_VERIFICATION_DISABLED'].includes(err.code)) { try { await refreshConfig(); } catch {} }
  }
  life.add(delegate(host, 'input', '#auth-email', (_, input) => { email = input.value; code = ''; const c = host.querySelector('#auth-code'); if (c) c.value = ''; }));
  life.add(delegate(host, 'click', '[data-mode]', (_, button) => { if (busy) return; mode = button.dataset.mode; clearSecrets(); error = ''; message = ''; draw(false); }));
  life.add(delegate(host, 'click', '[data-registration-code]', async () => {
    if (busy || registrationCooldown(resendAt) || !config?.emailEnabled) return;
    const input = host.querySelector('#auth-email'); if (!input?.reportValidity()) return;
    email = input.value; snapshot(); busy = true; error = ''; message = ''; draw(false);
    try {
      const result = await request('/api/auth/registration-code', json('POST', {email}));
      if (!life.alive) return;
      resendAt = Date.now() + (result.retryAfter || 60) * 1000;
      message = '验证码请求已提交。如邮箱可以注册，将收到注册验证码。';
    } catch (err) { await handleError(err); } finally { busy = false; draw(); }
  }));
  const timer = setInterval(() => {
    if (!life.alive) return;
    const button = host.querySelector('[data-registration-code]'); if (!button) return;
    const remaining = registrationCooldown(resendAt);
    button.textContent = remaining ? `${remaining} 秒后重发` : '发送验证码';
    button.disabled = busy || remaining > 0 || !config?.emailEnabled;
  }, 1000);
  life.add(() => { clearInterval(timer); clearSecrets(); });
  life.add(delegate(host, 'click', '[data-resend]', async () => {
    if (busy) return; busy = true; draw();
    try { await request('/api/auth/resend', json('POST', { email })); message = '如账号尚未验证，验证邮件将发送至邮箱。'; } catch (err) { error = err.message; } finally { busy = false; draw(); }
  }));
  life.add(delegate(host, 'submit', '#auth-form', async (event, form) => {
    event.preventDefault(); if (busy || !config) return;
    const password = field(form, 'password'); email = field(form, 'email') || email; code = field(form, 'code'); draftPassword = password;
    busy = true; error = ''; message = ''; draw(false); let completed = false;
    try {
      if (mode === 'login') { const result = await request('/api/auth/login', json('POST', { email, password })); if (life.alive) authenticated(result.user); completed = true; }
      else if (mode === 'register') { await request('/api/auth/register', json('POST', { email, password, code })); mode = 'login'; message = '注册成功，请登录。'; completed = true; }
      else if (mode === 'forgot') { await request('/api/auth/forgot-password', json('POST', { email })); mode = 'reset'; message = '如果邮箱已注册，验证码将发送至邮箱。'; }
      else if (mode === 'reset' && !token) { await request('/api/auth/verify-reset-code', json('POST', { email, code, password })); mode = 'login'; message = '密码已更新，请登录。'; completed = true; }
      else { await request(`/api/auth/${mode === 'reset' ? 'reset-password' : 'verify'}`, json('POST', { token, ...(mode === 'reset' ? { password } : {}) })); mode = 'login'; message = '已更新，请登录。'; completed = true; }
    } catch (err) { await handleError(err); } finally { busy = false; if (completed) clearSecrets(); draw(false); }
  }));
  draw(); refreshConfig().then(() => draw()).catch(err => { error = err.message; draw(); });
  return life.dispose;
}
