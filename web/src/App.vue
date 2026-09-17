<script setup>
import { ref,onMounted,onUnmounted } from 'vue';
import { request } from './api';
import AuthView from './components/auth/AuthView.vue';
import UserWorkspace from './components/console/UserWorkspace.vue';
import AdminPanel from './components/admin/AdminPanel.vue';
const user=ref(null),loading=ref(true),error=ref('');
function disconnected(){user.value=null;}
function authenticated(value){user.value=value;error.value='';}
async function logout(){try{await request('/api/auth/logout',{method:'POST'});disconnected();}catch(e){error.value=e.message;}}
onMounted(async()=>{localStorage.removeItem('xt_console_cookie');window.addEventListener('auth-required',disconnected);try{const result=await request('/api/auth/me');user.value=result.user;}catch(e){if(e.code!=='AUTH_REQUIRED')error.value=e.message;}finally{loading.value=false;}});
onUnmounted(()=>window.removeEventListener('auth-required',disconnected));
</script>
<template><p v-if="loading" class="loading">正在连接控制台…</p><AuthView v-else-if="!user" @authenticated="authenticated"/><AdminPanel v-else-if="user.admin" :user="user" @logout="logout"/><UserWorkspace v-else :user="user" @logout="logout"/><p v-if="error" class="global-error" role="alert">{{error}}</p></template>
<style scoped>.global-error{color:var(--text-error);text-align:center}.loading{text-align:center;margin:20vh auto}</style>
