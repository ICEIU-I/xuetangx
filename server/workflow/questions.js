const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const typeOf = value => ({ SingleChoice: 'choice', MultipleChoice: 'multi', MultiChoice: 'multi', Judgement: 'judge', FillBlank: 'fill' }[value] || 'reference');
const meaningful = value => ['string', 'number', 'boolean'].includes(typeof value) && String(value).length > 0;
function fingerprint(problem) {
  const content = problem.content || {};
  return digest({ type: content.Type, body: content.Body || '', options: content.Options || [], blanks: content.Blanks || content.blanks || [], version: content.Version || null });
}
function standardAnswer(problem, source) {
  if (source?.is_show_answer !== true) return null;
  const type = typeOf(problem.content?.Type), raw = source.answer;
  const values = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const keys = (problem.content?.Options || []).map(option => String(option.key));
  if (type === 'choice' || type === 'multi') {
    if (!values.length || values.some(value => !meaningful(value) || !keys.includes(String(value))) || (type === 'choice' && values.length !== 1)) return null;
    return type === 'choice' ? { type, answer: String(values[0]) } : { type, answers: [...new Set(values.map(String))] };
  }
  if (type === 'judge') {
    const value = String(values[0]);
    if (!['true', 'false', '1', '0', '正确', '错误'].includes(value)) return null;
    return { type, answer: ['true', '1', '正确'].includes(value) ? '正确' : '错误' };
  }
  if (type === 'fill') {
    const map = source.answers;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b));
    const count = problem.content.Blanks?.length || problem.content.blanks?.length;
    if (!keys.length || (count && keys.length !== count)) return null;
    const entries = keys.map(key => Array.isArray(map[key]) ? map[key] : [map[key]]);
    if (!entries.every(entry => entry.length && entry.every(meaningful))) return null;
    return { type, answers: entries.map(entry => String(entry[0])), accepted_answers: map };
  }
  return null;
}
function storedAnswer(problem, record) {
  if (!record || record.answer_status !== 'captured' || record.error || record.type !== typeOf(problem.content?.Type)) return null;
  if (record.fingerprint !== fingerprint(problem) && record.fingerprint !== digest(problem.content)) return null;
  let raw = { is_show_answer: true, answer: record.answer ?? record.answers };
  if (record.type === 'fill') raw = { is_show_answer: true, answers: record.accepted_answers || Object.fromEntries((record.answers || []).map((value, index) => [index + 1, value])) };
  return standardAnswer(problem, raw);
}
function submitBody(answer) {
  if (answer.type === 'fill') return { answer: '', answers: Object.fromEntries(answer.answers.map((value, index) => [String(index + 1), value])) };
  if (answer.type === 'judge') return { answer: [answer.answer === '正确' ? 'true' : 'false'], answers: {} };
  return { answer: answer.type === 'multi' ? answer.answers : [answer.answer], answers: {} };
}
function probeBody(problem) {
  const type = typeOf(problem.content?.Type), first = problem.content?.Options?.[0]?.key;
  if (['choice', 'multi'].includes(type) && first != null) return { answer: [String(first)], answers: {} };
  if (type === 'judge') return { answer: ['true'], answers: {} };
  const count = problem.content?.Blanks?.length || problem.content?.blanks?.length;
  if (type === 'fill' && count) return { answer: '', answers: Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index + 1), '0'])) };
  return null;
}
function questionRecord(problem, answer, provenance) {
  return { problem_id: Number(problem.problem_id), index: problem.index, type: typeOf(problem.content.Type), platform_type: problem.content.Type,
    body_html: problem.content.Body || '', options: problem.content.Options || [], fingerprint: fingerprint(problem), ...answer,
    answer_status: 'captured', source: provenance.source, provenance, updatedAt: new Date().toISOString() };
}
module.exports = { fingerprint, storedAnswer, standardAnswer, submitBody, probeBody, questionRecord, typeOf };
