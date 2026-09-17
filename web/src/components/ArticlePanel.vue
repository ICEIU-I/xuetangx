<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api';
const props = defineProps({ session: Object, task: Object });
const concurrency = ref(1);
const courses = ref([]), courseUrl = ref(''), inventory = ref(null), error = ref('');
const loading = ref(false), scanning = ref(false), starting = ref(false);
const running = computed(() => props.task.status === 'running');
const account = computed(() => props.session.connected ? String(props.session.user?.user_id || props.session.user?.id || '') : '');
const busy = computed(() => running.value || loading.value || scanning.value || starting.value);
const canStart = computed(() => props.session.connected && courseUrl.value && !busy.value);
async function loadCourses() {
  const identity = account.value;
  loading.value = true; error.value = '';
  try {
    const result = await api.videoCourses();
    if (identity === account.value) { courses.value = result.courses; if (!courses.value.some(c => c.url === courseUrl.value)) courseUrl.value = courses.value[0]?.url || ''; }
  } catch (e) { if (identity === account.value) error.value = e.message; }
  finally { if (identity === account.value) loading.value = false; }
}
async function scan() {
  const selected = courseUrl.value, identity = account.value;
  scanning.value = true; error.value = '';
  try { const result = await api.articleScan(selected); if (selected === courseUrl.value && identity === account.value) inventory.value = result; }
  catch (e) { if (identity === account.value) error.value = e.message; }
  finally { if (identity === account.value) scanning.value = false; }
}
async function start() {
  if (!canStart.value) return;
  starting.value = true; error.value = '';
  try { await api.articleRun(courseUrl.value, concurrency.value); } catch (e) { error.value = e.message; }
  finally { starting.value = false; }
}
async function stop() { try { await api.articleStop(); } catch (e) { error.value = e.message; } }
watch(account, value => { courses.value = []; courseUrl.value = ''; inventory.value = null; error.value = ''; loading.value = false; scanning.value = false; if (value) loadCourses(); }, { immediate: true });
watch(courseUrl, () => { inventory.value = null; error.value = ''; });
watch(() => props.task.status, value => { if (['done', 'partial', 'stopped'].includes(value) && props.task.course?.url === courseUrl.value && props.session.connected) scan(); });
</script>

<template>
  <section class="panel article-panel" aria-labelledby="article-title">
    <h2 id="article-title" class="panel-title">图文进度 / ARTICLES</h2>
    <p class="dim">将指定课程的全部图文标记为看完。串行执行，跳过已完成项，并逐项回查后端状态。</p>
    <label for="article-course">选择课程</label>
    <div class="course-row">
      <select id="article-course" v-model="courseUrl" :disabled="!session.connected || busy">
        <option value="" disabled>{{ loading ? '读取课程中…' : '请选择课程' }}</option>
        <option v-for="course in courses" :key="course.classroomId" :value="course.url">{{ course.title }}</option>
      </select>
      <button :disabled="!session.connected || busy" @click="loadCourses">刷新课程</button>
    </div>
    <div class="row actions">
      <label for="article-concurrency">并发数</label>
      <select id="article-concurrency" class="concurrency" v-model.number="concurrency" :disabled="running || starting"><option :value="1">1</option></select>
      <button class="primary" :disabled="!canStart" @click="start">一键标记本课程全部图文</button>
      <button :disabled="!canStart" @click="scan">{{ scanning ? '查询中…' : '查看图文进度' }}</button>
      <button v-if="running" class="danger" @click="stop">停止标记</button>
    </div>
    <div v-if="inventory" class="inventory"><strong>{{ inventory.course.title }}</strong><span>{{ inventory.completed }} / {{ inventory.total }} 个图文已看完</span></div>
    <div v-if="session.connected && task.status !== 'idle'" class="task" aria-live="polite">
      <div class="row counts"><strong>{{ task.processed || 0 }} / {{ task.total || 0 }}</strong><span>新标记 {{ task.completed || 0 }}</span><span>跳过 {{ task.skipped || 0 }}</span><span>失败 {{ task.failed || 0 }}</span></div>
      <p :class="task.status === 'error' || task.status === 'partial' ? 'error' : 'dim'">{{ task.message }}</p>
      <p v-if="task.stoppedReason || task.result?.stoppedReason" class="error" role="alert">停止原因：{{ task.stoppedReason || task.result.stoppedReason }}</p>
      <div v-if="task.results?.length" class="results">
        <div v-for="item in [...task.results].sort((a, b) => (b.status === 'failed') - (a.status === 'failed'))" :key="item.leafId" class="result-row"><span>{{ item.title }}</span><span :class="item.status === 'failed' ? 'error' : 'dim'">{{ item.error || (item.status === 'skipped' ? '已看完，跳过' : '后端确认已看完') }}</span></div>
      </div>
    </div>
    <p v-if="!session.connected" class="dim">先在上方连接登录态。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
select.concurrency { flex: none; width: 64px; padding: 8px; }
h2 { font-weight: 400; }
.course-row { display: flex; gap: 10px; margin: 6px 0 12px; }
select { min-width: 0; flex: 1; width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 9px; background: white; font: inherit; }
.course-row button { flex-shrink: 0; }
.actions { margin: 12px 0; }
.inventory { display: flex; flex-wrap: wrap; gap: 8px 20px; border: 1px solid var(--border); padding: 12px; border-radius: 9px; }
.task { margin-top: 16px; }
.counts { font-size: 12px; }
.results { max-height: 240px; overflow-y: auto; }
.result-row { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 16px; padding: 7px 0; border-top: 1px solid var(--border); }
.error { color: var(--err); overflow-wrap: anywhere; }
@media (max-width: 600px) { .course-row { flex-direction: column; } }
</style>
