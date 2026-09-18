import { api } from '../api.js';
import { loginState } from '../features/workspace/presentation.js';
import { escape as e, field, feedback, disabled, render, delegate, lifetime } from '../shared/dom.js';
export function mountConnect(host, workspace) {
  const life = lifetime(); let wx = { status: 'idle' }, busy = false, error = '', generation = 0, timer, pollTimer;
  const status = () => loginState(wx);
  const active = () => ['starting', 'waiting_scan'].includes(status());
  function caption() {
    const seconds = Math.max(0, Math.ceil((new Date(wx.expiresAt) - Date.now()) / 1000));
    return status() === 'waiting_scan' ? `等待微信确认 · ${seconds} 秒后过期` : status() === 'expired' ? '二维码已过期' : status() === 'starting' ? '正在生成二维码…' : status() === 'error' ? '二维码加载失败' : '使用微信扫一扫';
  }
  function draw() {
    if (!life.alive) return;
    const current = status();
    render(host, `<section class="surface connect-surface"><div class="connect-copy"><span class="section-index">01</span><h2>连接学堂在线</h2><p class="muted">使用微信扫码登录学堂在线。</p><p class="mobile-scan-note muted">可用另一台设备的微信扫描二维码。</p></div><div class="qr-section"><div class="qr-box">${wx.qrUrl && current !== 'expired' && /^https:\/\//.test(wx.qrUrl) ? `<img src="${e(wx.qrUrl)}" alt="学堂在线微信登录二维码">` : '<span class="qr-symbol" aria-hidden="true">▦</span>'}</div><p class="qr-caption" role="status">${caption()}</p><button id="qr-start" class="primary"${disabled(busy || active())}>${active() ? '等待扫码确认' : ['expired','error'].includes(current) ? '重新生成二维码' : '生成登录二维码'}</button></div><div class="connect-error">${feedback(error || wx.message)}</div><details class="cookie-alternative" data-key="cookie"><summary>Cookie 备用登录</summary><form id="cookie-form"><label for="platform-cookie">学堂在线 Cookie</label><textarea id="platform-cookie" name="cookie" rows="3" autocomplete="off" spellcheck="false" required></textarea><button${disabled(busy)}>使用 Cookie 连接</button></form></details></section>`);
  }
  async function apply(value, token) {
    if (!life.alive || token !== generation) return;
    wx = value; draw();
    if (value.status === 'connected') { clearTimeout(pollTimer); clearInterval(timer); await workspace.connected(value.account); }
    else if (active()) pollTimer = setTimeout(() => poll(token), 1000);
  }
  async function poll(token) {
    if (!life.alive || token !== generation || !active()) return;
    try { await apply(await api.wechatStatus(wx.id), token); }
    catch (err) { if (life.alive && token === generation) { wx.status = 'error'; error = err.message; draw(); } }
  }
  life.add(delegate(host, 'click', '#qr-start', async () => {
    if (busy || active()) return; busy = true; error = ''; const token = ++generation;
    clearTimeout(pollTimer); clearInterval(timer); wx = { status: 'starting' }; draw();
    timer = setInterval(() => { if (status() === 'expired' && host.querySelector('#qr-start')?.disabled) draw(); else { const label = host.querySelector('.qr-caption'); if (label) label.textContent = caption(); } }, 1000);
    try { const value = await api.wechatStart(); if (!life.alive || token !== generation) { if (value.id) api.wechatCancel(value.id).catch(() => {}); return; } await apply(value, token); }
    catch (err) { if (life.alive && token === generation) { wx.status = 'error'; error = err.message; } }
    finally { if (life.alive && token === generation) { busy = false; draw(); } }
  }));
  life.add(delegate(host, 'submit', '#cookie-form', async (event, form) => {
    event.preventDefault(); if (busy) return; const cookie = field(form, 'cookie').trim(); if (!cookie) return;
    busy = true; error = ''; generation++; clearTimeout(pollTimer); clearInterval(timer); const id = wx.id; wx = { status: 'idle' }; draw();
    try { if (id) await api.wechatCancel(id); const account = await api.connect(cookie); if (life.alive) await workspace.connected(account); }
    catch (err) { error = err.message; } finally { busy = false; draw(); }
  }));
  life.add(() => { generation++; clearInterval(timer); clearTimeout(pollTimer); if (wx.id && active()) api.wechatCancel(wx.id).catch(() => {}); });
  draw(); return life.dispose;
}
