<script setup>
import { ref, reactive, watch, onMounted, onUnmounted } from 'vue';
import { api, subscribeEvents } from '../../api';
import CookiePanel from '../CookiePanel.vue';
import StatBar from '../StatBar.vue';
import StatusGrid from '../StatusGrid.vue';
import RunConsole from '../RunConsole.vue';
import VideoPanel from '../VideoPanel.vue';
import AnswerPanel from '../AnswerPanel.vue';
import ArticlePanel from '../ArticlePanel.vue';
import DiscussionPanel from '../DiscussionPanel.vue';
import WorkflowPanel from '../workflow/WorkflowPanel.vue';
const advancedOpen = ref(false);

const session = reactive({ connected: false, user: null });
const homeworkCourses = ref([]), homeworkUrl = ref(''), homeworkConcurrency = ref(3);
const stats = reactive({ totalQ: null, doneQ: null, rightQ: null });

// —— 标题打字机 ——
const BRAND = 'ICEIU';
const typed = ref('');
let typeTimer = null;
function startTyping() {
  let i = 0, dir = 1;
  const tick = () => {
    typed.value = BRAND.slice(0, i);
    if (dir === 1) {
      if (i < BRAND.length) { i++; typeTimer = setTimeout(tick, 200); }
      else { dir = -1; typeTimer = setTimeout(tick, 3000); }
    } else {
      if (i > 0) { i--; typeTimer = setTimeout(tick, 110); }
      else { dir = 1; typeTimer = setTimeout(tick, 700); }
    }
  };
  tick();
}

const sections = ref([]);          // 状态板数据
const selected = ref([]);          // 选中要跑的作业
const loadingStatus = ref(false);
const runState = reactive({ status: 'idle', total: 0, done: 0, correct: 0, failed: 0, ratePerMin: 0, etaSec: 0, rateLimited: false });
const logs = ref([]);
const videoState = reactive({ status: 'idle', sent: 0, total: 0, message: '', result: null });
const answerState = reactive({ status: 'idle', message: '', result: null });
const articleState = reactive({ status: 'idle', message: '', result: null });
const discussionState = reactive({ status: 'idle', message: '', result: null });
let es = null;

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toTimeString().slice(0, 8);
}

async function refreshSession() {
  const s = await api.session();
  session.connected = s.connected;
  session.user = s.user;
}

async function onConnected(user) {
  session.connected = true;
  session.user = user;
  if (advancedOpen.value) await loadAdvanced();
}
async function loadAdvanced() {
  try {
    const result = await api.videoCourses();
    homeworkCourses.value = result.courses;
    homeworkUrl.value = result.courses[0]?.url || '';
    await refreshStatus();
  } catch (error) { pushLog('fail', '课程加载失败', null, error.message); }
}
watch(advancedOpen, open => { if (open && session.connected) loadAdvanced(); });
function onDisconnected() {
  session.connected = false; session.user = null;
  homeworkCourses.value = []; homeworkUrl.value = ''; selected.value = [];
  sections.value = []; stats.totalQ = stats.doneQ = stats.rightQ = null;
}

async function refreshStatus() {
  if (!session.connected || !homeworkUrl.value) return;
  loadingStatus.value = true;
  try {
    const r = await api.status(homeworkUrl.value);
    sections.value = r.sections;
    stats.totalQ = r.totalQ; stats.doneQ = r.doneQ; stats.rightQ = r.rightQ;
  } catch (e) {
    pushLog('fail', 'STATUS', null, e.message);
  } finally { loadingStatus.value = false; }
}

function toggleSelect(name) {
  const i = selected.value.indexOf(name);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(name);
}

function pushLog(mark, name, problemId, msg) {
  logs.value.push({ ts: fmtTime(), mark, name, problemId, msg });
  if (logs.value.length > 2000) logs.value.splice(0, 500);
}

async function startRun() {
  Object.assign(runState, { status: 'running', total: 0, done: 0, correct: 0, failed: 0, ratePerMin: 0, etaSec: 0, rateLimited: false });
  pushLog('', '>>> 启动任务', null, selected.value.length ? `选中 ${selected.value.length} 套` : '全部未完成');
  try {
    await api.run(selected.value.length ? [...selected.value] : null, homeworkUrl.value, homeworkConcurrency.value);
  } catch (e) { pushLog('fail', '启动失败', null, e.message); runState.status = 'error'; }
}
async function stopRun() { await api.stop(); pushLog('', '<<< 停止请求已发送', null, ''); }
function clearLogs() { logs.value = []; }

// 处理 SSE 事件
function handleEvent(evt) {
  if (evt.type === 'accounts' && !evt.accounts.primary.connected) { onDisconnected(); return; }
  if (evt.type === 'reset') { Object.assign(runState, evt); return; }
  if (evt.type === 'hello') Object.assign(runState, pick(evt));
  if (evt.type === 'discussion') { Object.assign(discussionState, evt); return; }
  if (evt.type === 'article') { Object.assign(articleState, evt); return; }
  if (evt.type === 'answer-bank') { Object.assign(answerState, evt); return; }
  if (evt.type === 'video') { Object.assign(videoState, evt); return; }
  if (evt.type === 'hello' && evt.video) Object.assign(videoState, evt.video);
  if (evt.type === 'hello' && evt.answerBank) Object.assign(answerState, evt.answerBank);
  if (evt.type === 'hello' && evt.article) Object.assign(articleState, evt.article);
  if (evt.type === 'hello' && evt.discussion) Object.assign(discussionState, evt.discussion);
  if (evt.type === 'progress') {
    Object.assign(runState, pick(evt));
    pushLog(evt.mark, evt.name, evt.problemId, evt.msg);
    // 实时更新状态板对应格
    if (evt.mark !== 'fail') bumpSection(evt.name);
  } else if (evt.type === 'start') {
    runState.total = evt.total;
    pushLog('', '>>> 待提交', null, `${evt.total} 题 / ${evt.sets} 套`);
  } else if (evt.type === 'phase') {
    pushLog('', '···', null, evt.msg);
  } else if (evt.type === 'done' || evt.type === 'partial' || evt.type === 'stopped' || evt.type === 'error') {
    Object.assign(runState, pick(evt));
    runState.status = evt.type;
    runState.rateLimited = false;
    pushLog('', evt.type === 'done' ? '=== 完成' : '=== ' + evt.type, null,
      evt.msg || `提交 ${evt.done} 对 ${evt.correct} 失败 ${evt.failed}，已做跳过 ${evt.skipped || 0}`);
    refreshStatus(); // 跑完刷新真实状态
  }
}
function pick(e) {
  const { status, total, done, correct, failed, ratePerMin, etaSec, rateLimited } = e;
  const o = {}; for (const k of ['status','total','done','correct','failed','ratePerMin','etaSec','rateLimited']) if (e[k] !== undefined) o[k] = e[k];
  return o;
}
function bumpSection(name) {
  const s = sections.value.find(x => x.name === name);
  if (s && s.done < s.total) s.done++;
}

onMounted(async () => {
  startTyping();
  es = subscribeEvents(handleEvent);
  try {
    const current = await api.session();
    if (current.connected) { await onConnected(current.user); return; }
    const saved = localStorage.getItem('xt_console_cookie');
    if (saved) { const result = await api.connect(saved); await onConnected(result.user); }
  } catch (error) { pushLog('fail', '连接失败', null, error.message); }

});
onUnmounted(() => { if (es) es.close(); if (typeTimer) clearTimeout(typeTimer); });
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <div class="brand-title">{{ typed }}<span class="caret">▎</span></div>
    </div>
    <div class="row" style="gap:8px">
      <StatusGrid v-if="advancedOpen"
        :sections="sections" :selected="selected" :loading="loadingStatus" :connected="session.connected"
        @toggle="toggleSelect" @refresh="refreshStatus"
      />
    </div>
  </header>

  <CookiePanel :session="session" @connected="onConnected" @disconnected="onDisconnected" />
  <WorkflowPanel :session="session" />
  <details class="advanced" @toggle="advancedOpen = $event.target.open">
    <summary>高级操作：单独运行视频、图文、讨论、采集或答题</summary>
    <div v-if="advancedOpen">
  <StatBar :stats="stats" :runState="runState" />
  <VideoPanel :session="session" :task="videoState" />
  <ArticlePanel :session="session" :task="articleState" />
  <DiscussionPanel :session="session" :task="discussionState" />
  <AnswerPanel :session="session" :task="answerState" />
  <RunConsole
    :courses="homeworkCourses" :courseUrl="homeworkUrl" :concurrency="homeworkConcurrency"
    @course="value => { homeworkUrl = value; selected = []; refreshStatus(); }" @concurrency="homeworkConcurrency = $event"
    :runState="runState" :logs="logs" :connected="session.connected" :selectedCount="selected.length"
    @start="startRun" @stop="stopRun" @clear="clearLogs"
  />
    </div>
  </details>
</template>

<style scoped>
.advanced > summary { cursor: pointer; margin: 20px 0; color: var(--text-dim); }
.topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.brand { display: flex; align-items: center; }
.brand-title {
  font-size: 26px; font-weight: 800; letter-spacing: 4px;
  display: inline-flex; align-items: center;
  background: linear-gradient(135deg, var(--accent), var(--accent-2), var(--accent-3));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 0 16px rgba(47,124,246,0.3));
}
.caret {
  -webkit-text-fill-color: var(--accent-2); color: var(--accent-2);
  font-weight: 400; margin-left: 2px; animation: blink 1s steps(1) infinite;
}
@keyframes blink { 50% { opacity: 0; } }
</style>
