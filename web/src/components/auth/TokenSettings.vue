<script setup>
import { ref, onMounted } from 'vue';
import { request } from '../../api';
const tokens = ref([]), name = ref(''), created = ref(''), error = ref('');
async function load() { try { tokens.value = (await request('/api/tokens')).tokens; } catch(e) { error.value=e.message; } }
async function create() { try { created.value=(await request('/api/tokens',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.value})})).token;name.value='';await load(); } catch(e){error.value=e.message;} }
async function revoke(id) { try { await request(`/api/tokens/${id}`,{method:'DELETE'}); await load(); } catch(e){error.value=e.message;} }
onMounted(load);
</script>
<template><section class="panel"><h2>个人访问令牌</h2><p class="dim">用于命令行访问你的任务，有效期 90 天，可以随时撤销。</p><form class="row" @submit.prevent="create"><label>令牌名称 <input v-model="name" maxlength="100" placeholder="例如：我的电脑" required></label><button class="primary">创建令牌</button></form><div v-if="created" class="notice"><p>令牌仅显示一次，请妥善保存。</p><textarea readonly :value="created" rows="2" aria-label="新访问令牌"></textarea><button @click="created=''">已保存，关闭显示</button></div><p v-if="error" role="alert">{{error}}</p><ul><li v-for="t in tokens" :key="t.id">{{t.name || '未命名'}} · {{new Date(t.expiresAt).toLocaleDateString()}} 到期 <button @click="revoke(t.id)">撤销</button></li></ul></section></template>
