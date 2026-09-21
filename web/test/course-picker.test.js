import test from 'node:test';import assert from 'node:assert/strict';
import { coursePickerMarkup } from '../src/learning/course-picker.js';
import { selectedCourse } from '../src/features/workspace/courses.js';
test('course picker includes fixed and enrolled choices with explicit selection and retry',()=>{
 const state={session:{connected:true},courses:[{url:'one',title:'物理',classroomId:1,fixed:true},{url:'two',title:'<数学>',classroomId:2,enrolled:true}],selectedCourseUrl:'two',coursesWarning:'稍后重试'};
 const html=coursePickerMarkup(state);assert.match(html,/固定可选/);assert.match(html,/&lt;数学&gt; · 已选/);assert.match(html,/value="two" selected/);assert.match(html,/刷新课程/);assert.match(html,/稍后重试/);assert.equal(selectedCourse(state).url,'two');
 assert.match(coursePickerMarkup({...state,pendingStart:{}}),/id="workflow-course" disabled/);assert.equal(coursePickerMarkup({...state,session:{connected:false}}),'');
});
