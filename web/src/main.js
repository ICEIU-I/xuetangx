import './styles/user.css';
import { request } from './api.js';
import { mountLogin } from './auth/login.js';
import { mountWorkspace } from './workspace/shell.js';
const host = document.querySelector('#app');
let dispose = () => {}, initializing = true;
function show(user) {
  dispose(); host.innerHTML = ''; document.body.className = 'pixel-theme';
  dispose = user ? mountWorkspace(host,user,logout) : mountLogin(host,show);
}
async function logout() { try { await request('/api/auth/logout',{method:'POST'}); show(null); } catch (error) { const message = document.createElement('p'); message.className = 'feedback error'; message.setAttribute('role','alert'); message.textContent = error.message; host.querySelector('main')?.prepend(message); } }
try { localStorage.removeItem('xt_console_cookie'); } catch {}
window.addEventListener('auth-required',() => { if (!initializing) show(null); });
host.innerHTML = '<p class="loading-state">正在连接…</p>';
request('/api/auth/me').then(result => show(result.user)).catch(() => show(null)).finally(() => { initializing = false; });
