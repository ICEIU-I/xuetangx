const { setTimeout: sleep } = require('node:timers/promises');
const { fingerprint, storedAnswer, submitBody, probeBody } = require('./questions');
const { SUBMIT } = require('./broker');
const errorOf = (message, code) => Object.assign(new Error(message), { code });
const { transientCodes } = require('../../src/network/errors');
const transient = new Set([...transientCodes, 'REMOTE_TRANSIENT']);
const fatal = new Set(['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED']);
const MAX_RETRIES = 2;

function createSubmissions({ bank, catalog, effects, call, now = Date.now, waiting = () => {}, report = () => {},
  isRateLimited = response => response.status === 429, wait = sleep, recheckDelays = [1000, 2000, 4000] }) {
  const submissions = new Map();
  async function submitQuestion(job, actor, args) {
    const signal = actor.controller.signal;
    signal.throwIfAborted();
    const exercise = actor.input.exercises.find(item => item.leafId === args.leafId);
    const problem = exercise?.problems.find(item => Number(item.problem_id) === args.problemId);
    if (!problem || exercise.error || !exercise.skuId) throw errorOf('题目不属于当前任务', 'INVALID_METADATA');
    if (actor.kind === 'homework') {
      if (actor.account.role !== 'primary') throw errorOf('正式答题账号角色错误', 'INVALID_ROLE');
      const db = await bank.read(job.course), saved = db.exercises[exercise.leafId]?.questions?.find(item => Number(item.problem_id) === args.problemId);
      const answer = storedAnswer(problem, saved);
      if (!answer || JSON.stringify(submitBody(answer)) !== JSON.stringify(args.body)) throw errorOf('正式账号仅允许提交匹配题库的标准答案', 'ANSWER_MISMATCH');
    } else if (actor.kind !== 'collector' || actor.account.role !== 'test' || JSON.stringify(probeBody(problem)) !== JSON.stringify(args.body)) throw errorOf('采集提交必须使用测试账号', 'INVALID_ROLE');
    const key = `question-${actor.account.userId}-${job.course.classroomId}-${args.problemId}-${fingerprint(problem).slice(0, 16)}`;
    if (submissions.has(key)) return submissions.get(key);
    const operation = (async () => {
      const prior = await effects.read(key);
      const record = { ...prior, userId: actor.account.userId, classroomId: job.course.classroomId, leafId: args.leafId,
        problemId: args.problemId, fingerprint: fingerprint(problem), networkRetries: prior?.networkRetries ?? 0 };
      if (!Number.isInteger(record.networkRetries) || record.networkRetries < 0) throw errorOf('本地答题重试记录无效', 'INVALID_METADATA');
      const save = async (state, extra = {}) => {
        Object.assign(record, extra, { state, updatedAt: now() });
        await effects.save(key, record);
      };
      const message = text => report(job, actor, `题目 ${args.problemId}：${text}`);
      async function reconcile() {
        message('提交结果待确认，正在回查平台作答状态');
        for (const delay of recheckDelays) {
          signal.throwIfAborted();
          if (delay) await wait(delay, undefined, { signal });
          signal.throwIfAborted();
          let current;
          try {
            const list = await catalog.data(actor.account, `/api/v1/lms/exercise/get_exercise_list/${exercise.exerciseId}/${exercise.skuId}/`, signal);
            current = list.problems?.find(item => Number(item.problem_id) === args.problemId);
          } catch (error) {
            if (signal.aborted || fatal.has(error.code)) throw error;
            throw errorOf(`回查失败，已保留待核对记录，未重发：${error.message}`, 'REVIEW_REQUIRED');
          }
          if (!current || fingerprint(current) !== fingerprint(problem)) throw errorOf('回查题目缺失或版本已变化，未重发', 'REVIEW_REQUIRED');
          const count = current.user?.my_count;
          // A missing or malformed count must never be interpreted as "unanswered".
          if (!['string', 'number'].includes(typeof count) || String(count).trim() === '' || !Number.isSafeInteger(Number(count)) || Number(count) < 0) {
            throw errorOf('回查缺少有效作答次数，未重发', 'REVIEW_REQUIRED');
          }
          if (Number(count) > 0) {
            await save('confirmed'); message('平台已确认作答，未重复提交');
            return { ...current.user, is_correct: current.user.is_right };
          }
        }
        return null;
      }
      async function retry(notSent = false) {
        if (record.networkRetries >= MAX_RETRIES) {
          await save('retry_exhausted');
          throw errorOf(`已达到 ${MAX_RETRIES} 次自动重试上限，仍未确认作答成功`, 'SUBMISSION_RETRY_EXHAUSTED');
        }
        await save('retry_ready', { networkRetries: record.networkRetries + 1 });
        message(`${notSent ? '请求未发出' : '多次回查确认未作答'}，自动重试 ${record.networkRetries}/${MAX_RETRIES}`);
        if (notSent) await wait(record.networkRetries * 1000, undefined, { signal });
      }
      if (prior && !['rejected', 'not_sent'].includes(prior.state)) {
        const confirmed = await reconcile(); if (confirmed) return confirmed;
        if (['posted', 'confirmed'].includes(prior.state)) throw errorOf('平台曾确认接收，但当前回查尚未确认，请核对作答状态', 'REVIEW_REQUIRED');
        // Older versions incorrectly marked unreachable-host/network failures as permanent.
        if (prior.retryable === false && !transient.has(prior.lastError)) throw errorOf('上次错误不支持自动重试，请核对作答状态', 'REVIEW_REQUIRED');
        // retry_ready already reserves this retry before a possible pause/restart.
        if (prior.state !== 'retry_ready') await retry();
      } else if (prior?.state === 'not_sent') await retry(true);

      let rateFailures = 0;
      for (;;) {
        signal.throwIfAborted();
        await save('pending', { at: now(), retryable: true });
        let response;
        try {
          response = await call(actor.account, 'POST', SUBMIT, { leaf_id: args.leafId, classroom_id: job.course.classroomId,
            exercise_id: exercise.exerciseId, problem_id: args.problemId, sign: job.course.sign, ...args.body },
          { signal, onWait: state => waiting(job, actor, state) });
          if (response.status >= 500) throw errorOf(`平台暂时不可用（HTTP ${response.status}）`, 'REMOTE_TRANSIENT');
        } catch (error) {
          const notSent = error.connectionEstablished === false, retryable = transient.has(error.code);
          await save(notSent ? 'not_sent' : fatal.has(error.code) ? 'rejected' : 'unknown', { retryable: retryable || signal.aborted, lastError: error.code || error.name });
          if (signal.aborted || fatal.has(error.code)) throw error;
          if (!notSent) { const confirmed = await reconcile(); if (confirmed) return confirmed; }
          if (!retryable) throw error;
          await retry(notSent); continue;
        }
        if (isRateLimited(response)) {
          await save('rejected');
          if (++rateFailures < 4) continue;
          throw errorOf('多次达到平台提交限速，请稍后继续', 'RATE_LIMITED');
        }
        if (response.status !== 200 || response.json?.success !== true || !response.json.data) {
          const rejected = response.json?.success === false || [400, 401, 403, 404, 422].includes(response.status);
          await save(rejected ? 'rejected' : 'unknown', { retryable: false });
          if (!rejected) { const confirmed = await reconcile(); if (confirmed) return confirmed; }
          const detail = response.json?.msg || response.json?.detail;
          throw errorOf(`作答提交未成功（HTTP ${response.status}）${typeof detail === 'string' ? `：${detail.slice(0, 160)}` : ''}`, 'REMOTE_ERROR');
        }
        // Persistence errors must not enter the transport retry loop.
        await save('posted'); return response.json.data;
      }
    })();
    submissions.set(key, operation); try { return await operation; } finally { submissions.delete(key); }
  }
  return { submitQuestion };
}
module.exports = { createSubmissions };
