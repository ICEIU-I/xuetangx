export function observable(initial) {
  const listeners = new Set(); let pending = false;
  const state = new Proxy(initial, { set(target, key, value) {
    if (target[key] === value) return true;
    target[key] = value;
    if (!pending) { pending = true; queueMicrotask(() => { pending = false; listeners.forEach(fn => fn()); }); }
    return true;
  } });
  return { state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, clear() { listeners.clear(); } };
}
