<script setup>
import { ref,onMounted,onUnmounted } from 'vue';
import { request } from './api';
import AuthView from './components/auth/AuthView.vue';
import TokenSettings from './components/auth/TokenSettings.vue';
import PasswordSettings from './components/auth/PasswordSettings.vue';
import ConsoleView from './components/console/ConsoleView.vue';
import TaskHistory from './components/workflow/TaskHistory.vue';
import AdminPanel from './components/admin/AdminPanel.vue';
const user=ref(null),loading=ref(true),tab=ref('console'),error=ref('');
function disconnected(){user.value=null;tab.value='console';}
function authenticated(value){user.value=value;error.value='';tab.value='console';}
async function logout(){try{await request('/api/auth/logout',{method:'POST'});disconnected();}catch(e){error.value=e.message;}}
onMounted(async()=>{localStorage.removeItem('xt_console_cookie');window.addEventListener('auth-required',disconnected);try{const result=await request('/api/auth/me');user.value=result.user;}catch(e){if(e.code!=='AUTH_REQUIRED')error.value=e.message;}finally{loading.value=false;}});
onUnmounted(()=>window.removeEventListener('auth-required',disconnected));
</script>
<template><p v-if="loading" class="loading">正在连接控制台…</p><AuthView v-else-if="!user" @authenticated="authenticated"/><template v-else><header class="account-nav"><strong>ICEIU</strong><nav aria-label="主导航"><button :class="{active:tab==='console'}" @click="tab='console'">控制台</button><button :class="{active:tab==='history'}" @click="tab='history'">任务记录</button><button :class="{active:tab==='settings'}" @click="tab='settings'">账号设置</button><button v-if="user.admin" :class="{active:tab==='admin'}" @click="tab='admin'">管理</button></nav><span class="account-email">{{user.email}}</span><button @click="logout">退出</button></header><ConsoleView v-if="tab==='console'" :key="user.id"/><main v-else class="account-content"><TaskHistory v-if="tab==='history'"/><template v-if="tab==='settings'"><PasswordSettings/><TokenSettings/></template><AdminPanel v-if="tab==='admin'&&user.admin"/></main></template><p v-if="error" class="global-error" role="alert">{{error}}</p></template>
<style scoped>.account-nav{display:flex;align-items:center;gap:16px;max-width:1400px;margin:0 auto;padding:16px 24px;border-bottom:1px solid #29384b;flex-wrap:wrap}.account-nav strong{letter-spacing:3px;color:#75e4cb}.account-nav nav{display:flex;gap:8px}.account-nav button.active{color:#75e4cb;border-color:#75e4cb}.account-email{margin-left:auto;max-width:260px;overflow:hidden;text-overflow:ellipsis}.account-content{max-width:1100px;margin:32px auto;padding:0 20px}.global-error{color:#ff9797;text-align:center}.loading{text-align:center;margin:20vh auto}@media(max-width:600px){.account-nav{padding:12px;gap:8px}.account-nav nav{order:3;width:100%;overflow-x:auto}.account-email{font-size:12px;max-width:170px}.account-nav button{font-size:12px}}</style>
