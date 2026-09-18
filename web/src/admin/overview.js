import { request } from '../api.js';
import { escape as e, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
import { listSearch } from '../shared/list-search.js';
import { pager } from './answer-library-view.js';
export function mountOverview(host) {
  const life = lifetime(); let metrics = {}, conflicts = [], total = 0, offset = 0, error = '', busy = false;
  const search = listSearch(host, life, 'conflict-search', '搜索课程、题干或题目 ID', () => load(0), () => busy);
  const labels = { users:'网站用户',activeUsers:'正常用户',availableCollectors:'可用采集账号',capturedAnswers:'标准答案',pendingOperations:'待核对操作',workerRestarts:'进程恢复次数' };
  function draw() { if (!life.alive) return; render(host, `<header class="page-heading"><h1>管理概览</h1><button id="metrics-refresh"${disabled(busy)}>刷新</button></header>${feedback(error)}<div class="overview-status"><span class="status-pill ${metrics.ready ? 'done' : 'queued'}">${metrics.ready ? '服务正常' : '正在检查服务'}</span></div><div class="metric-grid">${Object.entries(labels).map(([key,label]) => `<div class="metric"><span>${label}</span><strong>${metrics[key] ?? '—'}</strong></div>`).join('')}</div><section class="surface"><header class="section-heading"><h2>答案采集</h2><a data-route href="/admin/collectors" class="button primary">管理采集账号</a></header><p class="muted">${metrics.availableCollectors ?? '—'} 个账号可用</p></section><section class="surface"><header class="section-heading"><h2>题库冲突</h2><span class="status-pill">${total} 条待核验</span></header>${search.markup()}${conflicts.map(c => `<div class="record-card"><strong>${e(c.title || '未命名课程')}</strong><p class="muted">班级 ${e(c.classroomId)} · 题目 ${e(c.problemId)}</p></div>`).join('') || `<p class="muted">${search.query ? '没有匹配的冲突记录' : '暂无冲突'}</p>`}${pager(offset,30,total,busy,'data-conflict-page')}</section>`); }
  async function load(next = offset) {
    if (busy) return; busy = true; error = ''; draw();
    const results = await Promise.allSettled([request('/api/admin/metrics'),request(`/api/admin/conflicts?limit=30&offset=${next}&q=${encodeURIComponent(search.query)}`)]);
    if (!life.alive) return;
    if (results[0].status === 'fulfilled') metrics = results[0].value;
    if (results[1].status === 'fulfilled') { conflicts = results[1].value.conflicts || []; total = results[1].value.total || 0; offset = next; }
    error = results.filter(r => r.status === 'rejected').map(r => r.reason.message).join('；'); busy = false; draw();
  }
  life.add(delegate(host,'click','#metrics-refresh',() => load()));
  life.add(delegate(host,'click','[data-conflict-page]',(_, el) => load(Number(el.dataset.conflictPage)))); load(); return life.dispose;
}
