<script setup>
import { ref, computed, onMounted } from 'vue';
import { request } from '../../api';
const emit = defineEmits(['authenticated']);
const mode = ref('login'), email = ref(''), password = ref(''), busy = ref(false), error = ref(''), message = ref(''), token = ref('');
const titles = { login: '欢迎回来', register: '创建你的账号', forgot: '找回密码', reset: '设置新密码', verify: '验证邮箱' };
const title = computed(() => titles[mode.value]);
const config = ref({emailEnabled:false,emailVerificationRequired:false}), configReady=ref(false);
const send = (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function switchMode(value) { mode.value = value; error.value = ''; message.value = ''; password.value = ''; }
async function submit() {
  busy.value = true; error.value = ''; message.value = '';
  try {
    if (mode.value === 'login') { const result = await send('/api/auth/login', { email: email.value, password: password.value }); password.value = ''; emit('authenticated', result.user); }
    if (mode.value === 'register') { await send('/api/auth/register', { email: email.value, password: password.value }); password.value = ''; if(config.value.emailVerificationRequired){message.value='请检查邮箱，完成验证后登录。';}else{switchMode('login');message.value='注册成功，请使用刚设置的密码登录。';} }
    if (mode.value === 'forgot') { await send('/api/auth/forgot-password', { email: email.value }); message.value = '如果该邮箱已注册，重置链接将发送至邮箱。'; }
    if (mode.value === 'reset') { await send('/api/auth/reset-password', { token: token.value, password: password.value }); switchMode('login'); token.value = ''; message.value = '密码已更新，请重新登录。'; }
    if (mode.value === 'verify') { await send('/api/auth/verify', { token: token.value }); switchMode('login'); token.value = ''; message.value = '邮箱验证成功，现在可以登录。'; }
  } catch (e) { error.value = e.message; } finally { busy.value = false; }
}
async function resend() { busy.value = true; try { await send('/api/auth/resend', { email: email.value }); message.value = '验证邮件已请求，请检查收件箱。'; } catch (e) { error.value = e.message; } finally { busy.value = false; } }
onMounted(async () => { const hash = new URLSearchParams(location.hash.slice(1)); for (const kind of ['verify', 'reset']) if (hash.has(kind)) { token.value = hash.get(kind); mode.value = kind; history.replaceState(null, '', location.pathname + location.search); } try{config.value=await request('/api/auth/config');configReady.value=true;}catch(e){error.value=e.message;} });
</script>
<template>
  <main class="auth-layout">
    <section class="auth-intro"><span class="auth-eyebrow">ICEIU · 学习控制台</span><h1>课程有序推进，<br>进度随时继续。</h1><p>集中管理课程与任务，共享经过验证的标准题库。你的平台账号、作答记录和运行日志只属于你。</p><div class="auth-points"><span>独立账号</span><span>任务恢复</span><span>共享题库</span></div></section>
    <section class="panel auth-card"><h2>{{ title }}</h2><p class="dim">{{ mode === 'register' ? (config.emailVerificationRequired?'验证邮箱后即可连接平台账号。':'注册后即可登录，无需邮箱验证码。') : '登录后继续你的课程任务。' }}</p>
      <form @submit.prevent="submit">
        <label v-if="!['reset','verify'].includes(mode)" for="auth-email">邮箱<input id="auth-email" v-model="email" type="email" autocomplete="email" required></label>
        <label v-if="['login','register','reset'].includes(mode)" for="auth-password">密码<input id="auth-password" v-model="password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" :minlength="mode === 'login' ? 1 : 12" maxlength="256" required><small v-if="mode !== 'login'" class="dim">至少 12 个字符</small></label>
        <button class="primary" :disabled="busy || !configReady">{{ busy ? '处理中…' : mode === 'login' ? '登录' : mode === 'register' ? (config.emailVerificationRequired?'注册并发送验证邮件':'注册账号') : mode === 'verify' ? '确认验证邮箱' : mode === 'forgot' ? '发送重置链接' : '保存新密码' }}</button>
      </form>
      <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="message" class="notice" role="status">{{ message }}</p>
      <div class="auth-links"><button v-if="mode !== 'login'" @click="switchMode('login')">返回登录</button><button v-if="mode === 'login'" @click="switchMode('register')">注册账号</button><button v-if="mode === 'login' && config.emailEnabled" @click="switchMode('forgot')">忘记密码</button><button v-if="email && config.emailEnabled && config.emailVerificationRequired && ['login','register'].includes(mode)" :disabled="busy" @click="resend">重发验证邮件</button></div>
    </section>
  </main>
</template>
<style scoped>
.auth-layout{max-width:1120px;margin:9vh auto;display:grid;grid-template-columns:1.1fr 1fr;gap:64px;padding:24px;align-items:center}.auth-eyebrow{color:var(--accent,#5de8cb);letter-spacing:3px;font-size:13px}.auth-intro h1{font-size:clamp(32px,4vw,52px);line-height:1.35;margin:24px 0}.auth-intro p{max-width:430px;line-height:1.9;color:#9aabc2}.auth-points{display:flex;gap:22px;margin-top:34px;font-size:13px;color:#80d9c4}.auth-card{padding:32px}.auth-card h2{font-size:26px}.auth-card label{display:block;margin:20px 0 8px}.auth-card input{display:block;box-sizing:border-box;width:100%;margin-top:8px;padding:12px;background:#101927;border:1px solid #344356;border-radius:7px;color:inherit}.auth-card form>button{width:100%;margin:24px 0 8px;padding:12px}.auth-links{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.auth-links button{font-size:12px;padding:5px}.error{color:#ff9292}.notice{color:#88ddbd}@media(max-width:720px){.auth-layout{grid-template-columns:1fr;gap:26px;margin:2vh auto}.auth-intro h1{font-size:30px}.auth-points{display:none}.auth-card{padding:22px}}
</style>
