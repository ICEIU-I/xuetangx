import { escape as e } from '../shared/dom.js';
import { answerText } from './answer-library-view.js';

// Only inert text is rendered from platform HTML, including stems and options.
export function plainQuestionText(value) {
  return new DOMParser().parseFromString(String(value || ''), 'text/html').body.textContent || '';
}
export function questionRows(data, offset = 0, plain = plainQuestionText) {
  let index = offset;
  const groups = Object.values(data.database?.exercises || {});
  const rows = groups.flatMap(ex => (ex.questions || []).map(q => {
    index++;
    const title = plain(q.body_html || q.body || q.title) || `题目 ${q.problem_id || ''}`;
    const answer = answerText(q);
    const ready = ['captured','reference'].includes(q.answer_status) || (!q.answer_status && answer !== '待获取');
    const key = `${ex.leaf_id}-${q.problem_id}-${index}`;
    return `<details class="question-row" data-key="question-${e(key)}"><summary><span class="question-number">${index}</span><span class="question-preview"><strong>${e(title)}</strong><small>${e(ex.section || ex.title || '练习')} · ID ${e(q.problem_id)}</small></span><span class="question-answer-state ${ready ? 'ready' : 'missing'}">${ready ? '已收录' : '待补全'}</span><span class="question-toggle" aria-hidden="true">+</span></summary><div class="question-content"><p class="question-stem">${e(title)}</p>${q.options?.length ? `<ul class="question-options">${q.options.map(o => `<li><span>${e(o.key)}</span><div>${e(plain(o.content || o.value))}</div></li>`).join('')}</ul>` : ''}<div class="question-answer"><span>答案</span><strong>${e(answer)}</strong></div></div></details>`;
  }));
  return rows.length ? `<div class="question-list">${rows.join('')}</div>` : '<p class="empty-state">没有匹配的题目</p>';
}
