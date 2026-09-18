import { request } from '../api.js';
import { escape as e, field, json, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
export function mountTokens(host) {
  const life = lifetime(); let tokens = [], created = '', error = '', busy = false;
  function draw() { if (!life.alive) return; render(host, `<section class="surface"><h2>个人访问令牌</h2><p class="muted">用于命令行访问，有效期 90 天。</p><form id="token-form" class="input-action"><label for="token-name">令牌名称</label><input id="token-name" name="name" maxlength="100" required placeholder="例如：我的电脑"><button class="primary"${disabled(busy)}>创建令牌</button></form>${created ? `<div class="feedback neutral"><p>令牌仅显示一次，请保存。</p><textarea readonly aria-label="新访问令牌">${e(created)}</textarea><button id="token-close">已保存</button></div>` : ''}${feedback(error)}<ul class="token-list">${tokens.map(t => `<li><div>${e(t.name || '未命名')}<small>${new Date(t.expiresAt).toLocaleDateString()} 到期</small></div><button data-revoke="${e(t.id)}"${disabled(busy)}>撤销</button></li>`).join('')}</ul>${!tokens.length ? '<p class="muted">暂无令牌</p>' : ''}</section>`); }
  async function load() { tokens = (await request('/api/tokens')).tokens || []; }
  async function act(fn) { if (busy) return; busy = true; error = ''; draw(); try { await fn(); await load(); } catch (err) { error = err.message; } finally { busy = false; draw(); } }
  life.add(delegate(host,'submit','#token-form',(event,form) => { event.preventDefault(); const name = field(form,'name'); act(async () => { created = (await request('/api/tokens',json('POST',{name}))).token; }); }));
  life.add(delegate(host,'click','[data-revoke]',(_,el) => act(() => request(`/api/tokens/${encodeURIComponent(el.dataset.revoke)}`,{method:'DELETE'}))));
  life.add(delegate(host,'click','#token-close',() => { created = ''; draw(); }));
  load().catch(err => { error = err.message; }).finally(draw); draw(); return life.dispose;
}
