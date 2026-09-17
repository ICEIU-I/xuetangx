<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api';
const props = defineProps({ session: Object, task: Object });
const concurrency = ref(1);
const courses = ref([]), courseUrl = ref(''), submitUnanswered = ref(false);
const loading = ref(false), starting = ref(false), error = ref(''), saved = ref(null);
const running = computed(() => props.task.status === 'running');
const account = computed(() => props.session.connected ? String(props.session.user?.user_id || props.session.user?.id || '') : '');
const selected = computed(() => courses.value.find(course => course.url === courseUrl.value));
const counts = computed(() => {
  const current = props.task.course?.classroomId === selected.value?.classroomId ? props.task : null;
  return running.value && current ? current : saved.value?.summary || current;
});
const exercises = computed(() => saved.value ? Object.values(saved.value.database.exercises).filter(item => item.active !== false) : []);
function answerText(question) {
  if (question.answer_status !== 'captured') return question.error || '未获取';
  return question.answer ?? (question.answers ? question.answers.join('、') : JSON.stringify(question.reference_answer));
}
function plain(html) { return (html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').slice(0, 140); }
async function loadCourses() {
  const identity = account.value;
  loading.value = true; error.value = '';
  try {
    const result = await api.videoCourses();
    if (identity === account.value) { courses.value = result.courses; courseUrl.value = courses.value[0]?.url || ''; }
  } catch (e) { if (identity === account.value) error.value = e.message; }
  finally { if (identity === account.value) loading.value = false; }
}
async function readSaved() {
  if (!selected.value) return;
  const classroomId = selected.value.classroomId;
  try {
    const result = await api.answerDatabase(classroomId);
    if (classroomId === selected.value?.classroomId) { saved.value = result; error.value = ''; }
  } catch (e) { if (classroomId === selected.value?.classroomId) { saved.value = null; error.value = e.message; } }
}
watch(account, value => { courses.value = []; courseUrl.value = ''; saved.value = null; error.value = ''; submitUnanswered.value = false; if (value) loadCourses(); }, { immediate: true });
watch(courseUrl, () => { saved.value = null; error.value = ''; submitUnanswered.value = false; });
watch(() => props.task.status, value => { if (['done', 'partial', 'error', 'stopped'].includes(value) && selected.value) readSaved(); });
async function start() {
  starting.value = true; error.value = '';
  try { await api.collectAnswers(courseUrl.value, submitUnanswered.value, concurrency.value); }
  catch (e) { error.value = e.message; }
  finally { starting.value = false; }
}
async function stop() { try { await api.stopAnswers(); } catch (e) { error.value = e.message; } }
</script>

<template>
  <section class="panel answer-panel" aria-labelledby="answer-title">
    <h2 class="panel-title" id="answer-title">课程答案库 / ANSWERS</h2>
    <p class="dim">采集指定课程的作业、章节测试等练习，逐题保存到本地 JSON，供后续刷题使用。</p>
    <label for="answer-course">选择课程</label>
    <div class="course-row">
      <select id="answer-course" v-model="courseUrl" :disabled="!session.connected || running || loading || starting">
        <option value="" disabled>{{ loading ? '读取课程中…' : '请选择课程' }}</option>
        <option v-for="course in courses" :key="course.classroomId" :value="course.url">{{ course.title }}</option>
      </select>
      <button :disabled="!session.connected || running || loading" @click="loadCourses">刷新课程</button>
    </div>
    <label class="mode"><input type="checkbox" v-model="submitUnanswered" :disabled="running || starting" />提交未做题后采集答案</label>
    <p class="mode-note" :class="{ warn: submitUnanswered }">{{ submitUnanswered ? '此模式会提交测试选项，消耗作答机会并可能影响成绩；已作答题不会重复提交。' : '当前仅读取后端已公开的标准答案，不提交作答。' }}</p>
    <div class="row actions">
      <label for="answer-concurrency">并发练习数</label>
      <select id="answer-concurrency" class="concurrency" v-model.number="concurrency" :disabled="running || starting"><option :value="1">1</option></select>
      <button class="primary" :disabled="!session.connected || !courseUrl || running || loading || starting" @click="start">{{ submitUnanswered ? '提交并采集本课程答案' : '获取本课程已公开答案' }}</button>
      <button :disabled="!selected || running" @click="readSaved">查看本地答案</button>
      <button v-if="running" class="danger" @click="stop">停止采集</button>
      <a v-if="saved && selected" :href="`/api/answer-bank/${selected.classroomId}?download=1`">下载 JSON</a>
    </div>
    <div v-if="counts" class="counts row">
      <strong>已获取 {{ counts.capturedAnswers || 0 }} / {{ counts.totalQuestions || 0 }} 题</strong>
      <span>练习 {{ counts.processedExercises || 0 }}/{{ counts.totalExercises || 0 }}</span>
      <span>缺失 {{ counts.missingAnswers || 0 }}</span>
    </div>
    <p v-if="task.status !== 'idle'" class="dim" aria-live="polite">{{ task.message }}</p>
    <p v-if="selected && saved" class="dim">保存位置：data/answer-db/{{ selected.classroomId }}.json</p>
    <div class="exercise-list" v-if="exercises.length">
      <details v-for="exercise in exercises" :key="exercise.leaf_id">
        <summary>{{ exercise.section }} · {{ exercise.questions?.filter(q => q.answer_status === 'captured').length || 0 }}/{{ exercise.questions?.length || 0 }} 题</summary>
        <p v-if="exercise.error" class="error">{{ exercise.error }}</p>
        <div v-for="question in exercise.questions || []" :key="question.problem_id" class="question">
          <div>{{ question.index }}. {{ plain(question.body_html) }}</div>
          <div :class="question.answer_status === 'captured' ? 'answer' : 'dim'">{{ question.answer_status === 'captured' ? '标准答案：' : '' }}{{ answerText(question) }}</div>
        </div>
      </details>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
select.concurrency { flex: none; width: 64px; padding: 8px; }
h2 { font-weight: 400; }
.course-row { display: flex; gap: 10px; margin: 6px 0 12px; }
select { min-width: 0; width: 100%; flex: 1; padding: 10px; border: 1px solid var(--border); border-radius: 9px; background: white; font: inherit; }
.course-row button { flex-shrink: 0; }
.mode { display: flex; align-items: center; gap: 8px; }
.mode input { width: auto; }
.mode-note { font-size: 12px; color: var(--text-dim); }
.warn { color: var(--warn); }
.actions { margin: 12px 0; }
.actions a { color: var(--accent-2); }
.counts { margin-top: 16px; }
.exercise-list { max-height: 400px; overflow-y: auto; margin-top: 14px; }
details { border-top: 1px solid var(--border); padding: 12px 0; }
summary { cursor: pointer; }
.question { border-top: 1px dashed var(--border); padding: 10px 0; margin: 0 8px; overflow-wrap: anywhere; }
.answer { color: var(--ok); margin-top: 6px; }
.error { color: var(--err); overflow-wrap: anywhere; }
@media (max-width: 600px) { .course-row { flex-direction: column; } }
</style>
