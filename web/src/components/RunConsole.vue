<script setup>
import { ref, computed, watch, nextTick } from 'vue';

const props = defineProps({
  runState: Object,   // {status,total,done,correct,failed,ratePerMin,etaSec,rateLimited}
  logs: Array,        // [{ts,mark,name,problemId,msg}]
  connected: Boolean,
  selectedCount: Number,
});
const emit = defineEmits(['start', 'stop', 'clear']);

const logBox = ref(null);
const running = computed(() => props.runState.status === 'running');
const pct = computed(() => props.runState.total ? Math.round(props.runState.done / props.runState.total * 100) : 0);

function fmtEta(sec) {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}
function markIcon(m) { return m === 'ok' ? '✓' : m === 'wrong' ? '⚠' : m === 'fail' ? '✗' : '·'; }

// 日志自动滚到底
watch(() => props.logs.length, async () => {
  await nextTick();
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
});
</script>

<template>
  <div class="panel">
    <div class="panel-title">运行控制台 / RUN CONSOLE</div>

    <!-- 进度条 -->
    <div class="prog-head row">
      <span class="mono-num accent">{{ runState.done || 0 }}</span>
      <span class="dim">/ {{ runState.total || 0 }} 题</span>
      <span class="dim">·</span>
      <span class="mono-num">{{ pct }}%</span>
      <span class="spacer"></span>
      <span v-if="running" class="dim">预计剩余 <span class="accent">{{ fmtEta(runState.etaSec) }}</span></span>
      <span v-if="runState.failed" class="tag err" style="margin-left:8px"><span class="dot"></span>失败 {{ runState.failed }}</span>
    </div>
    <div class="prog"><div class="prog-fill" :style="{ width: pct + '%' }"></div></div>

    <!-- 控制按钮 -->
    <div class="row" style="margin:12px 0">
      <button class="primary" :disabled="!connected || running" @click="emit('start')">
        ▶ 开始{{ selectedCount ? `（选中 ${selectedCount} 套）` : '（全部未完成）' }}
      </button>
      <button class="danger" :disabled="!running" @click="emit('stop')">■ 停止</button>
      <button :disabled="running" @click="emit('clear')">清空日志</button>
    </div>

    <!-- 实时日志 -->
    <div class="logbox" ref="logBox">
      <div v-if="!logs.length" class="dim" style="padding:8px">等待运行…</div>
      <div v-for="(l, i) in logs" :key="i" class="logline" :class="l.mark">
        <span class="lt">{{ l.ts }}</span>
        <span class="lm">{{ markIcon(l.mark) }}</span>
        <span class="ln">{{ l.name }}</span>
        <span class="lp dim">{{ l.problemId ? '题' + l.problemId : '' }}</span>
        <span v-if="l.msg" class="lmsg">{{ l.msg }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prog-head { font-size: 12px; margin-bottom: 6px; }
.prog { height: 8px; background: rgba(230,235,242,0.8); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; position: relative; }
.prog-fill {
  height: 100%; border-radius: 999px; transition: width .4s ease;
  background: linear-gradient(90deg, var(--accent-3), var(--accent-2), var(--accent));
  background-size: 200% 100%;
  box-shadow: 0 0 12px rgba(11,179,168,0.5);
  animation: flow 2s linear infinite;
  position: relative;
}
/* 流光：进度条上掠过的高光 */
.prog-fill::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent);
  transform: translateX(-100%);
  animation: shimmer 1.6s ease-in-out infinite;
}
@keyframes flow { to { background-position: 200% 0; } }
@keyframes shimmer { 0% { transform: translateX(-100%); } 60%,100% { transform: translateX(220%); } }
.rl-note { color: var(--warn); font-size: 11px; margin-top: 6px; }

.logbox {
  height: 320px; overflow-y: auto;
  background: linear-gradient(180deg, rgba(248,250,253,0.9), rgba(242,246,251,0.7));
  border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
  font-size: 11.5px;
  box-shadow: inset 0 2px 8px rgba(40,60,90,0.05);
}
.logline { display: flex; gap: 8px; padding: 2px 0; white-space: nowrap; animation: logIn .25s ease; }
@keyframes logIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }
.lt { color: #9aa6b6; }
.lm { width: 12px; text-align: center; }
.logline.ok .lm { color: var(--ok); }
.logline.wrong .lm { color: var(--warn); }
.logline.fail .lm { color: var(--err); }
.ln { color: var(--text); }
.lmsg { color: var(--err); }
.logbox::-webkit-scrollbar { width: 8px; }
.logbox::-webkit-scrollbar-thumb { background: var(--border-bright); border-radius: 4px; }
</style>
