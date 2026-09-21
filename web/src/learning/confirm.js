import { selectedCourse } from '../features/workspace/courses.js';
import { scoreMarkup } from './score.js';
import { modules } from '../features/workspace/presentation.js';
import { escape as e, disabled, feedback, render, delegate, lifetime } from '../shared/dom.js';
export function mountConfirm(host, workspace) {
  const life = lifetime();
  const { state } = workspace;
  function draw() {
    if (!life.alive) return;
    const course = selectedCourse(state);
    render(host, `<section class="surface course-confirm"><header class="course-heading"><div class="course-heading-info"><h2>${e(course?.title || '正在读取课程…')}</h2><span class="status-pill">${course?.enrolled ? '已选课程' : course?.fixed ? '固定可选课程' : '课程'}</span></div>${scoreMarkup(state)}</header><div class="course-features">${modules.map((m,i) => `<div class="course-feature" data-module="${m.kind}"><span>0${i+1}</span><strong>${m.title}</strong></div>`).join('')}</div><p class="enroll-note">${course?.fixed && !course.enrolled ? '仅在选择本课程并开始任务后，检查是否可免费加入。' : '仅处理当前所选课程，不会自动加入或启动其他课程。'}</p><div class="task-actions"><button id="start-task" class="primary"${disabled(state.starting || !course || state.coursesLoading)}>${state.starting ? '正在检查课程并准备任务…' : state.pendingStart ? '重新核对任务状态' : '开始任务'}</button></div>${feedback(state.error)}</section>`);
  }
  life.add(delegate(host, 'click', '#start-task', () => state.pendingStart ? workspace.checkStart() : workspace.start(selectedCourse(state)?.url)));
  life.add(delegate(host, 'click', '#score-refresh', () => workspace.loadScore()));
  life.add(workspace.watchScore());
  life.add(workspace.subscribe(draw)); draw(); return life.dispose;
}
