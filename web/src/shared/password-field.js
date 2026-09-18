import { escape as e, delegate } from './dom.js';

// No password value is copied into component state or storage.
const eye = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M2 10h3V7h4V5h6v2h4v3h3v4h-3v3h-4v2H9v-2H5v-3H2z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 9h4v6h-4z" fill="currentColor"/><path class="password-eye-slash" d="M3 3l18 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

export function passwordField({ id, name, autocomplete = 'current-password', maxLength, required = true }) {
  return `<span class="password-input"><input id="${e(id)}" name="${e(name)}" type="password" autocomplete="${e(autocomplete)}"${maxLength ? ` maxlength="${e(maxLength)}"` : ''}${required ? ' required' : ''}><button type="button" class="password-toggle" data-password-toggle="${e(id)}" aria-controls="${e(id)}" aria-label="显示密码" aria-pressed="false" title="显示密码">${eye}</button></span>`;
}

export function setPasswordVisibility(input, button, visible) {
  const start = input.selectionStart, end = input.selectionEnd;
  input.type = visible ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  button.title = visible ? '隐藏密码' : '显示密码';
  if (start !== null && end !== null) { try { input.setSelectionRange(start, end); } catch {} }
}

export function bindPasswordToggles(host, life) {
  life.add(delegate(host, 'click', '[data-password-toggle]', (event, button) => {
    event.preventDefault();
    const input = button.parentElement?.querySelector('input');
    if (!input || input.id !== button.dataset.passwordToggle || input.disabled) return;
    setPasswordVisibility(input, button, input.type === 'password');
  }));
  life.add(delegate(host, 'reset', 'form', (_, form) => {
    form.querySelectorAll('[data-password-toggle]').forEach(button => {
      const input = button.parentElement?.querySelector('input');
      if (input) setPasswordVisibility(input, button, false);
    });
  }));
}
