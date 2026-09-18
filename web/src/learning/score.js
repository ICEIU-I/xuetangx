import { escape as e, disabled } from '../shared/dom.js';
import { primaryId } from '../features/workspace/presentation.js';
export function scoreMarkup(state, job) {
  const account = primaryId(state.session), score = state.score || {};
  // A historical task may belong to another account or another course.
  if (!state.session.connected || (job && (Number(job.primaryId) !== account || Number(job.course.classroomId) !== Number(state.courses[0]?.classroomId)))) return '';
  const available = score.primaryId === account && score.available && typeof score.value === 'number' && Number.isFinite(score.value);
  const text = available ? `${score.value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 分` : score.loading ? '读取中…' : '—';
  return `<div class="course-score"><span class="muted">课程成绩</span><strong>${e(text)}</strong><button id="score-refresh" class="text-button"${disabled(score.loading)}>刷新成绩</button>${score.message ? `<p role="status">${e(score.message)}</p>` : ''}</div>`;
}
