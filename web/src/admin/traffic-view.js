import { escape as e } from '../shared/dom.js';

function pointsFor(data) {
  return Array.isArray(data?.points) ? data.points : [];
}

function dateLabel(start, interval) {
  if (!Number.isFinite(start)) return '';
  const date = new Date(start);
  if (interval === 'hour') return `${String(date.getUTCHours()).padStart(2, '0')}:00`;
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

export function trafficSummary(data, range = '7d', busy = false) {
  const active = data?.range === '30d' ? '30d' : data?.range === '7d' ? '7d' : range;
  const points = pointsFor(data);
  const known = points.filter(point => typeof point?.views === 'number' && Number.isSafeInteger(point.views) && point.views >= 0);
  const max = Math.max(1, ...known.map(point => point.views));
  const width = 720, height = 180, left = 30, right = 12, top = 16, bottom = 30;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const coordinates = points.map((point, index) => {
    const x = points.length <= 1 ? left + plotWidth / 2 : left + (plotWidth * index) / (points.length - 1);
    if (typeof point?.views !== 'number' || (!Number.isSafeInteger(point.views) || point.views < 0)) return {x, y: null, point};
    return {x, y: top + plotHeight - (point.views / max) * plotHeight, point};
  });
  const segments = [];
  let segment = [];
  for (const coordinate of coordinates) {
    if (coordinate.y == null) { if (segment.length) segments.push(segment); segment = []; }
    else segment.push(`${coordinate.x.toFixed(1)},${coordinate.y.toFixed(1)}`);
  }
  if (segment.length) segments.push(segment);
  const lines = segments.map(values => `<polyline points="${values.join(' ')}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
  const dots = coordinates.filter(coordinate => coordinate.y != null).map(coordinate => `<circle cx="${coordinate.x.toFixed(1)}" cy="${coordinate.y.toFixed(1)}" r="3" fill="currentColor"><title>${e(dateLabel(coordinate.point?.start, data?.interval))}：${e(coordinate.point.views)} 次</title></circle>`).join('');
  const labels = coordinates.filter((_, index) => points.length <= 7 || index === 0 || index === points.length - 1 || index === Math.floor(points.length / 2)).map(coordinate => `<span>${e(dateLabel(coordinate.point?.start, data?.interval))}</span>`).join('');
  const empty = !known.length;
  const total = known.reduce((sum, point) => sum + point.views, 0);
  const scope = data?.startedAt ? `页面加载次数 · UTC · ${dateLabel(data.startedAt, 'day')}起统计` : '页面加载次数 · UTC';
  return `<section class="overview-traffic" aria-label="访问量" aria-busy="${busy}">
    <header><div class="traffic-heading"><h2 title="${e(scope)}">访问量</h2>${!empty ? `<span class="traffic-total">${e(total)} 次</span>` : ''}</div><div class="traffic-range" role="group" aria-label="时间范围"><button type="button" id="traffic-range-7d" class="${active === '7d' ? 'selected' : ''}" aria-pressed="${active === '7d'}"${busy ? ' disabled' : ''}>7天</button><button type="button" id="traffic-range-30d" class="${active === '30d' ? 'selected' : ''}" aria-pressed="${active === '30d'}"${busy ? ' disabled' : ''}>30天</button></div></header>
    ${empty ? `<p class="traffic-empty" role="status">${busy ? '加载中…' : '暂无访问数据'}</p>` : `<div class="traffic-chart"><span class="traffic-y top">${e(max)}</span><span class="traffic-y bottom">0</span><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="访问量趋势图" preserveAspectRatio="none"><line class="traffic-grid" x1="${left}" y1="${top}" x2="${width - right}" y2="${top}"/><line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}"/><g class="traffic-lines">${lines}${dots}</g></svg><div class="traffic-labels">${labels}</div></div>`}
  </section>`;
}
