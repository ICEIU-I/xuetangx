const { workers } = require('../../../src/tasks');
const { completeValue, failure } = require('./common');
function createMedia({ rpc, request, leaf, verify, progress, signal }) {
  const context = { rpc, request, leaf, verify };
  const video = require('./video').createAction(context);
  const article = require('./article').createAction(context);
  const discussion = require('./discussion').createAction(context);
  async function media(input) {
    const units = input.units, result = { total: units.length, processed: 0, completed: 0, skipped: 0, failed: 0, results: [] };
    const emit = message => progress({ ...result, message });
    await workers(units, input.concurrency || 3, async unit => {
      signal.throwIfAborted(); emit(`处理：${unit.title}`); let outcome;
      try {
        if (completeValue(unit.progress)) outcome = { status: 'skipped' };
        else if (unit.locked) throw failure('学习单元尚未开放', 'LOCKED');
        else outcome = await ({ video, article, discussion }[input.kind])(input.course, unit);
      } catch (error) {
        if (signal.aborted || ['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(error.code)) throw error;
        outcome = { status: 'failed', error: error.message };
      }
      result.processed++; result[outcome.status === 'failed' ? 'failed' : outcome.status === 'skipped' ? 'skipped' : 'completed']++;
      result.results.push({ unitId: unit.id, title: unit.title, ...outcome }); emit(`${result.processed}/${result.total}`);
    }, { signal });
    return result;
  }
  return media;
}
module.exports = { createMedia };
