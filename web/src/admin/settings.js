import { mountPassword } from '../settings/password.js';
import { mountRegistrationSettings } from './registration-settings.js';
export function mountAdminSettings(host) {
  host.innerHTML='<header class="page-heading"><h1>系统设置</h1></header><div class="settings-stack"><div data-registration-panel></div><div data-password-panel></div></div>';
  const registration=mountRegistrationSettings(host.querySelector('[data-registration-panel]'));
  const password=mountPassword(host.querySelector('[data-password-panel]'));
  return ()=>{registration();password();};
}
