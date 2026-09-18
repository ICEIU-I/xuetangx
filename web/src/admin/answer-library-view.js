import { escape as e, disabled } from '../shared/dom.js';
import { formatDate } from '../features/workspace/presentation.js';

export const courseName = course => course?.title || '未命名课程';
export const downloadURL = id => `/api/answer-bank/${encodeURIComponent(id)}?download=1`;
export function pager(offset, limit, total, busy, attribute) {
  if (total <= limit) return '';
  return `<div class="pager"><button ${attribute}="${offset-limit}"${disabled(busy || !offset)}>上一页</button><span>${offset+1}–${Math.min(offset+limit,total)} / ${total}</span><button ${attribute}="${offset+limit}"${disabled(busy || offset+limit>=total)}>下一页</button></div>`;
}
export function courseCards(courses) {
  if (!courses.length) return '<section class="surface empty-state">暂无课程题库</section>';
  return `<div class="answer-bank-grid">${courses.map(item => `<article class="surface answer-bank-card"><h2>${e(courseName(item.course))}</h2><p class="muted">${item.totalExercises} 套练习 · ${item.totalQuestions} 道题</p><div class="answer-bank-counts"><span>已收录 <strong>${item.capturedAnswers}</strong></span><span>待补全 <strong>${item.missingAnswers}</strong></span></div><small class="muted">更新于 ${e(formatDate(item.updatedAt))}</small><div class="row"><a class="button primary" data-route href="/admin/answers?course=${encodeURIComponent(item.course.classroomId)}">查看题目</a><a class="button" href="${downloadURL(item.course.classroomId)}">下载 JSON</a></div></article>`).join('')}</div>`;
}
export function answerText(q) {
  if (q.answer_status && !['captured', 'reference'].includes(q.answer_status)) return q.error || '待获取';
  if (q.answer !== undefined && q.answer !== null && q.answer !== '') return String(q.answer);
  if (q.answers?.length) return q.answers.join('、');
  if (q.accepted_answers) return Object.entries(q.accepted_answers).map(([slot, values]) => `${slot}: ${values.join(' / ')}`).join('；');
  return q.reference_answer || q.error || '待获取';
}
// Platform HTML is converted to text, never mounted as active markup.
function plain(value) {
  return new DOMParser().parseFromString(String(value || ''), 'text/html').body.textContent || '';
}
export function questionGroups(data) {
  return Object.values(data.database?.exercises || {}).map(ex => `<details class="answer-exercise" data-key="admin-exercise-${e(ex.leaf_id)}"><summary>${e(ex.section || ex.title || '练习')} <span class="muted">${(ex.questions || []).length} 题</span></summary>${(ex.questions || []).map(q => `<div class="answer-question"><strong>${e(q.index || '')}. ${e(plain(q.body_html || q.body || q.title) || `题目 ${q.problem_id || ''}`)}</strong>${(q.options || []).map(o => `<div class="muted">${e(o.key)}. ${e(plain(o.content || o.value))}</div>`).join('')}<p>答案：${e(answerText(q))}</p></div>`).join('')}</details>`).join('') || '<p class="empty-state">暂无题目</p>';
}
