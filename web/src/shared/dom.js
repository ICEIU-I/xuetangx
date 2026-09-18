export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const disabled = value => value ? ' disabled' : '';
export const feedback = (message, kind = 'error') => message ? `<p class="feedback ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${escape(message)}</p>` : '';
export function field(form, name) { return new FormData(form).get(name)?.toString() || ''; }
export function json(method, body) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
// Preserve keyboard focus and expanded details during live updates.
export function render(host, html) {
  const active = host.contains(document.activeElement) ? document.activeElement : null;
  const key = active?.id || active?.dataset.focus;
  const selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const expanded = new Set([...host.querySelectorAll('details[open][data-key]')].map(el => el.dataset.key));
  host.innerHTML = html;
  host.querySelectorAll('details[data-key]').forEach(el => { if (expanded.has(el.dataset.key)) el.open = true; });
  if (key) {
    const next = host.querySelector(`#${CSS.escape(key)}, [data-focus="${CSS.escape(key)}"]`);
    next?.focus({ preventScroll: true });
    if (selection && next?.setSelectionRange && selection[0] !== null) { try { next.setSelectionRange(...selection); } catch {} }
  }
}
export function delegate(host, type, selector, callback) {
  const listener = event => { const target = event.target.closest(selector); if (target && host.contains(target)) callback(event, target); };
  host.addEventListener(type, listener);
  return () => host.removeEventListener(type, listener);
}
export function lifetime() {
  let alive = true; const cleanups = [];
  return { get alive() { return alive; }, add(fn) { cleanups.push(fn); return fn; }, dispose() { alive = false; cleanups.splice(0).forEach(fn => fn()); } };
}
