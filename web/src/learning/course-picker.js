import { selectedCourse } from '../features/workspace/courses.js';
import { escape as e, disabled, render, delegate, lifetime } from '../shared/dom.js';
export function coursePickerMarkup(state) {
  if (!state.session.connected) return '';
  const selected = selectedCourse(state), locked = state.starting || !!state.pendingStart;
  return `<div class="course-picker"><select id="workflow-course" aria-label="选择课程" aria-busy="${!!state.coursesLoading}"${disabled(locked || !state.courses.length)}>${!state.courses.length ? '<option value="">选择课程</option>' : state.courses.map(c => `<option value="${e(c.url)}"${c.url === selected?.url ? ' selected' : ''}>${e(c.title)}</option>`).join('')}</select></div>`;
}
export function mountCoursePicker(host, workspace) {
  const life = lifetime(), draw = () => { if (life.alive) render(host, coursePickerMarkup(workspace.state)); };
  life.add(delegate(host,'change','#workflow-course',(_,input)=>workspace.selectCourse(input.value)));
  life.add(workspace.subscribe(draw)); draw(); return life.dispose;
}
