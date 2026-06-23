<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  sections: Array,      // [{name,total,done,right,err}]
  selected: Array,      // 选中要跑的作业名
  loading: Boolean,
  connected: Boolean,
});
const emit = defineEmits(['toggle', 'refresh']);

const open = ref(false);

const summary = computed(() => {
  const done = props.sections.filter(s => s.total > 0 && s.done >= s.total).length;
  return { done, total: props.sections.length };
});

function cls(s) {
  if (s.err) return 'err';
  if (s.total > 0 && s.done >= s.total) return 'done';
  if (s.done > 0) return 'partial';
  return 'todo';
}
function openModal() {
  open.value = true;
  if (props.connected && !props.sections.length) emit('refresh');
}
</script>

<template>
  <!-- 触发按钮（醒目） -->
  <button class="status-btn" :disabled="!connected" @click="openModal">
    <span class="ic">▤</span>
    <span>作业状态板</span>
    <span v-if="sections.length" class="badge">{{ summary.done }}/{{ summary.total }}</span>
  </button>

  <!-- 模态框 -->
  <teleport to="body">
    <div v-if="open" class="overlay" @click.self="open = false">
      <div class="modal">
        <div class="modal-head">
          <div class="panel-title" style="margin:0">作业状态板 / SECTIONS</div>
          <div class="row" style="gap:8px">
            <button :disabled="!connected || loading" @click="emit('refresh')">⟳ {{ loading ? '扫描中…' : '刷新' }}</button>
            <button @click="open = false">✕ 关闭</button>
          </div>
        </div>
        <div class="hint dim">点击作业卡片选中要跑的项；不选则跑全部未完成。</div>

        <div v-if="loading && !sections.length" class="dim" style="padding:20px">扫描中…</div>
        <div v-else-if="!sections.length" class="dim" style="padding:20px">无数据，点「刷新」加载</div>
        <div v-else class="grid">
          <div
            v-for="s in sections" :key="s.name"
            class="card" :class="[cls(s), { sel: selected.includes(s.name) }]"
            @click="emit('toggle', s.name)"
          >
            <div class="name">{{ s.name }}</div>
            <div class="meta">
              <span class="mono-num">{{ s.done }}/{{ s.total }}</span>
              <span v-if="s.err" class="dim">{{ s.err }}</span>
            </div>
            <div class="bar"><div class="fill" :style="{ width: (s.total ? s.done / s.total * 100 : 0) + '%' }"></div></div>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
/* 醒目的状态板触发按钮 */
.status-btn {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 600; letter-spacing: 0.5px;
  padding: 10px 18px; border-radius: 10px;
  color: #fff; border: none; cursor: pointer;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 4px 18px rgba(47,124,246,0.35);
  transition: transform .18s, box-shadow .18s, filter .18s;
}
.status-btn:hover:not(:disabled) {
  transform: translateY(-2px); filter: brightness(1.06);
  box-shadow: 0 6px 26px rgba(47,124,246,0.5);
}
.status-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
.status-btn .ic { font-size: 15px; }
.status-btn .badge {
  font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px;
  background: rgba(255,255,255,0.25); color: #fff;
  font-variant-numeric: tabular-nums;
}
.overlay {
  position: fixed; inset: 0; background: rgba(20,30,45,0.35);
  display: flex; align-items: center; justify-content: center; z-index: 100;
  backdrop-filter: blur(2px);
}
.modal {
  width: min(900px, 92vw); max-height: 82vh; overflow: auto;
  background: var(--bg-panel); border: 1px solid var(--border-bright);
  border-radius: 10px; padding: 18px 20px; box-shadow: 0 20px 60px rgba(30,45,70,0.25);
}
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.hint { font-size: 11px; margin-bottom: 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.card {
  border: 1px solid var(--border); border-radius: 6px; padding: 9px 10px;
  cursor: pointer; transition: all .12s; background: var(--bg-panel-2);
}
.card:hover { border-color: var(--border-bright); }
.card.sel { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(14,165,163,.3) inset; }
.name { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-dim); margin: 5px 0 6px; }
.bar { height: 3px; background: #e7ebf2; border-radius: 2px; overflow: hidden; }
.fill { height: 100%; transition: width .3s; }
.card.done .fill { background: var(--ok); }
.card.done .meta .mono-num { color: var(--ok); }
.card.partial .fill { background: var(--accent); }
.card.todo .fill { background: #c2ccda; }
.card.err { border-color: rgba(226,59,78,.3); }
.card.err .fill { background: var(--err); }
</style>
