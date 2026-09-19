import { request } from '../api.js';
import { feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
import { serviceStatus, overviewLinks, systemDetails } from './overview-view.js';
import { performanceSummary } from './performance-view.js';

export function mountOverview(host) {
  const life = lifetime(), abort = new AbortController();
  let metrics = null, error = '', busy = false;
  function draw() {
    if (!life.alive) return;
    render(host, `<div class="admin-overview"><header class="page-heading"><h1>概览</h1><div class="overview-actions">${serviceStatus(metrics)}<button id="metrics-refresh"${disabled(busy)}>刷新</button></div></header>${feedback(error)}${overviewLinks(metrics)}${performanceSummary(metrics?.performance, busy)}${systemDetails(metrics)}</div>`);
  }
  async function load() {
    if (busy || !life.alive) return;
    busy = true; error = ''; draw();
    try {
      const result = await request('/api/admin/metrics', {signal:abort.signal});
      if (life.alive) metrics = result;
    } catch (err) {
      if (life.alive) error = err.message;
    } finally {
      busy = false; draw();
    }
  }
  life.add(delegate(host,'click','#metrics-refresh',() => load()));
  life.add(() => abort.abort());
  load(); return life.dispose;
}
