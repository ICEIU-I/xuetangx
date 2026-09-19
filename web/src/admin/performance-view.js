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

function validCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function valueMarkup(value, unit = '') {
  if (value === '—') return '<strong>—</strong>';
  return `<strong>${e(value)}</strong>${unit ? `<span>${e(unit)}</span>` : ''}`;
}

function compactDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return {value: Math.round(seconds * 10) / 10, unit: '秒'};
  const minutes = seconds / 60;
  if (minutes < 60) return {value: Math.round(minutes * 10) / 10, unit: '分钟'};
  return {value: Math.round(minutes / 60 * 10) / 10, unit: '小时'};
}

export function performanceSummary(data, busy = false) {
  const performance = data?.performance ?? data;
  const accuracy = validCount(performance?.gradedAnswers) && performance.gradedAnswers > 0
    ? formatAccuracy(performance.answerAccuracyPercent) : '—';
  const duration = validCount(performance?.completedCourseJobs) && performance.completedCourseJobs > 0
    ? compactDuration(performance.averageCourseDurationSeconds) : null;
  const running = validCount(data?.runningJobs) ? String(data.runningJobs) : '—';
  const accuracyValue = accuracy === '—' ? '—' : accuracy.slice(0, -1);
  const durationTitle = duration ? formatDuration(performance.averageCourseDurationSeconds) : '';
  return `<dl class="overview-performance" aria-label="任务统计" aria-busy="${busy}">
    <div><dt title="仅统计可归属本站答题任务且平台已判分的提交样本">答题准确率</dt><dd>${valueMarkup(accuracyValue, accuracy === '—' ? '' : '%')}</dd></div>
    <div><dt title="从任务创建到最后确认完成的平均用时，含排队、暂停和平台等待">平均完成用时</dt><dd title="${e(durationTitle)}">${duration ? valueMarkup(duration.value, duration.unit) : valueMarkup('—')}</dd></div>
    <div><dt>已完成任务</dt><dd>${valueMarkup(validCount(performance?.completedCourseJobs) ? String(performance.completedCourseJobs) : '—')}</dd></div>
    <div><dt>运行中任务</dt><dd>${valueMarkup(running)}</dd></div>
  </dl>`;
}
