import { modules } from '../features/workspace/presentation.js';
import { escape as e, disabled, feedback, render, delegate, lifetime } from '../shared/dom.js';
export function mountConfirm(host, workspace) {
  const life = lifetime(); let concurrency = 3;
  const { state } = workspace;
  function draw() {
    if (!life.alive) return;
    render(host, `<section class="surface course-confirm"><header class="course-header"><span class="section-index">02</span><div><span class="muted">学堂在线</span><h2>${e(state.courses[0]?.title || '正在读取课程…')}</h2></div><span class="status-pill">题库已匹配</span></header><div class="course-features">${modules.map((m,i) => `<div class="course-feature" data-module="${m.kind}"><span>0${i+1}</span><strong>${m.title}</strong></div>`).join('')}</div><p class="enroll-note">未加入课程时，自动免费加入。</p><details class="task-options" data-key="options"><summary>任务选项</summary><label for="task-concurrency">并发数</label><select id="task-concurrency"${disabled(state.starting || state.pendingStart)}>${[1,2,3].map(n => `<option value="${n}"${n === concurrency ? ' selected' : ''}>${n}</option>`).join('')}</select></details><div class="task-actions"><button id="start-task" class="primary"${disabled(state.starting || !state.courses.length)}>${state.starting ? '正在检查课程并准备任务…' : state.pendingStart ? '重新核对任务状态' : '开始任务'}</button></div>${feedback(state.error)}</section>`);
  }
  life.add(delegate(host, 'change', '#task-concurrency', (_, el) => { concurrency = Number(el.value); }));
  life.add(delegate(host, 'click', '#start-task', () => state.pendingStart ? workspace.checkStart() : workspace.start(state.courses[0].url, concurrency)));
  life.add(workspace.subscribe(draw)); draw(); return life.dispose;
}
