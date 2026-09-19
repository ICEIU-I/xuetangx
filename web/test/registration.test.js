import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationCodeFields, registrationCooldown } from '../src/auth/registration-code.js';
import { registrationSettingsView } from '../src/admin/registration-settings.js';
test('registration code is a six-digit one-time field with independent send button',()=>{
 const html=registrationCodeFields();assert.match(html,/autocomplete="one-time-code"/);assert.match(html,/maxlength="6"/);assert.match(html,/pattern="\[0-9\]\{6\}"/);assert.match(html,/type="button" data-registration-code/);assert.match(html,/10 分钟/);
 assert.match(registrationCodeFields({code:'"<x>'}),/&quot;&lt;x&gt;/);
});
test('registration send cooldown is bounded and disabled while sending or mail unavailable',()=>{
 assert.equal(registrationCooldown(61000,1000),60);assert.equal(registrationCooldown(61000,60001),1);assert.equal(registrationCooldown(61000,70000),0);
 for(const options of [{busy:true},{remaining:30},{emailEnabled:false}])assert.match(registrationCodeFields(options),/data-registration-code disabled/);
});
test('admin verification switch defaults on and requires explicit save',()=>{
 const html=registrationSettingsView({loaded:true});assert.match(html,/name="emailVerificationRequired" checked/);assert.match(html,/保存注册设置/);assert.match(html,/已有账号不受影响/);
 assert.doesNotMatch(registrationSettingsView({loaded:true,enabled:false}),/name="emailVerificationRequired" checked/);
 assert.match(registrationSettingsView({loaded:false}),/name="emailVerificationRequired" checked disabled/);
 assert.match(registrationSettingsView({error:'<error>'}),/&lt;error&gt;/);
});
