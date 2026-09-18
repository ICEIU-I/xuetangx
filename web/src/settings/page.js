import { escape as e, feedback, lifetime } from '../shared/dom.js';
import { mountConnect } from '../learning/connect.js';
import { mountPassword } from './password.js';
export function mountSettings(host, workspace) {
  const life = lifetime(); let identity, disposeConnect = () => {};
  host.innerHTML = '<header class="page-heading"><h1>账号设置</h1></header><div class="settings-stack"><div class="platform-settings"></div><div class="password-settings"></div></div>';
  const platform = host.querySelector('.platform-settings');
  function draw() {
    const session = workspace.state.session, next = `${session.connected}:${session.user?.user_id}:${session.user?.name}`; if (identity === next) return; identity = next; disposeConnect();
    if (!session.connected) { disposeConnect = mountConnect(platform,workspace); return; }
    platform.innerHTML = `<section class="surface"><header class="section-heading"><h2>学堂在线账号</h2><span class="status-pill done">已连接</span></header><div class="connected-account"><div><strong>${e(session.user?.name || '学堂在线账号')}</strong><p class="muted">${e(session.user?.user_id)}</p></div><button class="danger text-button">断开连接</button></div><p class="muted">切换账号请先断开连接，当前任务将等待原账号重新连接。</p><div class="connection-error"></div></section>`;
    platform.querySelector('button').onclick = async event => { event.target.disabled = true; try { await workspace.disconnect(); } catch (err) { if (life.alive) { platform.querySelector('.connection-error').innerHTML = feedback(err.message); event.target.disabled = false; } } };
  }
  life.add(mountPassword(host.querySelector('.password-settings'))); life.add(workspace.subscribe(draw)); life.add(() => disposeConnect()); draw(); return life.dispose;
}
