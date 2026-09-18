import { api } from '../api.js';
import { summary, statusNames, formatDate } from '../features/workspace/presentation.js';
import { escape as e, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
export function mountHistory(host, workspace) {
  const life = lifetime(); let ids = [], offset = 0, total = 0, busy = true, error = '', generation = 0;
  function draw() {
    if (!life.alive) return;
    const jobs = ids.map(id => workspace.state.jobs.find(j => j.id === id)).filter(Boolean);
    render(host, `<header class="page-heading"><h1>任务记录</h1><button id="history-refresh"${disabled(busy)}>刷新</button></header><section class="surface history-surface"><div class="section-heading"><h2>全部任务</h2><span class="muted">${total} 条</span></div>${feedback(error)}${busy && !jobs.length ? '<div class="loading-state">正在读取任务…</div>' : !jobs.length ? '<div class="empty-state"><p>暂无任务</p><a data-route href="/learn" class="button primary">前往课程任务</a></div>' : jobs.map(job => { const stats = summary(job); return `<a data-route href="/tasks/${encodeURIComponent(job.id)}" class="task-record"><div class="record-main"><strong>${e(job.course.title)}</strong><span>${formatDate(job.createdAt)} · 账号 ${e(job.primaryId)}</span></div><div class="record-progress"><strong>${stats.completed} / ${stats.known ? stats.total : '—'}</strong><small>已完成</small></div><span class="status-pill ${e(job.status)}">${statusNames[job.status] || '需要处理'}</span><span aria-hidden="true">→</span></a>`; }).join('')}${total > 20 ? `<div class="pager"><button data-page="${offset-20}"${disabled(busy || !offset)}>上一页</button><span>${offset+1}–${Math.min(offset+20,total)} / ${total}</span><button data-page="${offset+20}"${disabled(busy || offset+20 >= total)}>下一页</button></div>` : ''}</section>`);
  }
  async function load(next = offset, quiet = false) { const token = ++generation; if (!quiet) busy = true; error = ''; draw(); try { const result = await api.workflowState(next,20); if (!life.alive || token !== generation) return; (result.jobs || []).forEach(workspace.mergeJob); ids = (result.jobs || []).map(j => j.id); offset = next; total = result.pagination?.total || 0; } catch (err) { if (token === generation) error = err.message; } finally { if (token === generation) { busy = false; draw(); } } }
  life.add(delegate(host,'click','#history-refresh',() => load())); life.add(delegate(host,'click','[data-page]',(_,el) => load(Number(el.dataset.page)))); life.add(workspace.subscribe(draw));
  const timer = setInterval(() => { if (!busy) load(offset,true); },15000); life.add(() => { generation++; clearInterval(timer); }); load(); return life.dispose;
}
