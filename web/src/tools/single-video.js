import { api } from '../api.js';
import { navigate } from '../router.js';
import { escape as e, field, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
export function mountSingleVideo(host, workspace) {
  const life = lifetime(); let info, busy = false, error = '', url = '';
  function draw() { if (!life.alive) return; render(host, `<details class="single-video-tool" data-key="single-video"><summary>单个视频</summary><form id="single-video-form"><label for="single-video-url">视频链接</label><div class="input-action"><input id="single-video-url" name="url" type="url" required value="${e(url)}" placeholder="https://www.xuetangx.com/learn/…/video/…"><button${disabled(busy)}>查询视频</button></div></form>${info ? `<div class="feedback neutral"><strong>${e(info.video.title)}</strong><span>${info.progress.completed ? '已完成' : '未完成'}</span>${!info.progress.completed ? `<button id="single-video-start"${disabled(busy)}>开始此视频任务</button>` : ''}</div>` : ''}${feedback(error)}</details>`); }
  life.add(delegate(host,'input','#single-video-url',(_,el) => { url = el.value; info = null; }));
  life.add(delegate(host,'submit','#single-video-form', async (event,form) => { event.preventDefault(); if (busy) return; url = field(form,'url'); busy = true; error = ''; draw(); try { info = await api.videoInspect(url.trim()); } catch (err) { error = err.message; } finally { busy = false; draw(); } }));
  life.add(delegate(host,'click','#single-video-start',async () => { if (busy || !info) return; busy = true; error = ''; draw(); try { const result = await api.videoRun(info.video.url,info.durationSeconds); await workspace.refresh(); if (life.alive && result.state?.jobId) navigate(`/tasks/${result.state.jobId}`); } catch (err) { error = err.message; } finally { busy = false; draw(); } }));
  draw(); return life.dispose;
}
