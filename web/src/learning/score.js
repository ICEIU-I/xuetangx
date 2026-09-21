import { escape as e, disabled } from '../shared/dom.js';
import { scoreCourse, courseIdentity } from '../features/workspace/courses.js';
import { primaryId } from '../features/workspace/presentation.js';
const labels = { Assignment: '作业', Discussion: '讨论', Exam: '考试', Video: '视频', Article: '图文' };
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
export function canShowScore(state, job) {
  return state.session.connected && !!scoreCourse(state) && (!job || (Number(job.primaryId) === primaryId(state.session) && courseIdentity(job.course) === courseIdentity(scoreCourse(state))));
}
export function scoreMarkup(state, job) {
  if (!canShowScore(state, job)) return '';
  const score = state.score || {}, account = primaryId(state.session);
  const available = score.primaryId === account && score.courseKey === courseIdentity(scoreCourse(state)) && score.available;
  const seconds = Math.max(0, Math.ceil(((score.retryAt || 0) - Date.now()) / 1000));
  const status = score.loading ? '更新中…' : seconds ? `${seconds} 秒后重试` : score.message || '每 15 秒更新';
  const updated = score.updatedAt ? new Date(score.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  return `<aside class="course-score" aria-label="课程成绩" aria-busy="${!!score.loading}"><div class="score-top"><span>课程成绩</span><button id="score-refresh" class="score-refresh" title="刷新成绩" aria-label="刷新成绩"${disabled(score.loading || seconds)}>↻</button></div><div class="score-value"><strong>${available ? e(number(score.value)) : '—'}</strong><span>/ 100</span>${score.stale ? '<small>上次成绩</small>' : ''}</div><p class="score-sync" role="status" title="${e(score.message || (updated ? `更新于 ${updated}` : ''))}">${e(status)}</p>${score.breakdown?.length && score.primaryId === account && score.courseKey === courseIdentity(scoreCourse(state)) ? `<details class="score-breakdown" data-key="score-breakdown"><summary data-focus="score-breakdown">成绩构成</summary><ul>${score.breakdown.map(item => `<li><span>${e(labels[item.name] || item.name)}</span><strong>${e(number(item.score))}<small> / ${e(number(item.maximum))}</small></strong></li>`).join('')}</ul></details>` : ''}</aside>`;
}
