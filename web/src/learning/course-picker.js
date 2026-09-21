import { selectedCourse } from '../features/workspace/courses.js';
import { escape as e, disabled, feedback, render, delegate, lifetime } from '../shared/dom.js';
export function coursePickerMarkup(state) {
  if (!state.session.connected) return '';
  const selected = selectedCourse(state), locked = state.starting || !!state.pendingStart;
  return `<section class="surface course-picker"><label for="workflow-course">选择课程</label><div class="course-picker-controls"><select id="workflow-course"${disabled(locked || !state.courses.length)} aria-describedby="course-picker-note">${!state.courses.length ? '<option value="">正在读取课程…</option>' : state.courses.map(c => `<option value="${e(c.url)}"${c.url === selected?.url ? ' selected' : ''}>${e(c.title)}${c.fixed ? ' · 固定可选' : ' · 已选'}（班级 ${e(c.classroomId)}）</option>`).join('')}</select><button id="refresh-workflow-courses"${disabled(locked || state.coursesLoading)}>${state.coursesLoading ? '读取中…' : '刷新课程'}</button></div><p id="course-picker-note" class="muted">固定课程始终保留，也可选择当前账号已加入的其他课程。切换不会启动、暂停或停止任何任务。</p>${state.pendingStart ? '<p class="muted">正在核对上次启动结果，确认后可切换课程。</p>' : ''}${feedback(state.coursesWarning,'waiting')}</section>`;
}
export function mountCoursePicker(host, workspace) {
  const life = lifetime(), draw = () => { if (life.alive) render(host, coursePickerMarkup(workspace.state)); };
  life.add(delegate(host,'change','#workflow-course',(_,input)=>workspace.selectCourse(input.value)));
  life.add(delegate(host,'click','#refresh-workflow-courses',()=>workspace.loadCourses()));
  life.add(workspace.subscribe(draw)); draw(); return life.dispose;
}
