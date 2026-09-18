import { request } from '../api.js';
import { feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
import { listSearch } from '../shared/list-search.js';
import { pager } from './answer-library-view.js';
import { serviceStatus, overviewLinks, conflictRows, systemDetails } from './overview-view.js';

export function mountOverview(host) {
  const life = lifetime(), abort = new AbortController();
  let metrics = null, conflicts = [], total = 0, offset = 0, error = '', busy = false, loaded = false;
  const search = listSearch(host, life, 'conflict-search', '搜索课程、题干或题目 ID', () => load(0), () => busy);
  function draw() {
    if (!life.alive) return;
    const content = !loaded ? busy ? '<div class="loading-state" role="status">正在读取…</div>' : '<p class="overview-empty">暂时无法读取</p>' : `${total || search.query ? search.markup() : ''}${conflictRows(conflicts, search.query)}${pager(offset,30,total,busy,'data-conflict-page')}`;
    render(host, `<div class="admin-overview"><header class="page-heading"><h1>概览</h1><div class="overview-actions">${serviceStatus(metrics)}<button id="metrics-refresh"${disabled(busy)}>刷新</button></div></header>${feedback(error)}${overviewLinks(metrics)}<section class="overview-conflicts" aria-busy="${busy}"><header class="section-heading"><h2>题库冲突</h2>${loaded ? `<span class="overview-count">${total}</span>` : ''}</header>${content}</section>${systemDetails(metrics)}</div>`);
  }
  async function load(next = offset) {
    if (busy || !life.alive) return;
    busy = true; error = ''; draw();
    const results = await Promise.allSettled([
      request('/api/admin/metrics', {signal:abort.signal}),
      request(`/api/admin/conflicts?limit=30&offset=${next}&q=${encodeURIComponent(search.query)}`, {signal:abort.signal}),
    ]);
    if (!life.alive) return;
    if (results[0].status === 'fulfilled') metrics = results[0].value;
    if (results[1].status === 'fulfilled') {
      conflicts = results[1].value.conflicts || []; total = results[1].value.total || 0; offset = next; loaded = true;
    }
    error = results.filter(r => r.status === 'rejected').map(r => r.reason.message).join('；');
    busy = false; draw();
  }
  life.add(delegate(host,'click','#metrics-refresh',() => load()));
  life.add(delegate(host,'click','[data-conflict-page]',(_, el) => load(Number(el.dataset.conflictPage))));
  life.add(() => abort.abort());
  load(); return life.dispose;
}
