import { api } from '../api.js';
import { modules, primaryId } from '../features/workspace/presentation.js';
import { escape as e, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
import { mountLibrary } from './library.js';
import { mountRunner } from './runner.js';
export function mountTools(host, workspace, route) {
  const life = lifetime(); const tools = [...modules,{kind:'collector',title:'答案采集'},{kind:'library',title:'答案库'}];
  const kind = tools.some(t => t.kind === route.query.get('tool')) ? route.query.get('tool') : 'video';
  let courses = [], selected = '', loading = false, error = '', accountKey, revision = 0, disposeChild = () => {};
  host.innerHTML = '<header class="page-heading"><h1>更多工具</h1></header><div class="tool-controls"></div><div class="tool-content"></div>';
  const controls = host.querySelector('.tool-controls'), content = host.querySelector('.tool-content');
  function draw() { render(controls, !workspace.state.session.connected ? '<div class="surface empty-state"><p>请先连接学堂在线</p><a data-route class="button primary" href="/learn">连接账号</a></div>' : `<nav class="tool-navigation" aria-label="工具导航">${tools.map(t => `<a data-route href="/tools?tool=${t.kind}" class="${kind === t.kind ? 'selected' : ''}">${t.title}</a>`).join('')}</nav><div class="surface tool-course"><label for="tool-course">课程</label><select id="tool-course"${disabled(loading)}><option value="" disabled${!selected ? ' selected' : ''}>${loading ? '正在读取课程…' : '请选择课程'}</option>${courses.map(c => `<option value="${e(c.url)}"${selected === c.url ? ' selected' : ''}>${e(c.title)}</option>`).join('')}</select><button id="tool-refresh"${disabled(loading)}>刷新</button>${feedback(error)}${!loading && !courses.length ? '<p class="muted">暂无已加入课程</p>' : ''}</div>`); }
  function mountChild() { disposeChild(); content.innerHTML = ''; if (!workspace.state.session.connected) return; const course = courses.find(c => c.url === selected); disposeChild = kind === 'library' ? mountLibrary(content,course) : mountRunner(content,workspace,course,kind); }
  async function load() { const token = ++revision; courses = []; selected = ''; error = ''; loading = true; draw(); mountChild(); try { const result = await api.videoCourses(); if (!life.alive || token !== revision) return; courses = result.courses || []; selected = courses[0]?.url || ''; } catch (err) { error = err.message; } finally { if (life.alive && token === revision) { loading = false; draw(); mountChild(); } } }
  function accountChanged() { const key = `${workspace.state.session.connected}:${primaryId(workspace.state.session)}`; if (key === accountKey) return; accountKey = key; revision++; if (workspace.state.session.connected) load(); else { courses = []; selected = ''; draw(); mountChild(); } }
  life.add(delegate(controls,'change','#tool-course',(_,el) => { selected = el.value; mountChild(); })); life.add(delegate(controls,'click','#tool-refresh',load)); life.add(workspace.subscribe(accountChanged)); life.add(() => { revision++; disposeChild(); }); accountChanged(); return life.dispose;
}
