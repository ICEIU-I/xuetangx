<script setup>
import { ref } from 'vue';
import AdminOverview from './AdminOverview.vue';
import CollectorAccounts from './CollectorAccounts.vue';
import UserManagement from './UserManagement.vue';
import PasswordSettings from '../auth/PasswordSettings.vue';
defineProps({user:Object});defineEmits(['logout']);
const tab=ref('overview');
const pages={overview:{title:'管理概览',description:'查看用户、共享题库与采集账号的运行状态。',icon:'◫'},collectors:{title:'答案采集账号',description:'统一维护获取标准答案的账号，供全站缺少答案的课程使用。',icon:'▤'},users:{title:'用户管理',description:'管理网站账号、登录权限与用户数据。',icon:'◎'},settings:{title:'账号设置',description:'管理你的管理员登录密码。',icon:'⚙'}};
</script>
<template><div class="admin-workspace"><aside class="admin-sidebar"><a class="brand" href="/">ICEIU <span>管理中心</span></a><p class="workspace-label">平台管理</p><nav aria-label="管理员导航"><button v-for="(page,key) in pages" :key="key" :class="{selected:tab===key}" @click="tab=key"><span>{{page.icon}}</span>{{page.title}}</button></nav><div class="admin-identity"><span class="admin-badge">管理员</span><p>{{user.email}}</p><button @click="$emit('logout')">退出登录</button></div></aside><main class="admin-main"><header class="admin-header"><p class="workspace-label">ICEIU / {{pages[tab].title}}</p><h1>{{pages[tab].title}}</h1><p class="dim">{{pages[tab].description}}</p></header><AdminOverview v-if="tab==='overview'" @navigate="tab=$event"/><CollectorAccounts v-else-if="tab==='collectors'"/><UserManagement v-else-if="tab==='users'"/><PasswordSettings v-else/></main></div></template>
<style src="./admin.css"></style>
