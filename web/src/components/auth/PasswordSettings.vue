<script setup>
import {ref} from 'vue';
import {request} from '../../api';
const currentPassword=ref(''), password=ref(''), error=ref(''), busy=ref(false);
async function save(){busy.value=true;error.value='';try{await request('/api/auth/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:currentPassword.value,password:password.value})});currentPassword.value='';password.value='';window.dispatchEvent(new Event('auth-required'));}catch(e){error.value=e.message;}finally{busy.value=false;}}
</script>
<template><section class="panel"><h2>修改密码</h2><p class="dim">保存后所有设备和 CLI 令牌将退出，请使用新密码重新登录。</p><form @submit.prevent="save"><label>当前密码<input v-model="currentPassword" type="password" autocomplete="current-password" required></label><label>新密码<input v-model="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><button class="primary" :disabled="busy">保存并重新登录</button></form><p v-if="error" role="alert">{{error}}</p></section></template>
<style scoped>label{display:block;margin:14px 0}input{display:block;box-sizing:border-box;width:100%;max-width:420px;margin:8px 0}</style>
