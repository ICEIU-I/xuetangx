import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordField, setPasswordVisibility, bindPasswordToggles } from '../src/shared/password-field.js';
import { lifetime } from '../src/shared/dom.js';

test('password eye defaults to masked input and never submits the form', () => {
  const html = passwordField({id:'new-password',name:'password',autocomplete:'new-password',maxLength:256});
  assert.match(html,/type="password"/); assert.match(html,/type="button"/);
  assert.match(html,/aria-controls="new-password"/);assert.match(html,/aria-pressed="false"/);
  assert.match(html,/autocomplete="new-password"/);assert.match(html,/maxlength="256"/);
  assert.doesNotMatch(html,/value=/);
  assert.match(passwordField({id:'x"<>',name:'y'}),/x&quot;&lt;&gt;/);
});

test('visibility switching retains password and selection without copying it', () => {
 const input={type:'password',selectionStart:1,selectionEnd:3,value:'mock-only',setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}};
 const button={attrs:{},setAttribute(k,v){this.attrs[k]=v;}};
 setPasswordVisibility(input,button,true);
 assert.equal(input.type,'text');assert.equal(input.value,'mock-only');assert.equal(button.attrs['aria-pressed'],'true');assert.equal(button.attrs['aria-label'],'隐藏密码');
 setPasswordVisibility(input,button,false);
 assert.equal(input.type,'password');assert.equal(button.attrs['aria-label'],'显示密码');assert.equal(input.selectionEnd,3);
});

test('delegated eyes toggle independently, reset masks them and disposal cleans listeners', () => {
 const events=new Map(),life=lifetime();
 const host={contains:()=>true,addEventListener:(type,fn)=>events.set(type,fn),removeEventListener:type=>events.delete(type)};
 const make=id=>{const input={id,type:'password',selectionStart:0,selectionEnd:0,setSelectionRange(){}}; const button={dataset:{passwordToggle:id},parentElement:{querySelector:()=>input},setAttribute(){}};return {input,button};};
 const first=make('one'),second=make('two');let prevented=0;
 bindPasswordToggles(host,life);
 events.get('click')({preventDefault:()=>prevented++,target:{closest:()=>first.button}});
 assert.equal(first.input.type,'text');assert.equal(second.input.type,'password');assert.equal(prevented,1);
 const form={querySelectorAll:()=>[first.button,second.button]};events.get('reset')({target:{closest:()=>form}});
 assert.equal(first.input.type,'password');assert.equal(second.input.type,'password');
 life.dispose();assert.equal(events.size,0);
});
