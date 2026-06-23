// src/lib.js - 纯逻辑：题型解析、提交体构造、并发池。无网络/无浏览器依赖。

// 把答案数据(或服务器返回的 data)解析成统一的 question 结构
function buildQuestion(p, src) {
  const t = p.type;
  const q = { problem_id: p.problem_id };
  const ansMap = src.answers || {};
  const ansArr = Array.isArray(src.answer) ? src.answer : (src.answer ? [src.answer] : []);
  if (t === 'FillBlank') {
    q.type = 'fill'; q.blank_count = p.blankCount;
    const keys = Object.keys(ansMap).sort((a, b) => Number(a) - Number(b));
    q.answers = keys.map(k => (Array.isArray(ansMap[k]) ? ansMap[k][0] : ansMap[k]));
  } else if (t === 'MultipleChoice' || t === 'MultiChoice') {
    q.type = 'multi'; q.answers = ansArr.map(String);
  } else if (t === 'Judgement') {
    q.type = 'judge'; const s = String(ansArr[0] ?? '');
    q.answer = (s === 'true' || s === '1' || s === '正确') ? '正确'
             : (s === 'false' || s === '0' || s === '错误') ? '错误' : s;
  } else {
    q.type = (t === 'SingleChoice') ? 'choice' : (t || 'unknown');
    q.answer = ansArr[0] != null ? String(ansArr[0]) : '';
  }
  return q;
}

// 由「已知正确答案的 question」构造提交体（字段随题型不同）
function buildSubmitBody(q) {
  if (q.type === 'fill') {
    const a = {}; (q.answers || []).forEach((v, i) => a[String(i + 1)] = v);
    return { answers: a, answer: '' };
  }
  if (q.type === 'judge') {
    const v = q.answer === '正确' ? 'true' : (q.answer === '错误' ? 'false' : q.answer);
    return { answers: {}, answer: [v] };
  }
  if (q.type === 'multi') return { answers: {}, answer: (q.answers || []).map(String) };
  return { answers: {}, answer: [String(q.answer)] }; // choice
}

// 简单并发池：单任务失败不崩整池
async function pool(items, n, fn) {
  let idx = 0; const out = [];
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { __error: e.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, worker));
  return out;
}

module.exports = { buildQuestion, buildSubmitBody, pool };
