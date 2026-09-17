<script setup>
import { ref, onMounted } from 'vue';
import { request } from '../../api';
const users=ref([]), metrics=ref({}), conflicts=ref([]), jobs=ref([]), offset=ref(0), jobOffset=ref(0), error=ref(''), busy=ref(false);
const metricLabels={ready:'调度器就绪',queuedJobs:'排队课程',runningJobs:'运行课程',pendingOperations:'待核对操作',failedMail:'失败邮件',workerRestarts:'进程恢复次数'};
async function load(delta=0){
  offset.value=Math.max(0,offset.value+delta);error.value='';
  try{
    const [u,m,c]=await Promise.all([request(`/api/admin/users?limit=20&offset=${offset.value}`),request('/api/admin/metrics'),request('/api/admin/conflicts?limit=50')]);
    users.value=u.users;metrics.value=m;conflicts.value=c.conflicts;
    await loadJobs();
  }catch(e){error.value=e.message;}
}
async function loadJobs(delta=0){jobOffset.value=Math.max(0,jobOffset.value+delta);try{jobs.value=(await request(`/api/admin/jobs?limit=20&offset=${jobOffset.value}`)).jobs;}catch(e){error.value=e.message;}}
async function action(path,body){busy.value=true;error.value='';try{await request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await load();}catch(e){error.value=e.message;}finally{busy.value=false;}}
onMounted(()=>load());
</script>
<template>
  <section class="panel">
    <div class="row"><h2>管理员后台</h2><button @click="load()">刷新</button></div>
    <p v-if="error" role="alert" class="error">{{error}}</p>
    <div class="metric-grid"><div v-for="(value,key) in metrics" :key="key" class="metric"><span>{{metricLabels[key]||key}}</span><strong>{{typeof value==='boolean'?(value?'正常':'不可用'):value}}</strong></div></div>
    <h3>用户管理</h3>
    <p class="dim">禁用会撤销登录会话、撤销 CLI 令牌并停止该用户的任务。</p>
    <div v-for="u in users" :key="u.id" class="admin-row"><span>{{u.email}}<small>{{u.admin?'管理员':'普通用户'}} · {{u.disabled?'已禁用':u.verified?'正常':'待启用'}}</small></span><button :disabled="busy" @click="action(`/api/admin/users/${u.id}/disable`,{disabled:!u.disabled})">{{u.disabled?'启用':'禁用'}}</button></div>
    <div class="row pager"><button :disabled="offset===0" @click="load(-20)">上一页用户</button><button :disabled="users.length<20" @click="load(20)">下一页用户</button></div>
    <h3>全站任务</h3><p v-if="!jobs.length" class="dim">暂无任务</p>
    <div v-for="j in jobs" :key="j.id" class="admin-row"><span>{{j.title}}<small>{{j.email}} · {{j.status}}</small></span><button v-if="!['done','stopped'].includes(j.status)" :disabled="busy" @click="action(`/api/admin/jobs/${j.id}/stop`,{})">停止任务</button></div>
    <div class="row pager"><button :disabled="jobOffset===0" @click="loadJobs(-20)">上一页任务</button><button :disabled="jobs.length<20" @click="loadJobs(20)">下一页任务</button></div>
    <h3>题库冲突</h3><p class="dim">存在冲突的标准答案已阻止自动使用。</p><p v-if="!conflicts.length">暂无冲突</p><p v-for="c in conflicts" :key="c.id">课程 {{c.classroomId}} · 题目 {{c.problemId}}</p>
  </section>
</template>
<style scoped>
.admin-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;overflow-wrap:anywhere;border-bottom:1px solid var(--border)}.admin-row span{min-width:0}.admin-row small{display:block;color:var(--text-dim);margin-top:6px}.row{flex-wrap:wrap}.pager{margin:14px 0 28px}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:24px 0}.metric{border:1px solid var(--border);border-radius:8px;padding:16px}.metric span{font-size:12px;color:var(--text-dim)}.metric strong{display:block;font-size:24px;margin-top:10px}.error{color:var(--text-error)}
</style>
