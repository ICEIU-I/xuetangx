// server/runner.js - 跑作业任务管理：封装 submit，发事件，感知限速，可停止。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ANSWERS_DIR, CONCURRENCY, SUBMIT_INTERVAL_MS } = require('../config');
const api = require('../src/api');
const session = require('./session');
const delay = api.delay;

const bus = new EventEmitter();          // 事件总线（SSE 订阅）
bus.setMaxListeners(50);

let state = {
  status: 'idle',          // idle | running | done | stopped | error
  total: 0,                // 本次待提交总题数
  done: 0,                 // 已完成（成功+失败）
  correct: 0,
  failed: 0,
  rateLimited: false,      // 当前是否在限速等待
  startedAt: 0,
  recent: [],              // 最近 60s 成功时间戳（算速率）
  sections: {},            // 每套作业进度
};
let stopFlag = false;

function emit(type, payload) { bus.emit('event', { ...payload, type, ts: Date.now() }); } // type 始终以参数为准，不被 payload 覆盖

function ratePerMin() {
  const now = Date.now();
  state.recent = state.recent.filter(t => now - t < 60000);
  return state.recent.length;
}

function snapshot() {
  return {
    status: state.status, total: state.total, done: state.done,
    correct: state.correct, failed: state.failed, rateLimited: state.rateLimited,
    ratePerMin: ratePerMin(), startedAt: state.startedAt,
    etaSec: estimateEtaSec(),
  };
}

// 剩余时间预估：按实时速率（题/分钟）。速率未知时返回 0（不显示）。
function estimateEtaSec() {
  const remain = state.total - state.done;
  if (remain <= 0) return 0;
  const rate = ratePerMin();
  if (rate <= 0) return 0;
  return Math.round(remain / rate * 60);
}

function loadAnswers(targets) {
  let names = fs.readdirSync(ANSWERS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  if (targets && targets.length) names = names.filter(n => targets.includes(n));
  return names.map(name => {
    const ans = JSON.parse(fs.readFileSync(path.join(ANSWERS_DIR, name + '.json'), 'utf8'));
    return { name, ans };
  }).filter(x => x.ans.leaf_id && x.ans.exercise_id);
}

async function startRun(targets) {
  if (state.status === 'running') throw new Error('已有任务在运行');
  if (!session.isConnected()) throw new Error('未连接（先设置 cookie）');
  const cookie = session.getCookie();

  stopFlag = false;
  state = { status: 'running', total: 0, done: 0, correct: 0, failed: 0, rateLimited: false, startedAt: Date.now(), recent: [], sections: {} };

  try {
    const sets = loadAnswers(targets);
    emit('phase', { msg: `准备 ${sets.length} 套作业，查询已做状态...` });

    // 收集待提交题（查 my_count 跳过已做）。查询用并发 3（代理稳）
    const jobs = [];
    await api.pool(sets, 3, async ({ name, ans }) => {
      if (stopFlag) return;
      const probs = await api.getProblems(ans.exercise_id, cookie);
      const ok = Array.isArray(probs);
      const doneSet = new Set(ok ? probs.filter(p => p.my_count > 0).map(p => p.problem_id) : []);
      const todo = ans.questions.filter(q => !q.error && !doneSet.has(q.problem_id));
      state.sections[name] = { total: ans.questions.length, already: doneSet.size, submitted: 0, correct: 0, failed: 0 };
      todo.forEach(q => jobs.push({ name, leafId: ans.leaf_id, exerciseId: ans.exercise_id, q }));
      emit('section', { name, ...state.sections[name], todo: todo.length, err: ok ? undefined : (probs && probs.error) });
    });

    state.total = jobs.length;
    emit('start', { total: state.total, sets: sets.length });

    if (state.total === 0) {
      state.status = 'done';
      emit('done', snapshot());
      return;
    }

    // 并发提交
    let consecFail = 0;   // 连续失败计数，用于熔断
    await api.pool(jobs, CONCURRENCY, async (job) => {
      if (stopFlag) return;
      const body = api.buildSubmitBody(job.q);
      // 限速由 api.submit 内部静默退避重试，不再当成"事件"刷屏/吓人
      const r = await api.submit({ leafId: job.leafId, exerciseId: job.exerciseId, problemId: job.q.problem_id, body }, cookie)
        .catch(e => ({ ok: false, msg: e.message || 'submit error' }));
      state.done++;
      // 熔断：开头连续 8 题全失败 → cookie 多半失效/账号异常，停止并提示
      consecFail = r.ok ? 0 : consecFail + 1;
      if (consecFail >= 8 && !stopFlag) {
        stopFlag = true;
        emit('phase', { msg: `⚠ 连续 ${consecFail} 题提交失败，已自动停止。多半是 cookie 已失效——请「断开并忘记」后重新填入最新 cookie。最近错误：${r.msg || ''}` });
      }
      const sec = state.sections[job.name] || { submitted: 0, correct: 0, failed: 0 };
      let mark;
      if (r.ok) {
        state.recent.push(Date.now());
        sec.submitted++;
        if (r.data.is_correct) { state.correct++; sec.correct++; mark = 'ok'; }
        else { sec.failed++; mark = 'wrong'; }
      } else {
        state.failed++; sec.failed++; mark = 'fail';
        if (/没有回答机会|没有.*机会/.test(r.msg || '')) state.noChance = (state.noChance || 0) + 1;
      }
      emit('progress', {
        name: job.name, problemId: job.q.problem_id, qType: job.q.type, mark,
        msg: r.ok ? undefined : r.msg, ...snapshot(),
      });
      // 配速：每题间隔，控制在服务器限速(~50/分钟)以内，避免触发 throttle
      if (!stopFlag && SUBMIT_INTERVAL_MS > 0) await delay(SUBMIT_INTERVAL_MS);
    });

    // 大面积"没有回答机会" → 账号可能未选课/题目已做完，友好提示
    if (state.noChance && state.noChance >= state.total * 0.5) {
      emit('phase', { msg: `⚠ 多数题提示「没有回答机会」(${state.noChance}/${state.total})。该账号可能未正式选课，或题目已全部完成——请确认 cookie 对应账号已选这门课。` });
    }

    state.status = stopFlag ? 'stopped' : 'done';
    emit(state.status, snapshot());
  } catch (e) {
    state.status = 'error';
    emit('error', { ...snapshot(), msg: e.message || String(e) });
  }
}

function stopRun() { stopFlag = true; }
function getState() { return snapshot(); }
function onEvent(cb) { bus.on('event', cb); return () => bus.off('event', cb); }

module.exports = { startRun, stopRun, getState, onEvent, snapshot };
