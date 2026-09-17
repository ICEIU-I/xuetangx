// 前端 -> 后端 API 封装 + SSE 订阅
async function j(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export const api = {
  session: () => j('/api/session'),
  connect: (cookie) => j('/api/cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie }) }),
  disconnect: () => j('/api/disconnect', { method: 'POST' }),
  answers: () => j('/api/answers'),
  status: () => j('/api/status'),
  run: (targets) => j('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets }) }),
  stop: () => j('/api/stop', { method: 'POST' }),
  runState: () => j('/api/run-state'),
  videoInspect: (url) => j('/api/video/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }),
  videoRun: (url, durationSeconds) => j('/api/video/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, durationSeconds }) }),
  videoStop: () => j('/api/video/stop', { method: 'POST' }),
  videoState: () => j('/api/video/state'),
  videoCourses: () => j('/api/video/courses'),
  videoScan: (courseUrl) => j('/api/video/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl }) }),
  videoRunCourse: (courseUrl, concurrency) => j('/api/video/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl, concurrency }) }),
  collectAnswers: (courseUrl, submitUnanswered) => j('/api/answer-bank/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl, submitUnanswered }) }),
  stopAnswers: () => j('/api/answer-bank/stop', { method: 'POST' }),
  answerDatabase: (classroomId) => j(`/api/answer-bank/${encodeURIComponent(classroomId)}`),
  articleScan: (courseUrl) => j('/api/article/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl }) }),
  articleRun: (courseUrl) => j('/api/article/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl }) }),
  articleStop: () => j('/api/article/stop', { method: 'POST' }),
  discussionScan: (courseUrl) => j('/api/discussion/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl }) }),
  discussionRun: (courseUrl) => j('/api/discussion/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseUrl }) }),
  discussionStop: () => j('/api/discussion/stop', { method: 'POST' }),
};

// SSE：返回一个 EventSource，调用方监听 message
export function subscribeEvents(onEvent) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch {} };
  return es;
}
