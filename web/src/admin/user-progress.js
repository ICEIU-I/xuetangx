import { request } from '../api.js';
import { modules, finished, percent, summary, statusNames, formatDate } from '../features/workspace/presentation.js';
import { escape as e, disabled, feedback, render, delegate, lifetime } from '../shared/dom.js';
import { navigate } from '../router.js';

function jobMarkup(job) {
  const stats = summary(job);
  const visible = modules.filter(item => job.modules?.[item.kind]);
  return `<section class="surface admin-task-progress"><header class="course-heading"><div class="course-heading-info"><h2>${e(job.course.title)}</h2><span class="status-pill ${e(job.status)}">${e(statusNames[job.status] || job.status)}</span></div><div class="admin-task-meta"><span>创建时间</span><strong>${e(formatDate(job.createdAt))}</strong></div></header><div class="overall-progress"><div><strong>${stats.completed}</strong><span> / ${stats.known ? stats.total : '—'}</span><small>${stats.known ? '已完成' : '正在扫描总量'}</small></div>${stats.known ? `<span class="overall-percent">${stats.percent}%</span>` : ''}</div>${stats.known ? `<progress value="${stats.percent}" max="100" aria-label="任务总体进度"></progress>` : '<div class="unknown-progress" aria-label="正在扫描课程"></div>'}<div class="module-list">${visible.map((item,index) => { const m = job.modules[item.kind]; return `<div class="module-row"><span class="module-icon">0${index+1}</span><div class="module-body"><div class="module-line"><strong>${item.title}</strong><span class="muted">${e(statusNames[m.status] || '等待开始')}</span></div><progress value="${percent(m)}" max="100" aria-label="${item.title}进度"></progress></div><div class="module-count">${finished(m)}<span> / ${m.total || (m.status === 'done' ? 0 : '—')}</span></div></div>`; }).join('')}</div><details class="task-details" data-key="admin-task-info"><summary>任务信息</summary><div class="detail-content meta-grid"><div><span>任务编号</span><strong>${e(job.id)}</strong></div><div><span>平台账号</span><strong>${e(job.primaryId)}</strong></div><div><span>更新时间</span><strong>${e(formatDate(job.updatedAt))}</strong></div></div></details></section>`;
}

export function mountUserProgress(host, userId) {
  const life = lifetime(); let data = null, selected = '', busy = false, error = '';
  function draw() {
    if (!life.alive) return;
    const jobs = data?.jobs || [], job = jobs.find(item => item.id === selected) || jobs[0];
    render(host, `<header class="page-heading"><div><a class="back-link" data-route href="/admin/users">← 用户管理</a><h1>${e(data?.email ? `${data.email} · 任务进度` : '用户任务进度')}</h1></div><button id="admin-user-refresh"${disabled(busy)}>刷新</button></header>${feedback(error)}${busy && !data ? '<div class="surface loading-state">正在读取任务进度…</div>' : !jobs.length ? '<section class="surface empty-state">该用户暂无任务记录。</section>' : `<div class="admin-job-tabs">${jobs.map(item => `<button data-job="${e(item.id)}" class="${item.id === (job?.id || '') ? 'selected' : ''}">${e(item.course.title)} · ${e(statusNames[item.status] || item.status)}</button>`).join('')}</div>${jobMarkup(job)}`}`);
  }
  async function load() { busy = true; error = ''; draw(); try { data = await request(`/api/admin/users/${encodeURIComponent(userId)}/jobs?limit=50`); selected = selected || data.jobs?.[0]?.id || ''; } catch (err) { error = err.message || '任务读取失败'; } finally { busy = false; draw(); } }
  life.add(delegate(host, 'click', '#admin-user-refresh', () => void load()));
  life.add(delegate(host, 'click', '[data-job]', (_, el) => { selected = el.dataset.job; draw(); }));
  load(); return life.dispose;
}
