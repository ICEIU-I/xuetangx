import { brandMarkup } from '../shared/brand.js';
import { request } from '../api.js';
import { escape as e, field, json, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
export function mountLogin(host, authenticated) {
  const life = lifetime();
  let mode = 'login', email = '', error = '', message = '', busy = false, config = null, token = '';
  const hash = new URLSearchParams(location.hash.slice(1));
  for (const kind of ['verify', 'reset']) if (hash.has(kind)) { mode = kind; token = hash.get(kind); history.replaceState({}, '', location.pathname + location.search); }
  const titles = { login: '登录', register: '注册', forgot: '找回密码', reset: '设置新密码', verify: '验证邮箱' };
  function draw() {
    if (!life.alive) return;
    render(host, `<main class="auth-page"><a class="auth-brand" href="/" aria-label="CCF 首页">${brandMarkup()}</a><section class="auth-card"><div class="auth-window-bar" aria-hidden="true"><span class="auth-window-pixels"><i></i><i></i><i></i></span></div><div class="auth-content"><header class="card-header"><h1>${titles[mode]}</h1></header>${!config && !error ? '<div class="pixel-loader auth-loader" role="status">正在连接…</div>' : ''}<form id="auth-form">
      ${!['reset','verify'].includes(mode) ? `<label for="auth-email">邮箱</label><input id="auth-email" name="email" type="email" autocomplete="${mode === 'login' ? 'username' : 'email'}" value="${e(email)}" placeholder="you@example.com" required>` : ''}
      ${['login','register','reset'].includes(mode) ? `<label for="auth-password">密码</label><input id="auth-password" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" maxlength="256" required>` : ''}
      <button class="primary"${disabled(busy || !config)}>${busy ? '处理中…' : mode === 'register' ? '创建账号' : mode === 'verify' ? '确认验证邮箱' : mode === 'forgot' ? '发送重置链接' : mode === 'reset' ? '保存新密码' : '登录'}</button>
      </form>${feedback(error)}${feedback(message, 'neutral')}<div class="auth-links">${mode === 'login' ? '<button data-mode="register" class="text-button">注册账号</button>' : '<button data-mode="login" class="text-button">返回登录</button>'}${mode === 'login' && config?.emailEnabled ? '<button data-mode="forgot" class="text-button">忘记密码</button>' : ''}${email && config?.emailEnabled && config?.emailVerificationRequired && ['login','register'].includes(mode) ? `<button data-resend class="text-button"${disabled(busy)}>重发验证邮件</button>` : ''}</div></div></section></main>`);
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
      else if (mode === 'forgot') { await request('/api/auth/forgot-password', json('POST', { email })); message = '如果邮箱已注册，重置链接将发送至邮箱。'; }
      else { await request(`/api/auth/${mode === 'reset' ? 'reset-password' : 'verify'}`, json('POST', { token, ...(mode === 'reset' ? { password } : {}) })); mode = 'login'; token = ''; message = '已更新，请登录。'; }
    } catch (err) { error = err.message; } finally { busy = false; draw(); }
  }));
  draw(); request('/api/auth/config').then(result => { config = result; draw(); }).catch(err => { error = err.message; draw(); });
  return life.dispose;
}
