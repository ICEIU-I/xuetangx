import { selectedCourse } from '../features/workspace/courses.js';
import { mountCoursePicker } from './course-picker.js';
import { wizardStep } from '../features/workspace/presentation.js';
import { escape as e, feedback, lifetime } from '../shared/dom.js';
import { mountConnect } from './connect.js';
import { mountConfirm } from './confirm.js';
import { mountProgress } from '../tasks/progress.js';
export function mountLearn(host, workspace) {
  const life = lifetime(); let key = '', disposeChild = () => {};
  host.innerHTML = '<header class="page-heading"><h1>课程任务</h1><span class="account-chip"></span></header><ol class="wizard-steps" aria-label="课程任务步骤"></ol><div class="course-picker-host"></div><div class="step-content"></div>';
  const content = host.querySelector('.step-content');
  life.add(mountCoursePicker(host.querySelector('.course-picker-host'), workspace));
  function update() {
    const { state, currentJob } = workspace; const job = currentJob.value, step = wizardStep(state.session, job);
    host.querySelector('.account-chip').textContent = state.session.connected ? state.session.user?.name || state.session.user?.username || '已连接' : '未连接';
    host.querySelector('.wizard-steps').innerHTML = ['连接学堂在线','确认课程','执行与结果'].map((name,i) => `<li class="${step === i+1 ? 'current' : step > i+1 ? 'complete' : ''}"${step === i+1 ? ' aria-current="step"' : ''}><span>${step > i+1 ? '✓' : `0${i+1}`}</span><strong>${name}</strong></li>`).join('');
    const next = state.loading ? 'loading' : state.error && !state.courses.length ? `error:${state.error}` : `${step}:${selectedCourse(state)?.url || ''}:${job?.id || ''}`;
    if (next === key) return; key = next; disposeChild(); content.innerHTML = '';
    if (state.loading) content.innerHTML = '<div class="surface loading-state" role="status">正在读取账号和任务…</div>';
    else if (next.startsWith('error:')) { content.innerHTML = `<div class="surface">${feedback(e(state.error))}<button id="reload-workspace">重新加载</button></div>`; content.querySelector('button').onclick = workspace.initialize; }
    else if (step === 1) disposeChild = mountConnect(content, workspace);
    else if (step === 2) disposeChild = mountConfirm(content, workspace);
    else disposeChild = mountProgress(content, workspace, job.id);
  }
  life.add(workspace.subscribe(update)); life.add(() => disposeChild()); update(); return life.dispose;
}
