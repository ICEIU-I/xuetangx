// src/api.js - 纯 HTTPS 提交逻辑（脱离浏览器）。复用 lib 的纯函数。
// 所有函数接受可选 cookie（前端多账号）；不传则走 .env 默认。
const http = require('./http');
const { SKU_ID, CLASSROOM_ID, SIGN, MAX_RETRY } = require('../config');
const { buildSubmitBody, pool } = require('./lib');

const delay = ms => new Promise(r => setTimeout(r, ms));

// 取题目列表（含题型/user 状态：是否已做/是否正确）。网络异常时返回 {error}，不抛出。
async function getProblems(exerciseId, cookie) {
  let r;
  try { r = await http.get(`/api/v1/lms/exercise/get_exercise_list/${exerciseId}/${SKU_ID}/`, cookie); }
  catch (e) { return { error: e.message || 'network' }; }
  const ps = (r.json && r.json.data && r.json.data.problems) || [];
  if (!Array.isArray(ps)) return { error: 'no problems' };
  return ps.map(p => {
    const c = p.content || {}, u = p.user || {};
    return {
      problem_id: p.problem_id,
      type: c.Type || '',
      blankCount: Array.isArray(c.Blanks) ? c.Blanks.length : (Array.isArray(c.blanks) ? c.blanks.length : 1),
      optionKeys: Array.isArray(c.Options) ? c.Options.map(o => o.key) : [],
      my_count: u.my_count || 0,
      is_right: u.is_right,
      is_show_answer: !!u.is_show_answer,
      userAnswers: u.answers || null,
      userAnswer: u.answer || null,
    };
  });
}

// 提交一道题，带限速退避。返回 {ok, data, msg, rateLimited}
async function submit({ leafId, exerciseId, problemId, body }, cookie, onRateLimit) {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const r = await http.post('/api/v1/lms/exercise/problem_apply/', {
      leaf_id: Number(leafId), classroom_id: CLASSROOM_ID, exercise_id: Number(exerciseId),
      problem_id: problemId, sign: SIGN, answer: body.answer, answers: body.answers,
    }, cookie);
    const d = r.json;
    if (d && d.success && d.data) return { ok: true, data: d.data };
    const msg = (d && (d.detail || d.msg)) || r.raw.slice(0, 120);
    const m = /(\d+(?:\.\d+)?)\s*seconds?/.exec(msg);
    if (m) {
      const waitMs = Math.ceil(parseFloat(m[1]) * 1000) + 800;
      if (onRateLimit) onRateLimit(waitMs);
      await delay(waitMs);
      if (onRateLimit) onRateLimit(0); // 等待结束，通知解除限速
      continue;
    }
    return { ok: false, msg };
  }
  return { ok: false, msg: '限速重试耗尽' };
}

module.exports = { getProblems, submit, buildSubmitBody, pool, delay };
