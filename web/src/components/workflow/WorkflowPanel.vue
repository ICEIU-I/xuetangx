<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { api, subscribeEvents } from '../../api';
const props = defineProps({ session: Object });
const courses = ref([]), courseUrl = ref(''), concurrency = ref(3), jobs = ref([]), rateLimits = ref({});
const sharedCollectors = ref(0);
const busy = ref(false), error = ref(''), now = ref(Date.now());
const accountId = computed(() => props.session.connected ? String(props.session.user?.user_id || props.session.user?.id || '') : '');
const job = computed(() => jobs.value.find(item => item.course.url === courseUrl.value));
const modules = [{ kind: 'video', title: '看视频', icon: '▶' }, { kind: 'article', title: '图文阅读', icon: '▤' }, { kind: 'discussion', title: '讨论', icon: '◌' }, { kind: 'homework', title: '答题', icon: '✓' }];
const running = computed(() => job.value && ['running', 'waiting_input'].includes(job.value.status));
const names = { queued: '准备中', scanning: '扫描课程', running: '执行中', waiting_input: '等待补充信息', waiting_answers: '等待答案', waiting_account: '等待账号', waiting_enrollment: '等待选课', waiting_rate_limit: '服务端限流等待', done: '已完成', partial: '部分完成', blocked: '需要处理', paused: '已暂停', stopped: '已停止' };
function updateJob(value) { const index = jobs.value.findIndex(item => item.id === value.id); if (index < 0) jobs.value.unshift(value); else jobs.value[index] = value; jobs.value.sort((a, b) => b.createdAt - a.createdAt); }
async function refresh() {
  const state = await api.workflowState(); jobs.value = state.jobs; rateLimits.value = state.rateLimits || {}; sharedCollectors.value = state.sharedCollectors || 0;
}
async function load() {
  if (!accountId.value) return;
  const id = accountId.value; busy.value = true; error.value = '';
  try {
    const result = await api.videoCourses(); if (id !== accountId.value) return;
    courses.value = result.courses; if (!courses.value.some(course => course.url === courseUrl.value)) courseUrl.value = courses.value[0]?.url || '';
    await refresh();
  } catch (e) { if (id === accountId.value) error.value = e.message; }
  finally { if (id === accountId.value) busy.value = false; }
}
async function start() {
  busy.value = true; error.value = '';
  try { const result = await api.workflowStart(courseUrl.value, concurrency.value); updateJob(result.job); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function control(action) {
  if (!job.value) return; busy.value = true; error.value = '';
  try { const result = await api.workflowControl(job.value.id, action); updateJob(result.job); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
function countdown(state) { return state?.blocked ? Math.max(0, Math.ceil((state.readyAt - now.value) / 1000)) : 0; }
function percent(module) { return module?.total ? Math.min(100, Math.round((module.processed || 0) / module.total * 100)) : module?.status === 'done' ? 100 : 0; }
const failures = computed(() => Object.entries(job.value?.modules || {}).flatMap(([kind, value]) => (value.results || []).filter(item => item.error).map(item => ({ ...item, kind }))));
let events, clock, polling, refreshing = false;
watch(accountId, () => { courses.value = []; jobs.value = []; courseUrl.value = ''; error.value = ''; load(); });
onMounted(() => {
  load();
  events = subscribeEvents(event => {
    if (event.type === 'workflow') updateJob(event.job);
    if (event.type === 'rate-limit') rateLimits.value = { ...rateLimits.value, [event.role]: event };
  });
  clock = setInterval(() => { now.value = Date.now(); }, 1000);
  polling = setInterval(async () => {
    if (!accountId.value || refreshing) return;
    refreshing = true; try { await refresh(); } catch {} finally { refreshing = false; }
  }, 3000);
});
onUnmounted(() => { events?.close(); clearInterval(clock); clearInterval(polling); });
</script>

<template>
  <section class="panel workflow-panel" aria-labelledby="workflow-title">
    <div class="workflow-heading"><div><h2 id="workflow-title">一键完成课程</h2><p class="dim">视频、图文、讨论同时推进；已有答案直接作答，缺失答案由全站答案采集账号补齐。</p></div><span class="tag" :class="job?.status === 'done' ? 'ok' : running ? 'run' : ''">{{ names[job?.status] || '准备就绪' }}</span></div>
    <label for="workflow-course">选择课程</label>
    <div class="course-line">
      <select id="workflow-course" v-model="courseUrl" :disabled="!session.connected || busy || running"><option value="" disabled>请选择已选课程</option><option v-for="course in courses" :key="course.classroomId" :value="course.url">{{ course.title }}</option></select>
      <label for="workflow-concurrency">每类任务并发</label><select id="workflow-concurrency" v-model.number="concurrency" :disabled="running"><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option></select>
      <button :disabled="!session.connected || busy || running" @click="load">刷新课程</button>
    </div>
    <div class="row primary-actions">
      <button class="primary complete-button" :disabled="!session.connected || !courseUrl || busy || running" @click="start">▶ 一键完成</button>
      <button v-if="running" :disabled="busy" @click="control('pause')">暂停</button>
      <button v-if="job && ['paused','partial','stopped','waiting_input'].includes(job.status)" :disabled="busy" @click="control('resume')">继续 / 重试未完成项</button>
      <button v-if="running || job?.status === 'paused'" class="danger" :disabled="busy" @click="control('stop')">停止</button>
    </div>
    <p v-if="job?.modules.collector?.message && job.modules.collector.status !== 'done'" class="notice">答案采集：{{job.modules.collector.message}}</p>
    <div class="status-grid">
      <div class="status-card"><span class="dim">正式账号提交状态</span><strong>{{ countdown(rateLimits.primary) ? '限流等待' : '可提交' }}</strong><span class="dim">{{countdown(rateLimits.primary)?`${countdown(rateLimits.primary)} 秒后重试`:'仅在服务端返回限流时等待'}}</span></div>
      <div class="status-card"><span class="dim">全站答案采集</span><strong>{{sharedCollectors ? '已就绪' : '等待管理员配置'}}</strong><span class="dim">缺少答案时自动采集；只免费加入课程</span></div>
      <div class="status-card"><span class="dim">本课程题库</span><strong>{{ job?.coverage ? `${job.coverage.captured} / ${job.coverage.total}` : '待扫描' }}</strong><span class="dim">{{ job?.coverage?.missing ? `缺少 ${job.coverage.missing} 条答案，边采集边作答` : '仅使用匹配版本的标准答案' }}</span></div>
    </div>
    <div class="module-grid">
      <article v-for="item in modules" :key="item.kind" class="module-card" :data-module="item.kind">
        <div class="row"><strong>{{ item.icon }} {{ item.title }}</strong><span class="spacer"></span><span class="dim">{{ names[job?.modules[item.kind]?.status] || '待开始' }}</span></div>
        <div class="module-count">{{ job?.modules[item.kind]?.processed || 0 }} <span class="dim">/ {{ job?.modules[item.kind]?.total ?? '—' }}</span></div>
        <progress :value="percent(job?.modules[item.kind])" max="100" :aria-label="item.title + '进度'"></progress>
        <p class="dim">{{ job?.modules[item.kind]?.message || '启动后自动处理未完成项目' }}</p>
      </article>
    </div>
    <div v-if="failures.length" class="failures"><strong>需要处理的项目</strong><div v-for="(item,index) in failures" :key="index">{{ item.title || (item.problemId ? `题目 ${item.problemId}` : `单元 ${item.unitId}`) }}：{{ item.error }}</div></div>
    <details v-if="job?.logs?.length" class="unified-log"><summary>统一运行日志</summary><div class="log-list"><div v-for="(entry,index) in job.logs" :key="index"><span class="dim">{{ new Date(entry.ts).toLocaleTimeString() }}</span> · {{ modules.find(item => item.kind === entry.kind)?.title || (entry.kind === 'collector' ? '答案采集' : '课程') }} · {{ entry.message }}</div></div></details>
    <p v-if="!session.connected" class="dim">请先在上方连接正式账号。</p><p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="job" class="dim saved-note">进度已自动保存，可暂停后继续。任务 {{ job.id.slice(0, 8) }}</p>
  </section>
</template>
<style scoped>
h2 { margin: 0 0 6px; font-size: 21px; letter-spacing: 1px; }
p { margin: 8px 0; }
.workflow-heading { display: flex; align-items: flex-start; gap: 14px; justify-content: space-between; margin-bottom: 18px; }
.workflow-heading p { max-width: 760px; }
.course-line { display: flex; align-items: center; gap: 10px; margin-top: 7px; flex-wrap: wrap; }
select { font: inherit; min-width: 0; padding: 10px; background: white; border: 1px solid var(--border); border-radius: 9px; }
#workflow-course { flex: 1; min-width: 240px; }
#workflow-concurrency { width: 65px; }
.primary-actions { margin: 16px 0; }
.complete-button { padding: 12px 25px; }
.test-account { padding: 12px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.test-account summary { cursor: pointer; font-weight: 600; }
.test-account summary span { margin-left: 10px; font-weight: 400; }
.test-account textarea { margin: 8px 0; }
.status-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 18px 0; }
.status-card { padding: 13px; background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; gap: 5px; }
.status-card strong { font-size: 22px; }
.module-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.module-card { min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: rgba(255,255,255,.6); }
.module-count { font-size: 24px; margin: 10px 0; font-variant-numeric: tabular-nums; }
.module-card p { min-height: 38px; overflow-wrap: anywhere; font-size: 11px; }
progress { width: 100%; height: 7px; accent-color: var(--accent); }
.error,.failures { color: var(--err); overflow-wrap: anywhere; }
.notice { color: var(--warn); }
.failures { padding: 12px; margin-top: 16px; border: 1px solid var(--border); border-radius: 10px; max-height: 200px; overflow: auto; }
.failures div { padding-top: 6px; }
.saved-note { font-size: 11px; margin-top: 16px; }
.unified-log { margin-top: 16px; }.unified-log summary { cursor: pointer; }.log-list { margin-top: 10px; max-height: 230px; overflow: auto; font-size: 11px; overflow-wrap: anywhere; }.log-list div { padding: 4px 0; }
@media (max-width: 800px) { .module-grid { grid-template-columns: repeat(2,1fr); } .status-grid { grid-template-columns: 1fr; } }
@media (max-width: 480px) { .workflow-heading { flex-direction: column; } #workflow-course { min-width: 100%; max-width: 100%; } .module-grid { grid-template-columns: 1fr; } }
</style>
