export const modules = [
  { kind: 'video', title: '视频学习', icon: 'play', description: '逐个处理视频，并核对观看进度' },
  { kind: 'article', title: '图文阅读', icon: 'book', description: '完成课程图文单元' },
  { kind: 'discussion', title: '课程讨论', icon: 'message', description: '处理讨论题，跳过已发表内容' },
  { kind: 'homework', title: '课程答题', icon: 'check', description: '使用匹配题库，核对作答结果' },
];
export const collectorModule = { kind: 'collector', title: '答案采集', icon: 'book', description: '补齐标准答案' };
export const statusNames = { queued: '准备中', scanning: '正在扫描', running: '进行中', waiting_input: '等待处理', waiting_answers: '等待答案', waiting_account: '需要连接账号', waiting_enrollment: '等待加入课程', waiting_rate_limit: '自动等待', done: '已完成', partial: '尚未全部完成', blocked: '需要处理', paused: '已暂停', stopped: '已停止', error: '需要处理', retrying: '自动重试中' };
export const activeStatuses = ['queued', 'running', 'waiting_input'];
export function finished(module) { return Math.max(0, (module?.completed || 0) + (module?.skipped || 0) - (module?.wrongExisting || 0)); }
export function percent(module) {
  if (!module) return 0;
  if (!module.total) return module.status === 'done' ? 100 : 0;
  const value = Math.floor(finished(module) / module.total * 100);
  return Math.min(module.status === 'done' ? 100 : 99, value);
}
export function summary(job) {
  const core = modules.filter(m => job?.modules?.[m.kind]).map(m => job.modules[m.kind]);
  const selected = core.length ? core : job?.modules?.collector ? [job.modules.collector] : [];
  const known = selected.length > 0 && selected.every(m => m.total > 0 || m.status === 'done');
  const total = selected.reduce((n, m) => n + (m.total || 0), 0);
  const completed = selected.reduce((n, m) => n + finished(m), 0);
  return { known, total, completed, percent: known ? Math.min(job?.status === 'done' ? 100 : 99, total ? Math.floor(completed / total * 100) : job?.status === 'done' ? 100 : 0) : null };
}
export function primaryId(session) { return Number(session?.user?.user_id || session?.user?.id || 0); }
export function latestJob(jobs, session, course) {
  if (!primaryId(session) || !course) return null;
  return jobs.filter(j => Number(j.primaryId) === primaryId(session) && Number(j.course.classroomId) === Number(course.classroomId)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}
export function wizardStep(session, job) { return job ? 3 : session?.connected ? 2 : 1; }
export function actions(job, session) {
  if (!job) return [];
  const sameAccount = session?.connected && primaryId(session) === Number(job.primaryId);
  const result = [];
  if (sameAccount && ['paused', 'partial', 'stopped', 'waiting_input', 'blocked', 'error'].includes(job.status)) result.push('resume');
  if (['queued', 'running', 'waiting_input'].includes(job.status)) result.push('pause');
  if (['queued', 'running', 'waiting_input', 'paused'].includes(job.status)) result.push('stop');
  return result;
}
export function countdown(limit, now = Date.now()) { return limit?.blocked ? Math.max(0, Math.ceil((limit.readyAt - now) / 1000)) : 0; }
export function formatDate(value) { return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'; }
export function loginState(value, now = Date.now()) {
  if (value.status === 'waiting_scan' && value.expiresAt && new Date(value.expiresAt).getTime() <= now) return 'expired';
  return value.status;
}
