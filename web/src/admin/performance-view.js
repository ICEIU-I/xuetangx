import { escape as e } from '../shared/dom.js';

export function formatAccuracy(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return '—';
  // A non-perfect result must never round up to 100%.
  const rounded = value === 100 ? 100 : Math.min(99.9, Math.round(value * 10) / 10);
  return `${rounded}%`;
}

export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '不足 1 秒';
  const total = Math.round(seconds);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60), remainder = total % 60;
  if (minutes < 60) return `${minutes} 分钟${remainder ? ` ${remainder} 秒` : ''}`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}`;
}

export function performanceSummary(data, busy = false) {
  const accuracy = data?.gradedAnswers > 0 ? formatAccuracy(data.answerAccuracyPercent) : '—';
  const duration = data?.completedCourseJobs > 0 ? formatDuration(data.averageCourseDurationSeconds) : '—';
  return `<dl class="overview-performance" aria-label="任务统计" aria-busy="${busy}">
    <div><dt title="仅统计可归属本站答题任务且平台已判分的提交样本">答题准确率</dt><dd>${e(accuracy)}</dd></div>
    <div><dt title="已完成整课程任务的平均用时，含排队、暂停和平台等待">平均任务完成时长</dt><dd>${e(duration)}</dd></div>
  </dl>`;
}
