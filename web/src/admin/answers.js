import { request } from '../api.js';
import { escape as e, disabled, feedback, render, delegate, lifetime } from '../shared/dom.js';

export function mountAnswers(host) {
  const life = lifetime();
  let classroomId = '31384299', data = null, busy = false, error = '';
  function draw() {
    if (!life.alive) return;
    render(host, `<header class="page-heading"><h1>答案库</h1></header><section class="surface admin-answer-library"><form id="answer-library-form" class="input-action"><label for="answer-classroom">课程班级 ID<input id="answer-classroom" name="classroomId" inputmode="numeric" value="${e(classroomId)}" required></label><button class="primary"${disabled(busy)}>查看</button></form>${feedback(error)}${busy ? '<div class="loading-state">正在读取题库…</div>' : data ? `<header class="section-heading"><h2>课程题库</h2><a class="button" href="/api/answer-bank/${encodeURIComponent(classroomId)}?download=1">下载 JSON</a></header><p class="muted">共 ${data.summary?.totalQuestions || data.pagination?.total || 0} 道题，已收录 ${data.summary?.capturedAnswers || 0} 道。</p>${Object.values(data.database?.exercises || {}).map(ex => `<details class="answer-exercise" data-key="admin-exercise-${e(ex.leaf_id)}"><summary>${e(ex.section || ex.title || '练习')} <span class="muted">${(ex.questions || []).length} 题</span></summary>${(ex.questions || []).map(q => `<div class="answer-question"><strong>${e(q.index || '')}. ${e(q.body || q.title || `题目 ${q.problem_id || ''}`)}</strong><p>${e(q.answer || q.error || '待获取')}</p></div>`).join('')}</details>`).join('') || '<p class="empty-state">暂无题目</p>'}` : '<p class="empty-state">输入班级 ID后查看答案库。</p>'}</section>`);
  }
  async function load() {
    const form = host.querySelector('#answer-library-form');
    classroomId = new FormData(form).get('classroomId')?.toString().trim() || '';
    if (!/^\d+$/.test(classroomId)) { error = '请输入有效的班级 ID'; draw(); return; }
    busy = true; error = ''; data = null; draw();
    try { data = await request(`/api/answer-bank/${encodeURIComponent(classroomId)}?limit=100`); }
    catch (err) { error = err.message || '题库读取失败'; }
    finally { busy = false; draw(); }
  }
  life.add(delegate(host, 'submit', '#answer-library-form', event => { event.preventDefault(); void load(); }));
  draw(); void load(); return life.dispose;
}
