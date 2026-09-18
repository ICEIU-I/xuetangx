<script setup>
import { reactive, ref, onUnmounted } from 'vue';
import { api } from '../api';

const props = defineProps({ session: Object });
const emit = defineEmits(['connected', 'disconnected']);

const cookie = ref('');
const busy = ref(false);
const err = ref('');
const wx = reactive({ id: '', status: 'idle', qrUrl: '', expiresAt: '', message: '' });
let wxTimer = null;
const wxActive = () => ['starting', 'waiting_scan'].includes(wx.status);
const wxReset = () => { if (wxTimer) { clearInterval(wxTimer); wxTimer = null; } Object.assign(wx, { id: '', status: 'idle', qrUrl: '', expiresAt: '', message: '' }); };
function wxApply(value) {
  Object.assign(wx, value);
  if (value.status === 'connected') {
    const user = value.account?.user;
    wxReset();
    emit('connected', user);
  } else if (['expired', 'error', 'cancelled'].includes(value.status) && wxTimer) {
    clearInterval(wxTimer); wxTimer = null;
  }
}
function pollWechat() {
  if (wxTimer) clearInterval(wxTimer);
  wxTimer = setInterval(async () => {
    if (!wx.id) return;
    try { wxApply(await api.wechatStatus(wx.id)); } catch (e) { err.value = e.message; clearInterval(wxTimer); wxTimer = null; }
  }, 1000);
}
async function startWechat() {
  err.value = ''; busy.value = true;
  try { wxApply(await api.wechatStart('primary')); if (wx.id) pollWechat(); }
  catch (e) { err.value = e.message; }
  finally { busy.value = false; }
}
async function cancelWechat() {
  if (!wx.id) return;
  busy.value = true;
  try { await api.wechatCancel(wx.id); wxReset(); }
  catch (e) { err.value = e.message; }
  finally { busy.value = false; }
}

async function connect() {
  err.value = '';
  busy.value = true;
  try {
    const r = await api.connect(cookie.value);
    cookie.value = '';
    emit('connected', r.user);
  } catch (e) {
    err.value = e.message;
  } finally { busy.value = false; }
}
async function disconnect() {
  await api.disconnect();
  cookie.value = '';
  emit('disconnected');
}
onUnmounted(() => { if (wxTimer) clearInterval(wxTimer); });
</script>

<template>
  <div class="panel">
    <div class="panel-title">正式账号 / PRIMARY</div>

    <div v-if="session.connected" class="row">
      <span class="tag ok"><span class="dot"></span>CONNECTED</span>
      <span class="dim">user_id</span>
      <span class="accent mono-num">{{ session.user?.user_id || session.user?.id }}</span>
      <span v-if="session.user?.school_number" class="dim">学号 {{ session.user.school_number }}</span>
      <span class="tag" style="margin-left:4px">当前正式账号</span>
      <span class="spacer"></span>
      <button class="danger" @click="disconnect">断开并忘记</button>
    </div>

    <div v-else>
      <div class="wechat-login">
        <div class="login-method-heading">
          <div class="row" style="gap:8px;align-items:center">
            <strong>微信扫码登录</strong>
            <span class="tag recommended">推荐</span>
          </div>
          <div class="dim">使用微信扫一扫登录学堂在线，登录成功后会自动安全保存平台登录状态。</div>
        </div>
        <button class="primary" :disabled="busy || wxActive()" @click="startWechat">{{ wxActive() ? '等待微信扫码…' : '生成微信登录二维码' }}</button>
        <div v-if="wx.id" class="wechat-state" aria-live="polite">
          <img v-if="wx.qrUrl" :src="wx.qrUrl" alt="学堂在线微信登录二维码" />
          <span v-if="wx.status === 'starting'" class="dim">正在生成二维码…</span>
          <span v-else-if="wx.status === 'waiting_scan'" class="dim">请用微信扫一扫，二维码有效期约 60 秒。</span>
          <span v-else-if="wx.status === 'error' || wx.status === 'expired'" class="tag err">{{ wx.message }}</span>
          <button v-if="wxActive()" @click="cancelWechat">取消</button>
        </div>
      </div>
      <details class="cookie-fallback">
        <summary>备用方式：粘贴学堂在线 Cookie</summary>
        <div class="cookie-fallback-body">
          <div class="dim">仅在微信扫码不可用时使用。Cookie 只会提交到当前服务端校验，不会保存到浏览器。</div>
          <textarea
            v-model="cookie" rows="3"
            placeholder="须含 sessionid 和 csrftoken，例如：sessionid=xxx; csrftoken=yyy; login_type=E; ..."
          ></textarea>
          <div class="row">
            <button :disabled="busy || !cookie.trim()" @click="connect">
              {{ busy ? '校验中…' : '使用 Cookie 连接' }}
            </button>
          </div>
        </div>
      </details>
      <div v-if="err" class="tag err login-error"><span class="dot"></span>{{ err }}</div>
    </div>
  </div>
</template>
<style scoped>
.wechat-login { padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-panel-2); display: grid; gap: 10px; }
.login-method-heading { display: grid; gap: 5px; }
.recommended { color: var(--text-accent); border-color: var(--text-accent); }
.wechat-login button { width: fit-content; }
.wechat-state { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.wechat-state img { width: 180px; height: 180px; object-fit: contain; border: 1px solid var(--border); border-radius: 8px; background: white; }
.cookie-fallback { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 14px; }
.cookie-fallback summary { cursor: pointer; color: var(--text-dim); }
.cookie-fallback-body { display: grid; gap: 8px; margin-top: 10px; }
.cookie-fallback-body textarea { margin: 0; }
.login-error { display: inline-flex; margin-top: 10px; }
</style>
