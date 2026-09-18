import { feedback, lifetime } from '../shared/dom.js';
import { mountProgress } from './progress.js';
export function mountDetail(host, workspace, id) {
  const life = lifetime(); let disposeProgress;
  host.innerHTML = '<header class="page-heading"><div><a class="back-link" data-route href="/tasks">← 任务记录</a><h1>任务详情</h1></div></header><div class="detail-view"></div>';
  const content = host.querySelector('.detail-view'); workspace.state.detailId = id;
  async function load() { content.innerHTML = '<div class="surface loading-state">正在读取任务…</div>'; try { await workspace.getJob(id); if (!life.alive) return; disposeProgress?.(); disposeProgress = mountProgress(content,workspace,id); } catch (err) { if (life.alive) { content.innerHTML = `<div class="surface">${feedback(err.message)}<button>重新加载</button></div>`; content.querySelector('button').onclick = load; } } }
  life.add(() => { workspace.state.detailId = ''; disposeProgress?.(); }); load(); return life.dispose;
}
