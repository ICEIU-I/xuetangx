import { listSearch, matchesSearch } from '../shared/list-search.js';
import { request } from '../api.js';
import { escape as e, field, json, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
export function mountCollectors(host) {
  const life = lifetime(); let accounts = [], editing, open = false, busy = false, error = '', notice = '';
  const search = listSearch(host, life, 'collector-search', '搜索备注、昵称、账号或状态', () => draw(), () => busy);
  const accountStatus = a => !a.enabled ? '已停用' : a.valid ? '可用' : 'Cookie 需更新';
  function draw() {
    if (!life.alive) return;
    const visible = accounts.filter(a => matchesSearch(search.query, a.label, a.name, a.userId, accountStatus(a)));
    render(host, `<header class="page-heading"><h1>采集账号</h1><button id="collector-add" class="primary"${disabled(busy)}>添加账号</button></header><section class="surface"><header class="section-heading"><h2>全站采集账号</h2><span class="muted">${visible.length} / ${accounts.length} 个</span></header>${!open ? search.markup() : ''}${feedback(error)}${feedback(notice,'neutral')}${open ? `<form id="collector-form" class="record-card"><h3>${editing ? '更新 Cookie' : '添加账号'}</h3><label for="collector-label">账号备注</label><input id="collector-label" name="label" maxlength="30" value="${e(editing?.label || '')}"><label for="collector-cookie">学堂在线 Cookie</label><textarea id="collector-cookie" name="cookie" rows="4" autocomplete="off" spellcheck="false" required></textarea><p class="muted">采集时可能提交作答，消耗该账号的作答机会。</p><div class="row"><button class="primary"${disabled(busy)}>验证并保存</button><button id="collector-cancel" type="button"${disabled(busy)}>取消</button></div></form>` : ''}${!visible.length && !open ? '<p class="empty-state">没有匹配的采集账号</p>' : ''}<div class="card-list">${visible.map(a => `<article class="record-card"><header class="section-heading"><strong>${e(a.label || a.name || '采集账号')}</strong><span class="status-pill ${a.enabled && a.valid ? 'done' : ''}">${!a.enabled ? '已停用' : a.valid ? '可用' : 'Cookie 需更新'}</span></header><p class="muted">${e(a.name || '平台账号')} · ${e(a.userId)}</p><p class="muted">最近验证 ${a.updatedAt ? new Date(a.updatedAt).toLocaleString() : '—'}</p><div class="row"><button data-edit="${e(a.id)}"${disabled(busy)}>更新 Cookie</button><button data-check="${e(a.id)}"${disabled(busy)}>检查有效性</button><button data-toggle="${e(a.id)}"${disabled(busy)}>${a.enabled ? '停用' : '启用'}</button></div></article>`).join('')}</div></section>`);
  }
  async function load() { accounts = (await request('/api/admin/collectors')).accounts || []; }
  async function act(fn,message) { if (busy) return; busy = true; error = ''; notice = ''; host.querySelectorAll('button').forEach(b => { b.disabled = true; }); try { await fn(); await load(); notice = message; } catch (err) { error = err.message; } finally { busy = false; draw(); } }
  life.add(delegate(host,'click','#collector-add',() => { editing = null; open = true; error = ''; notice = ''; draw(); }));
  life.add(delegate(host,'click','#collector-cancel',() => { open = false; draw(); }));
  life.add(delegate(host,'click','[data-edit]',(_,el) => { editing = accounts.find(a => a.id === el.dataset.edit); open = true; error = ''; notice = ''; draw(); }));
  life.add(delegate(host,'submit','#collector-form',(event,form) => { event.preventDefault(); const body = { label:field(form,'label'),cookie:field(form,'cookie') }; act(async () => { await request(`/api/admin/collectors${editing ? '/'+encodeURIComponent(editing.id) : ''}`,json(editing ? 'PUT' : 'POST',body)); form.reset(); open = false; },'账号已保存'); }));
  life.add(delegate(host,'click','[data-check]',(_,el) => act(() => request(`/api/admin/collectors/${encodeURIComponent(el.dataset.check)}/check`,{method:'POST'}),'Cookie 有效')));
  life.add(delegate(host,'click','[data-toggle]',(_,el) => { const a = accounts.find(a => a.id === el.dataset.toggle); act(() => request(`/api/admin/collectors/${encodeURIComponent(a.id)}/enabled`,json('POST',{enabled:!a.enabled})),a.enabled ? '已停用' : '已启用'); }));
  draw(); act(async () => {},''); return life.dispose;
}
