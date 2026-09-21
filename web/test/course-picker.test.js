import test from 'node:test';import assert from 'node:assert/strict';
import { coursePickerMarkup } from '../src/learning/course-picker.js';
import { selectedCourse } from '../src/features/workspace/courses.js';
test('course picker only displays original course titles without decoration or explanatory content',()=>{
 const state={session:{connected:true},courses:[{url:'one',title:'大学物理（2）(2026秋)',classroomId:31384299,fixed:true},{url:'two',title:'<数学> (2026秋)',classroomId:2,enrolled:true}],selectedCourseUrl:'two',coursesWarning:'upstream warning'};
 const html=coursePickerMarkup(state);assert.match(html,/>大学物理（2）\(2026秋\)<\/option>/);assert.match(html,/>&lt;数学&gt; \(2026秋\)<\/option>/);assert.match(html,/value="two" selected/);assert.equal(selectedCourse(state).url,'two');
 assert.doesNotMatch(html,/<button|<p|<label|固定可选|班级|已选|31384299|upstream warning|surface|刷新/);
 assert.match(html,/aria-label="选择课程"/);assert.match(coursePickerMarkup({...state,pendingStart:{}}),/aria-busy="false" disabled/);assert.equal(coursePickerMarkup({...state,session:{connected:false}}),'');
});
