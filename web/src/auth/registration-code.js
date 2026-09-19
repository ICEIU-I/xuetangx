import { escape as e, disabled } from '../shared/dom.js';
export function registrationCodeFields({ code = '', busy = false, remaining = 0, emailEnabled = true } = {}) {
  return `<label for="auth-code">邮箱验证码</label><div class="registration-code-row"><input id="auth-code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" value="${e(code)}" placeholder="6 位验证码" required><button type="button" data-registration-code${disabled(busy || remaining > 0 || !emailEnabled)}>${remaining > 0 ? `${remaining} 秒后重发` : '发送验证码'}</button></div><p class="registration-code-hint">${emailEnabled ? '验证码 10 分钟内有效；未收到时请检查垃圾邮件。' : '邮箱服务暂不可用，请稍后再试。'}</p>`;
}
export function registrationCooldown(until, now = Date.now()) { return Math.max(0, Math.ceil((until - now) / 1000)); }
