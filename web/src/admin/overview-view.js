import { escape as e } from '../shared/dom.js';

export function serviceStatus(metrics) {
  const status = !metrics ? 'checking' : metrics.ready ? 'ready' : 'unavailable';
  return `<span class="service-state ${status}" role="status"><i aria-hidden="true"></i>${!metrics ? '检查中' : metrics.ready ? '运行正常' : '服务未就绪'}</span>`;
}

export function overviewLinks(metrics) {
  const links = [
    ['users', '用户', '/admin/users', 'user'],
    ['capturedAnswers', '已收录答案', '/admin/answers', 'answer'],
    ['availableCollectors', '可用采集账号', '/admin/collectors', 'collector'],
  ];
  return `<nav class="overview-links" aria-label="管理入口">${links.map(([key, label, url, kind]) => `<a data-route href="${url}" class="overview-link ${kind}"><span>${label}</span><strong>${e(metrics?.[key] ?? '—')}</strong><span class="overview-arrow" aria-hidden="true">↗</span></a>`).join('')}</nav>`;
}

export function systemDetails(metrics) {
  if (!metrics) return '';
  const labels = { runningJobs:'运行任务',queuedJobs:'排队任务',pendingOperations:'待核对操作',failedMail:'邮件失败',workerRestarts:'进程恢复次数' };
  return `<details class="overview-details" data-key="system-details"><summary>运行详情</summary><dl>${Object.entries(labels).map(([key, label]) => `<div><dt>${label}</dt><dd>${e(metrics[key] ?? '—')}</dd></div>`).join('')}</dl></details>`;
}
