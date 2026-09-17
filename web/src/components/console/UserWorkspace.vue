<script setup>
import { ref } from 'vue';
import TokenSettings from '../auth/TokenSettings.vue';
import PasswordSettings from '../auth/PasswordSettings.vue';
import ConsoleView from './ConsoleView.vue';
import TaskHistory from '../workflow/TaskHistory.vue';
defineProps({user:Object});defineEmits(['logout']);const tab=ref('console');
</script>
<template><header class="account-nav"><strong>ICEIU</strong><nav aria-label="主导航"><button :class="{active:tab==='console'}" @click="tab='console'">控制台</button><button :class="{active:tab==='history'}" @click="tab='history'">任务记录</button><button :class="{active:tab==='settings'}" @click="tab='settings'">账号设置</button></nav><span class="account-email">{{user.email}}</span><button @click="$emit('logout')">退出</button></header><ConsoleView v-if="tab==='console'" :key="user.id"/><main v-else class="account-content"><TaskHistory v-if="tab==='history'"/><template v-if="tab==='settings'"><PasswordSettings/><TokenSettings/></template></main></template>
<style scoped>.account-nav{display:flex;align-items:center;gap:16px;max-width:1400px;margin:0 auto;padding:16px 24px;border-bottom:1px solid var(--border);flex-wrap:wrap}.account-nav strong{letter-spacing:3px;color:var(--text-accent)}.account-nav nav{display:flex;gap:8px}.account-nav button.active{color:var(--text-accent);border-color:var(--text-accent)}.account-email{margin-left:auto;max-width:260px;overflow:hidden;text-overflow:ellipsis}.account-content{max-width:1100px;margin:32px auto;padding:0 20px}.global-error{color:var(--text-error);text-align:center}.loading{text-align:center;margin:20vh auto}@media(max-width:600px){.account-nav{padding:12px;gap:8px}.account-nav nav{order:3;width:100%;overflow-x:auto}.account-email{font-size:12px;max-width:170px}.account-nav button{font-size:12px}}</style>
