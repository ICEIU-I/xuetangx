import { api } from '../api.js';
import { navigate } from '../router.js';
import { modules, primaryId, activeStatuses, statusNames } from '../features/workspace/presentation.js';
import { escape as e, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
import { mountSingleVideo } from './single-video.js';
export function mountRunner(host, workspace, course, kind) {
  const life = lifetime(); let submit = false, selected = [], scan, busy = false, error = '';
  const title = modules.find(m => m.kind === kind)?.title || '答案采集';
  host.innerHTML = '<section class="surface"><div class="runner-content"></div><div class="single-content"></div></section>';
  const content = host.querySelector('.runner-content');
  function current() { return workspace.state.jobs.find(j => Number(j.primaryId) === primaryId(workspace.state.session) && j.course.url === course?.url && j.modules[kind]); }
  function running() { return current() && activeStatuses.includes(current().status); }
  function locked() { return busy || running() || !workspace.state.session.connected || !course || workspace.state.pendingStart; }
  function draw() {
    if (!life.alive) return;
    const job = current();
    render(content, `<header class="section-heading"><h2>${title}</h2></header>${running() ? `<div class="feedback waiting"><span>已有${statusNames[job.status]}的任务</span><a data-route href="/tasks/${encodeURIComponent(job.id)}">查看任务 →</a></div>` : ''}<div class="tool-options">${kind === 'collector' ? `<label class="checkbox-label"><input id="collector-submit" type="checkbox"${submit ? ' checked' : ''}${disabled(locked())}>使用采集账号补齐未公开答案</label>` : ''}</div>${kind === 'collector' ? `<p class="muted">${submit ? '将使用采集账号提交未做题，可能消耗作答机会。' : '仅读取公开答案。'}</p>` : ''}<div class="row"><button id="tool-start" class="primary"${disabled(locked())}>${busy ? '处理中…' : `开始${title}任务`}</button>${kind !== 'collector' ? `<button id="tool-scan"${disabled(locked())}>${kind === 'homework' ? '选择作业' : '查看课程项目'}</button>` : ''}</div>${workspace.state.pendingStart ? '<p class="feedback waiting">正在核对已请求的任务，请稍后查看任务记录。</p>' : ''}${scan ? `<div class="scan-results">${kind === 'homework' ? `<p class="muted">不勾选时处理全部未完成作业。</p>${(scan.sections || []).map(section => `<label class="checkbox-label"><input data-section type="checkbox" value="${e(section.name)}"${selected.includes(section.name) ? ' checked' : ''}><span>${e(section.name)}</span><span class="muted">已做 ${section.done}/${section.total} · 答对 ${section.right}</span></label>`).join('')}` : `<p>共 ${scan.total} 项，已完成 ${scan.completed} 项</p>${(scan[kind === 'discussion' ? 'discussions' : kind+'s'] || []).map(item => `<div class="scan-item"><span>${e(item.title)}</span><span>${item.completed ? '已完成' : item.locked ? '尚未开放' : '未完成'}</span></div>`).join('')}`}</div>` : ''}${feedback(error)}`);
  }
  life.add(delegate(content,'change','#collector-submit',(_,el) => { submit = el.checked; draw(); }));
  life.add(delegate(content,'change','[data-section]',(_,el) => { selected = el.checked ? [...selected,el.value] : selected.filter(v => v !== el.value); }));
  life.add(delegate(content,'click','#tool-scan',async () => { if (locked()) return; busy = true; error = ''; draw(); try { scan = await ({video:api.videoScan,article:api.articleScan,discussion:api.discussionScan,homework:api.status}[kind])(course.url); } catch (err) { error = err.message; } finally { busy = false; draw(); } }));
  life.add(delegate(content,'click','#tool-start',async () => {
    if (locked()) return; busy = true; error = ''; draw();
    try { const result = await workspace.start(course.url,1,{ modules:[kind], ...(kind === 'collector' ? { submitUnanswered:submit } : {}), ...(kind === 'homework' && selected.length ? { targets:selected } : {}) }); if (life.alive && result) navigate(`/tasks/${result.id}`); else error = workspace.state.error; }
    catch (err) { error = err.message; } finally { busy = false; draw(); }
  }));
  if (kind === 'video') life.add(mountSingleVideo(host.querySelector('.single-content'),workspace));
  life.add(workspace.subscribe(draw)); draw(); return life.dispose;
}
