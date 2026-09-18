import { api } from '../api.js';
import { escape as e, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
const plain = value => new DOMParser().parseFromString(value || '', 'text/html').body.textContent;
export function mountLibrary(host, course) {
  const life = lifetime(); let saved, offset = 0, busy = false, error = '', revision = 0;
  function draw() {
    if (!life.alive) return;
    const exercises = Object.values(saved?.database?.exercises || {}), total = saved?.pagination?.total || 0;
    render(host, `<section class="surface"><header class="section-heading"><h2>课程答案库</h2>${course ? `<a class="button" href="/api/answer-bank/${encodeURIComponent(course.classroomId)}?download=1">下载 JSON</a>` : ''}</header>${feedback(error)}${busy ? '<div class="loading-state">正在读取题库…</div>' : exercises.map(exercise => `<details class="answer-exercise" data-key="exercise-${e(exercise.leaf_id)}"><summary>${e(exercise.section)} <span class="muted">${exercise.questions.length} 题</span></summary>${exercise.questions.map(q => `<div class="answer-question"><strong>${e(q.index)}. ${e(plain(q.body_html) || `题目 ${q.problem_id}`)}</strong><p>${q.answer_status === 'captured' ? `标准答案：${e(q.answer ?? q.answers?.join('、') ?? JSON.stringify(q.reference_answer || q.accepted_answers || ''))}` : e(q.error || '待获取')}</p></div>`).join('')}</details>`).join('') || '<div class="empty-state"><p>暂无答案</p><button id="library-refresh">重新读取</button></div>'}${total > 50 ? `<div class="pager"><button data-offset="${offset-50}"${disabled(busy || !offset)}>上一页</button><span>${offset+1}–${Math.min(offset+50,total)} / ${total}</span><button data-offset="${offset+50}"${disabled(busy || offset+50 >= total)}>下一页</button></div>` : ''}</section>`);
  }
  async function load(next = offset) { if (!course) return; const token = ++revision; busy = true; error = ''; draw(); try { const result = await api.answerDatabase(course.classroomId,next); if (life.alive && token === revision) { saved = result; offset = next; } } catch (err) { error = err.message; } finally { busy = false; draw(); } }
  life.add(delegate(host,'click','#library-refresh',() => load())); life.add(delegate(host,'click','[data-offset]',(_,el) => load(Number(el.dataset.offset)))); life.add(() => revision++); draw(); load(); return life.dispose;
}
