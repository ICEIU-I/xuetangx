import { request } from '../api.js';
import { disabled, feedback, json, render, delegate, lifetime } from '../shared/dom.js';
export function registrationSettingsView({loaded=false,enabled=true,emailEnabled=true,busy=false,error='',message=''} = {}) {
  return `<section class="surface registration-settings"><h2>注册邮箱验证</h2><p class="muted">开启后，新用户须填写邮箱验证码才能完成注册。已有账号不受影响。</p>${!loaded && !error ? '<div class="pixel-loader" role="status">正在读取设置…</div>' : ''}<form data-registration-settings><label class="checkbox-label"><input type="checkbox" name="emailVerificationRequired"${enabled ? ' checked' : ''}${disabled(!loaded || busy)} aria-describedby="registration-policy-hint">注册时需要邮箱验证码</label><p id="registration-policy-hint" class="muted">默认开启，保存后立即生效，服务重启后保持。${!emailEnabled ? ' 当前邮箱发送服务不可用，不能开启验证。' : ''}</p><div class="form-actions"><button class="primary"${disabled(!loaded || busy)}>${busy ? '保存中…' : '保存注册设置'}</button></div></form>${feedback(error)}${feedback(message,'neutral')}</section>`;
}
export function mountRegistrationSettings(host) {
  const life=lifetime(); let state={loaded:false,enabled:true,busy:false,error:'',message:''};
  const draw=()=>{if(life.alive)render(host,registrationSettingsView(state));};
  life.add(delegate(host,'change','[name="emailVerificationRequired"]',(_,input)=>{state.enabled=input.checked;}));
  life.add(delegate(host,'submit','[data-registration-settings]',async(event)=>{
    event.preventDefault();if(state.busy||!state.loaded)return;
    state.busy=true;state.error='';state.message='';draw();
    try{const value=await request('/api/admin/registration-settings',json('PUT',{emailVerificationRequired:state.enabled}));state.enabled=value.emailVerificationRequired;state.emailEnabled=value.emailEnabled;state.message='注册设置已保存。';}
    catch(err){state.error=err.message;}finally{state.busy=false;draw();}
  }));
  draw();request('/api/admin/registration-settings').then(value=>{state={...state,loaded:true,enabled:value.emailVerificationRequired,emailEnabled:value.emailEnabled};draw();}).catch(err=>{state.error=err.message;draw();});
  return life.dispose;
}
