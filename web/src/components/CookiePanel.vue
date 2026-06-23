<script setup>
import { ref } from 'vue';
import { api } from '../api';

const props = defineProps({ session: Object });
const emit = defineEmits(['connected', 'disconnected']);

const LS_KEY = 'xt_console_cookie';
const cookie = ref(localStorage.getItem(LS_KEY) || '');  // 回填记住的 cookie
const busy = ref(false);
const err = ref('');

async function connect() {
  err.value = '';
  busy.value = true;
  try {
    const r = await api.connect(cookie.value);
    localStorage.setItem(LS_KEY, cookie.value.trim()); // 默认记住
    emit('connected', r.user);
  } catch (e) {
    err.value = e.message;
    // cookie 失效则清掉记忆，避免下次自动用坏的
    if (/无效|过期|csrftoken/.test(e.message)) localStorage.removeItem(LS_KEY);
  } finally { busy.value = false; }
}
async function disconnect() {
  await api.disconnect();
  localStorage.removeItem(LS_KEY);   // 断开即忘记
  cookie.value = '';
  emit('disconnected');
}
</script>

<template>
  <div class="panel">
    <div class="panel-title">登录态 / SESSION</div>

    <div v-if="session.connected" class="row">
      <span class="tag ok"><span class="dot"></span>CONNECTED</span>
      <span class="dim">user_id</span>
      <span class="accent mono-num">{{ session.user?.user_id || session.user?.id }}</span>
      <span v-if="session.user?.school_number" class="dim">学号 {{ session.user.school_number }}</span>
      <span class="tag" style="margin-left:4px">已记住于本浏览器</span>
      <span class="spacer"></span>
      <button class="danger" @click="disconnect">断开并忘记</button>
    </div>

    <div v-else>
      <textarea
        v-model="cookie" rows="3"
        placeholder="粘贴浏览器 cookie（须含 sessionid 和 csrftoken）&#10;形如：sessionid=xxx; csrftoken=yyy; login_type=E; ..."
      ></textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" :disabled="busy || !cookie.trim()" @click="connect">
          {{ busy ? '校验中…' : '连接' }}
        </button>
        <span v-if="err" class="tag err"><span class="dot"></span>{{ err }}</span>
      </div>
    </div>
  </div>
</template>
