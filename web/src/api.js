// 前端 -> 后端 API 封装 + SSE 订阅
export async function request(url, opts = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('xuetangx_csrf='))?.split('=')[1] || '';
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...(opts.headers || {}), ...(opts.method && opts.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (data.code === 'AUTH_REQUIRED') window.dispatchEvent(new Event('auth-required'));
    const error = new Error(data.error || `HTTP ${r.status}`); error.code = data.code; throw error;
  }
  return data;
}

const j = request;
export const api = {
  session: () => j('/api/session'),
  workflowState: (offset = 0, limit = 25, query = '') => j(`/api/workflow/state?offset=${offset}&limit=${limit}&q=${encodeURIComponent(query)}`),
  workflowJob: id => j(`/api/workflow/${encodeURIComponent(id)}`),
  workflowCourses: () => j('/api/workflow/courses'),
  workflowCourseScore: (signal, courseUrl) => j('/api/workflow/course-score' + (courseUrl ? '?' + new URLSearchParams({ courseUrl }) : ''), { signal }),
  workflowStart: (courseUrl, concurrency = 1, options = {}) => j('/api/workflow/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...options, courseUrl, concurrency }) }),
  workflowControl: (id, action) => j(`/api/workflow/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  testConnect: (cookie) => j('/api/test-cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie }) }),
  testDisconnect: () => j('/api/test-disconnect', { method: 'POST' }),
  connect: (cookie) => j('/api/cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie }) }),
  disconnect: () => j('/api/disconnect', { method: 'POST' }),
  wechatStart: (role = 'primary') => j('/api/wechat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) }),
  wechatStatus: (id) => j(`/api/wechat/${encodeURIComponent(id)}`),
  wechatCancel: (id) => j(`/api/wechat/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  answers: () => j('/api/answers'),
  status: (courseUrl) => j('/api/status?' + new URLSearchParams({ courseUrl })),
  run: (targets, courseUrl, concurrency = 1) => j('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets, courseUrl, concurrency }) }),
  stop: () => j('/api/stop', { method: 'POST' }),
  runState: () => j('/api/run-state'),
  videoInspect: (url) => j('/api/video/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }),
  videoRun: (url, durationSeconds) => j('/api/video/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, durationSeconds }) }),
  videoStop: () => j('/api/video/stop', { method: 'POST' }),
  videoState: () => j('/api/video/state'),
  videoCourses: () => j('/api/video/courses'),
  videoScan: (courseUrl) => j('/api/video/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl }) }),
  videoRunCourse: (courseUrl, concurrency) => j('/api/video/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl, concurrency }) }),
  collectAnswers: (courseUrl, submitUnanswered, concurrency = 1) => j('/api/answer-bank/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl, submitUnanswered, concurrency }) }),
  stopAnswers: () => j('/api/answer-bank/stop', { method: 'POST' }),
  articleScan: (courseUrl) => j('/api/article/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl }) }),
  articleRun: (courseUrl, concurrency = 1) => j('/api/article/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl, concurrency }) }),
  articleStop: () => j('/api/article/stop', { method: 'POST' }),
  discussionScan: (courseUrl) => j('/api/discussion/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl }) }),
  discussionRun: (courseUrl, concurrency = 1) => j('/api/discussion/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl, concurrency }) }),
  discussionStop: () => j('/api/discussion/stop', { method: 'POST' }),
};

// SSE：返回一个 EventSource，调用方监听 message
export function subscribeEvents(onEvent, handlers = {}) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch {} };
  es.onopen = () => handlers.open?.();
  es.onerror = () => handlers.error?.();
  return es;
}
