import { escape as e, lifetime } from '../shared/dom.js';
import { createWorkspace } from '../features/workspace/store.js';
import { startRouter, navigate } from '../router.js';
import { mountLearn } from '../learning/page.js';
import { mountHistory } from '../tasks/history.js';
import { mountDetail } from '../tasks/detail.js';
import { mountTools } from '../tools/page.js';
import { mountSettings } from '../settings/page.js';
import { mountPassword } from '../settings/password.js';
import { mountOverview } from '../admin/overview.js';
import { mountCollectors } from '../admin/collectors.js';
import { mountUsers } from '../admin/users.js';
import { mountAnswers } from '../admin/answers.js';
import { mountUserProgress } from '../admin/user-progress.js';
export function mountWorkspace(host, user, logout) {
  const life = lifetime(), admin = user.admin;
  const nav = admin ? [['/admin','管理概览'],['/admin/collectors','采集账号'],['/admin/users','用户管理'],['/admin/answers','答案库'],['/admin/settings','账号设置']] : [['/learn','课程任务'],['/tasks','任务记录'],['/tools','更多工具'],['/settings','账号设置']];
  const workspace = admin ? null : createWorkspace({owner:user.id}); let disposePage = () => {};
  host.innerHTML = `<div class="${admin ? 'admin-workspace' : 'user-workspace'} workspace"><a class="skip-link" href="#user-main">跳至主要内容</a><aside class="workspace-sidebar"><a data-route class="user-brand" href="${admin ? '/admin' : '/learn'}"><span class="brand-title"><span class="brand-text">CCF</span><span class="brand-caret" aria-hidden="true">▎</span></span>${admin ? '<small>管理中心</small>' : ''}</a><nav aria-label="${admin ? '管理员导航' : '主导航'}">${nav.map(([url,title],i) => `<a data-route href="${url}"><span class="nav-number">0${i+1}</span>${title}</a>`).join('')}</nav><div class="user-identity"><span title="${e(user.email)}">${e(user.email)}</span><button id="logout" class="text-button">退出登录</button></div></aside><main id="user-main" class="user-main" tabindex="-1"></main></div>`;
  host.querySelector('#logout').onclick = logout;
  const main = host.querySelector('main');
  life.add(startRouter(route => {
    if (admin && !route.path.startsWith('/admin')) { navigate('/admin',true); return; }
    if (!admin && route.path.startsWith('/admin')) { navigate('/learn',true); return; }
    disposePage(); main.innerHTML = '';
    host.querySelectorAll('nav a').forEach(link => { const url = link.getAttribute('href'), selected = url === route.path || (url === '/tasks' && route.id) || (url === '/admin/users' && route.userId); link.classList.toggle('selected',!!selected); if (selected) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
    if (admin) {
      if (route.userId) disposePage = mountUserProgress(main, route.userId);
      else if (route.path === '/admin/collectors') disposePage = mountCollectors(main);
      else if (route.path === '/admin/users') disposePage = mountUsers(main);
      else if (route.path === '/admin/answers') disposePage = mountAnswers(main);
      else if (route.path === '/admin/settings') { main.innerHTML = '<header class="page-heading"><h1>账号设置</h1></header><div class="settings-stack"></div>'; disposePage = mountPassword(main.querySelector('.settings-stack')); }
      else disposePage = mountOverview(main);
    } else if (route.id) disposePage = mountDetail(main,workspace,route.id);
    else if (route.path === '/tasks') disposePage = mountHistory(main,workspace);
    else if (route.path === '/tools') disposePage = mountTools(main,workspace,route);
    else if (route.path === '/settings') disposePage = mountSettings(main,workspace);
    else disposePage = mountLearn(main,workspace);
  }));
  life.add(() => { disposePage(); workspace?.dispose(); }); workspace?.initialize(); return life.dispose;
}
