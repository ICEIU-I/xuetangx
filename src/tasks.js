function concurrency(value = 3) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 3) throw new Error('并发数须为 1–3');
  return number;
}

// 等所有已启动的操作收尾后才结束任务；异常或停止后不领取新项目。
async function workers(items, limit, action, { signal, shouldStop = () => false } = {}) {
  limit = concurrency(limit);
  let next = 0, failure;
  async function worker() {
    while (next < items.length && !failure && !shouldStop()) {
      signal?.throwIfAborted();
      const index = next++;
      try { await action(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  signal?.throwIfAborted();
  if (failure) throw failure;
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

module.exports = { concurrency, workers };
