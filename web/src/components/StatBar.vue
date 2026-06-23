<script setup>
defineProps({ stats: Object, runState: Object });
</script>

<template>
  <div class="panel statbar">
    <div class="cell">
      <div class="label">总题数</div>
      <div class="big-num mono-num">{{ stats.totalQ ?? '—' }}</div>
    </div>
    <div class="cell">
      <div class="label">已完成</div>
      <div class="big-num mono-num accent">{{ stats.doneQ ?? '—' }}</div>
    </div>
    <div class="cell">
      <div class="label">判对</div>
      <div class="big-num mono-num" style="color:var(--ok)">{{ stats.rightQ ?? '—' }}</div>
    </div>
    <div class="cell">
      <div class="label">实时速率</div>
      <div class="big-num mono-num">{{ runState.ratePerMin || 0 }}<span class="dim" style="font-size:11px"> /min</span></div>
    </div>
    <div class="cell status-cell">
      <div class="label">状态</div>
      <span v-if="runState.status === 'running'" class="tag run"><span class="dot"></span>RUNNING</span>
      <span v-else-if="runState.status === 'done'" class="tag ok"><span class="dot"></span>NOMINAL</span>
      <span v-else class="tag"><span class="dot"></span>STANDBY</span>
    </div>
  </div>
</template>

<style scoped>
.statbar { display: flex; gap: 28px; align-items: center; }
.cell { display: flex; flex-direction: column; gap: 4px; }
.label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-dim); }
.status-cell { margin-left: auto; }
</style>
