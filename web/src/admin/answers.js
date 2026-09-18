import { request } from '../api.js';
import { currentRoute } from '../router.js';
import { escape as e, disabled, feedback, render, delegate, lifetime } from '../shared/dom.js';
import { courseName, courseCards, questionGroups, downloadURL, pager } from './answer-library-view.js';

export function mountAnswers(host) {
  const life = lifetime(), abort = new AbortController();
  const classroomId = currentRoute().query.get('course') || '';
  const limit = classroomId ? 100 : 20;
  let data = null, offset = 0, busy = false, error = '';
  function draw() {
    if (!life.alive) return;
    const title = classroomId ? courseName(data?.database?.course) : '答案库';
    render(host, `<header class="page-heading"><div>${classroomId ? '<a class="back-link" data-route href="/admin/answers">← 全部题库</a>' : ''}<h1>${e(classroomId && !data ? '课程题库' : title)}</h1></div><button id="answer-library-refresh"${disabled(busy)}>刷新</button></header>${feedback(error)}${busy && !data ? '<section class="surface loading-state" role="status">正在读取题库…</section>' : !data ? '<button id="answer-library-retry">重试</button>' : classroomId ? `<section class="surface admin-answer-library"><header class="section-heading"><span>共 ${data.pagination?.total || 0} 道题</span><a class="button" href="${downloadURL(classroomId)}">下载 JSON</a></header>${questionGroups(data)}${pager(offset,limit,data.pagination?.total || 0,busy,'data-bank-page')}</section>` : `<p class="muted">${data.total} 门课程</p>${courseCards(data.courses || [])}${pager(offset,limit,data.total,busy,'data-bank-page')}`}`);
  }
  async function load(nextOffset = offset) {
    if (busy || !life.alive) return;
    busy = true; error = ''; draw();
    try {
      if (classroomId && !/^\d+$/.test(classroomId)) throw new Error('课程标识无效');
      const path = classroomId ? `/api/answer-bank/${encodeURIComponent(classroomId)}` : '/api/answer-bank';
      const result = await request(`${path}?limit=${limit}&offset=${nextOffset}`, { signal: abort.signal });
      if (!life.alive) return;
      data = result; offset = nextOffset;
    } catch (err) { if (life.alive) error = err.message || '题库读取失败'; }
    finally { busy = false; draw(); }
  }
  life.add(delegate(host, 'click', '#answer-library-refresh, #answer-library-retry', () => void load()));
  life.add(delegate(host, 'click', '[data-bank-page]', (_, el) => void load(Number(el.dataset.bankPage))));
  life.add(() => abort.abort());
  void load(); return life.dispose;
}
