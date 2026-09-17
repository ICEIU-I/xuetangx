<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api';

const props = defineProps({ session: Object, task: Object });
const url = ref('');
const duration = ref('');
const details = ref(null);
const busy = ref(false);
const starting = ref(false);
const error = ref('');
const inventory = ref(null);
const scanning = ref(false);
const courses = ref([]);
const courseUrl = ref('');
const loadingCourses = ref(false);
const concurrency = ref(1);
let revision = 0;
const running = computed(() => props.task.status === 'running');
const locked = computed(() => running.value || starting.value);
const account = computed(() => props.session.connected ? String(props.session.user?.user_id || props.session.user?.id || '') : '');
const progress = computed(() => details.value?.progress);
const visibleResults = computed(() => props.task.result?.kind === 'batch' ? props.task.result.results : props.task.recentResults || []);
const sendPercent = computed(() => props.task.total ? Math.min(100, Math.round(props.task.sent / props.task.total * 100)) : 0);
const canStart = computed(() => props.session.connected && details.value && !progress.value?.completed && !busy.value && !locked.value
  && (details.value.durationSeconds || (Number(duration.value) > 0 && Number(duration.value) <= 86400)));
const formatPercent = value => `${((value || 0) * 100).toFixed(2).replace(/\.00$/, '')}%`;
function time(value) {
  if (value == null || value === '') return '未返回';
  const seconds = Math.round(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function resetPreview() { revision++; details.value = null; duration.value = ''; error.value = ''; busy.value = false; }
watch(url, resetPreview);
watch(account, value => {
  resetPreview(); inventory.value = null; scanning.value = false; courses.value = []; courseUrl.value = '';
  if (value) loadCourses();
}, { immediate: true });
watch(courseUrl, () => { inventory.value = null; error.value = ''; });
watch(() => props.task.status, status => {
  if (status === 'done' && props.task.result?.video?.url && props.task.result.video.url === details.value?.video.url && props.session.connected) details.value = props.task.result;
});

async function scan() {
  const identity = account.value;
  const selected = courseUrl.value;
  scanning.value = true; error.value = '';
  try { const result = await api.videoScan(selected); if (identity === account.value && selected === courseUrl.value) inventory.value = result; }
  catch (e) { if (identity === account.value) error.value = e.message; }
  finally { if (identity === account.value) scanning.value = false; }
}

async function loadCourses() {
  const identity = account.value;
  loadingCourses.value = true; error.value = '';
  try {
    const result = await api.videoCourses();
    if (identity === account.value) {
      courses.value = result.courses;
      if (!courses.value.some(course => course.url === courseUrl.value)) courseUrl.value = courses.value[0]?.url || '';
    }
  } catch (e) { if (identity === account.value) error.value = e.message; }
  finally { if (identity === account.value) loadingCourses.value = false; }
}

async function startCourse() {
  starting.value = true; error.value = '';
  try { await api.videoRunCourse(courseUrl.value, concurrency.value); } catch (e) { error.value = e.message; }
  finally { starting.value = false; }
}

async function inspect() {
  const token = ++revision;
  error.value = ''; busy.value = true; details.value = null;
  try {
    const result = await api.videoInspect(url.value.trim());
    if (token === revision) { details.value = result; duration.value = result.durationSeconds || ''; }
  } catch (e) { if (token === revision) error.value = e.message; }
  finally { if (token === revision) busy.value = false; }
}

async function start() {
  if (!canStart.value) return;
  error.value = ''; starting.value = true;
  try { await api.videoRun(details.value.video.url, details.value.durationSeconds || Number(duration.value)); }
  catch (e) { error.value = e.message; }
  finally { starting.value = false; }
}

async function stop() {
  try { await api.videoStop(); } catch (e) { error.value = e.message; }
}
</script>

<template>
  <section class="panel video-panel" aria-labelledby="video-title">
    <div class="row video-heading">
      <h2 id="video-title" class="panel-title">视频进度 / VIDEO</h2>
      <span v-if="progress?.completed" class="tag ok">后端已完成</span>
    </div>
    <p class="dim intro">选择一门已选课程，一次完成这门课的全部视频。已完成项自动跳过，每个视频都回查后端结果。</p>
    <label for="video-course" class="field-label">要处理的课程</label>
    <div class="url-row course-select">
      <select id="video-course" v-model="courseUrl" :disabled="!session.connected || locked || scanning || loadingCourses">
        <option value="" disabled>{{ loadingCourses ? '正在读取已选课程…' : '请选择课程' }}</option>
        <option v-for="course in courses" :key="course.classroomId" :value="course.url">{{ course.title }}</option>
      </select>
      <button :disabled="!session.connected || locked || scanning || loadingCourses" @click="loadCourses">刷新课程</button>
    </div>
    <div class="row batch-actions">
      <label for="video-concurrency">并发视频数</label>
      <select id="video-concurrency" v-model.number="concurrency" :disabled="locked">
        <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option>
      </select>
      <button class="primary" :disabled="!session.connected || !courseUrl || locked || scanning || busy || loadingCourses" @click="startCourse">一键完成本课程全部视频</button>
      <button :disabled="!session.connected || !courseUrl || locked || scanning || busy || loadingCourses" @click="scan">{{ scanning ? '扫描视频中…' : '查看本课程视频' }}</button>
    </div>
    <div v-if="inventory" class="inventory">
      <strong>{{ inventory.course.title }} · {{ inventory.totalVideos }} 个视频</strong>
    </div>
    <p v-if="session.connected && !loadingCourses && !courses.length" class="dim help">未找到正在上课的已选课程，可点击「刷新课程」重试。</p>
    <details class="single-video">
      <summary>指定单个视频（可选）</summary>
    <label for="video-url" class="field-label">视频链接</label>
    <div class="url-row">
      <input id="video-url" v-model="url" type="url" :disabled="locked" autocomplete="off"
        placeholder="https://www.xuetangx.com/learn/space/…/video/…" @keyup.enter="!busy && !locked && session.connected && inspect()" />
      <button :disabled="!session.connected || !url.trim() || busy || locked" @click="inspect">{{ busy ? '查询中…' : '查询进度' }}</button>
    </div>
    <p v-if="!session.connected" class="dim help">先在上方连接登录态，再查询视频。</p>

    <div v-if="details" class="video-details">
      <div class="video-name">{{ details.video.title }}</div>
      <div class="row dim metadata">
        <span>视频 {{ details.video.leafId }}</span><span>总时长 {{ time(details.durationSeconds || duration) }}</span>
        <span>后端进度 <strong class="accent">{{ formatPercent(progress?.rate) }}</strong></span>
        <span>有效观看 {{ time(progress?.watchLength) }}</span>
      </div>
      <div v-if="!details.durationSeconds && !progress?.completed" class="duration-row">
        <label for="video-duration">总时长（秒）</label>
        <input id="video-duration" v-model="duration" type="number" min="1" max="86400" step="any" :disabled="locked" placeholder="例如 694" />
        <span class="dim">平台尚未返回时长，请按播放器显示填写。</span>
      </div>
      <div class="row actions">
        <button class="primary" :disabled="!canStart" @click="start">{{ progress?.completed ? '已完成' : '完成此视频' }}</button>
        <button :disabled="busy || locked || !session.connected" @click="inspect">刷新后端进度</button>
      </div>
    </div>
    </details>
    <p v-if="!session.connected" class="dim help">先在上方连接登录态。</p>

    <div v-if="session.connected && task.status !== 'idle'" class="task-state" aria-live="polite">
      <div v-if="task.mode === 'course'" class="batch-counts">
        <strong>{{ task.processedVideos || 0 }} / {{ task.totalVideos || 0 }} 个视频</strong>
        <span>新完成 {{ task.completedVideos || 0 }}</span><span>已完成跳过 {{ task.skippedVideos || 0 }}</span><span>失败 {{ task.failedVideos || 0 }}</span>
      </div>
      <div class="row">
        <span :class="['tag', task.status === 'done' ? 'ok' : task.status === 'error' ? 'err' : task.status === 'partial' ? 'warn' : '']">
          {{ task.status === 'done' ? '完成' : task.status === 'partial' ? '部分完成' : task.status === 'error' ? '失败' : task.status === 'stopped' ? '已停止' : task.stage === 'waiting' ? '限速等待' : task.stage === 'verifying' ? '核对中' : '处理中' }}
        </span>
        <span class="task-message">{{ task.message }}</span>
        <button v-if="running" class="danger" @click="stop">停止视频任务</button>
      </div>
      <div v-if="running && task.total" class="send-progress">
        <progress :value="task.sent" :max="task.total" aria-label="发送进度"></progress>
        <span class="dim">发送进度 {{ sendPercent }}% · 完成状态以后端核对为准</span>
      </div>
      <p v-if="task.mode === 'course' && task.currentCourse" class="dim result-line">{{ task.currentCourse }}<span v-if="running"> / {{ task.title }}</span></p>
      <div v-if="running && task.activeVideos?.length > 1" class="batch-results">
        <div v-for="item in task.activeVideos" :key="item.leafId" class="course-row"><span>{{ item.title }}</span><span class="dim">{{ item.message }}</span></div>
      </div>
      <p v-if="task.result?.video" class="dim result-line">{{ task.result.video.title }}：{{ formatPercent(task.result.before.rate) }} → {{ formatPercent(task.result.progress.rate) }}</p>
      <div v-if="task.mode === 'course' && visibleResults.length" class="batch-results">
        <div v-for="item in visibleResults" :key="item.url" class="course-row">
          <span>{{ item.title }}</span><span :class="item.status === 'failed' ? 'error-message' : 'dim'">{{ item.error || (item.status === 'skipped' ? '已完成，跳过' : '后端确认完成') }}</span>
        </div>
      </div>
      <p v-if="task.result?.stoppedReason" class="error-message">{{ task.result.stoppedReason }}</p>
    </div>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.video-heading { justify-content: space-between; }
h2.panel-title { margin: 0; font-weight: 400; }
.intro { margin: 10px 0 14px; font-size: 12px; }
.batch-actions { margin: 14px 0; }
#video-concurrency { width: 64px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: white; font: inherit; }
.course-select select { width: 100%; min-width: 0; flex: 1; padding: 10px; border: 1px solid var(--border); border-radius: 9px; color: var(--text); background: white; font: inherit; }
.inventory, .batch-results { margin: 12px 0; padding: 12px; border: 1px solid var(--border); border-radius: 9px; }
.batch-results { max-height: 260px; overflow-y: auto; }
.course-row { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 16px; padding: 5px 0; font-size: 12px; overflow-wrap: anywhere; }
.course-row .error-message { margin: 0; }
.single-video { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
.single-video summary { cursor: pointer; color: var(--text-dim); margin-bottom: 12px; }
.batch-counts { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-bottom: 12px; font-size: 12px; }
.field-label { display: block; margin-bottom: 6px; font-size: 12px; }
.url-row { display: flex; gap: 10px; }
.url-row input { flex: 1; min-width: 0; }
.url-row button { flex-shrink: 0; }
.help { margin-bottom: 0; font-size: 12px; }
.video-details { margin-top: 16px; padding: 14px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-panel-2); }
.video-name { font-weight: 600; overflow-wrap: anywhere; }
.metadata { margin-top: 8px; font-size: 12px; gap: 10px 20px; }
.duration-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 12px; font-size: 12px; }
.duration-row input { width: 130px; }
.actions { margin-top: 14px; }
.task-state { margin-top: 16px; }
.task-message { flex: 1; min-width: 180px; overflow-wrap: anywhere; }
.send-progress { margin-top: 12px; }
progress { display: block; width: 100%; height: 9px; accent-color: var(--accent); margin-bottom: 6px; }
.result-line { margin-bottom: 0; }
.error-message { color: var(--err); margin-bottom: 0; overflow-wrap: anywhere; }
@media (max-width: 600px) { .url-row { flex-direction: column; } .metadata { align-items: flex-start; flex-direction: column; } }
</style>
