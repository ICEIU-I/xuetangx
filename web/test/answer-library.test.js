import test from 'node:test';
import assert from 'node:assert/strict';
import { courseRows, pager, answerText, downloadURL } from '../src/admin/answer-library-view.js';

test('answer bank lists named courses with view and JSON links, no classroom input', () => {
  const html = courseRows([{course:{title:'大学物理 <2>',classroomId:12},totalExercises:5,totalQuestions:72,capturedAnswers:70,missingAnswers:2,updatedAt:1}]);
  assert.match(html, /大学物理 &lt;2&gt;/);
  assert.match(html, /70/);
  assert.match(html, /href="\/admin\/answers\?course=12"/);
  assert.match(html, /href="\/api\/answer-bank\/12\?download=1"/);
  assert.doesNotMatch(html, /<input/);
  assert.match(html, /answer-bank-row/);
  assert.doesNotMatch(html, /answer-bank-grid/);
  assert.match(courseRows([]), /暂无课程题库/);
  assert.equal(downloadURL('12&x=1'), '/api/answer-bank/12%26x%3D1?download=1');
});
test('answer bank pagination exposes every page and guards boundaries', () => {
  assert.equal(pager(0,20,1,false,'data-page'), '');
  assert.match(pager(0,20,45,false,'data-page'), /data-page="-20" disabled/);
  assert.match(pager(20,20,45,false,'data-page'), /21–40 \/ 45/);
  assert.match(pager(40,20,45,false,'data-page'), /data-page="60" disabled/);
});
test('answer display supports multiple choice, blanks, zero, false and missing states', () => {
  assert.equal(answerText({answer:0}), '0');
  assert.equal(answerText({answer:false}), 'false');
  assert.equal(answerText({answers:['A','C']}), 'A、C');
  assert.equal(answerText({accepted_answers:{1:['a','b']}}), '1: a / b');
  assert.equal(answerText({answer_status:'conflict',answer:'A'}), '待获取');
  assert.equal(answerText({answer_status:'reference',reference_answer:'example'}), 'example');
});
