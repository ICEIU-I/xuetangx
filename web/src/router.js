const adminUserPath = path => path.match(/^\/admin\/users\/([^/]+)$/);
const titles = { '/learn': '课程任务', '/tasks': '任务记录', '/tools': '更多工具', '/settings': '账号设置', '/admin': '管理概览', '/admin/collectors': '采集账号', '/admin/users': '用户管理', '/admin/answers': '答案库', '/admin/settings': '系统设置' };
export function currentRoute() {
  const path = location.pathname;
  const adminUser = adminUserPath(path);
  return { path, query: new URLSearchParams(location.search), id: path.startsWith('/tasks/') ? decodeURIComponent(path.slice(7)) : '', userId: adminUser ? decodeURIComponent(adminUser[1]) : '', title: titles[path] || (adminUser ? '用户任务进度' : path.startsWith('/tasks/') ? '任务详情' : '课程任务') };
}
export function navigate(url, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', url); window.dispatchEvent(new Event('app-route'));
}
export function startRouter(onRoute) {
  function update() {
    if (!titles[location.pathname] && !/^\/tasks\/[^/]+$/.test(location.pathname) && !adminUserPath(location.pathname)) history.replaceState({}, '', '/learn' + location.search + location.hash);
    onRoute(currentRoute());
  }
  function click(event) {
    const link = event.target.closest('a[data-route]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(link.getAttribute('href'));
  }
  document.addEventListener('click', click); window.addEventListener('popstate', update); window.addEventListener('app-route', update); update();
  return () => { document.removeEventListener('click', click); window.removeEventListener('popstate', update); window.removeEventListener('app-route', update); };
}
