import test from 'node:test';
import assert from 'node:assert/strict';
import { questionRows } from '../src/admin/question-list-view.js';
const inert = value => String(value || '');
test('question list exposes every stem as a row, with per-question expandable answers', () => {
  const data = {database:{exercises:{a:{leaf_id:1,section:'章节一',questions:[{problem_id:3,body_html:'测试题',answer_status:'captured',answer:'A',options:[{key:'A',content:'选项'}]},{problem_id:4,body_html:'第二题',answer_status:'missing'}]}}}};
  const html=questionRows(data,20,inert);
  assert.equal((html.match(/<details /g)||[]).length,2);
  assert.match(html,/question-number">21</);assert.match(html,/question-number">22</);
  assert.match(html,/章节一 · ID 3/);assert.match(html,/已收录/);assert.match(html,/待补全/);
  assert.match(html,/选项/);assert.match(html,/question-answer/);
  assert.doesNotMatch(html,/<details[^>]*\bopen\b/);
});
test('question rows escape all text and handle empty searches', () => {
  const html=questionRows({database:{exercises:{a:{section:'<script>',questions:[{body_html:'<img src=x>',answer:'<b>A</b>',options:[{key:'<x>',content:'<svg>'}]}]}}}},0,inert);
  assert.doesNotMatch(html,/<img|<script|<svg|<x>|<b>/);
  assert.match(html,/&lt;img/);assert.match(questionRows({}),/没有匹配的题目/);
});
