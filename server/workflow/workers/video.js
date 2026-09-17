const { randomUUID } = require('node:crypto');
const { completeValue, failure, requireId } = require('./common');
function createAction({ rpc, request, leaf, verify }) {
  async function video(course, unit) {
    const data = await leaf(course, unit), media = data.content_info?.media;
    if (!media?.ccid || (media.type && media.type !== 'video')) throw failure('暂不支持该视频类型', 'UNSUPPORTED');
    const query = new URLSearchParams({ cid: requireId(data.course_id), user_id: requireId(data.user_id), classroom_id: course.classroomId, video_type: 'video', vtype: 'rate', video_id: unit.id });
    const getProgress = async () => (await request('GET', `/video-log/get_video_watch_progress/?${query}`))[unit.id];
    const before = await getProgress(); if (completeValue(before?.completed)) return { status: 'skipped' };
    const play = await request('GET', `/api/v1/lms/service/playurl/${encodeURIComponent(media.ccid)}/?appid=10000`);
    const duration = Math.ceil(Number(before?.video_length || media.duration || play.duration || play.m3u8?.duration));
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw failure('无法获取视频时长', 'INVALID_METADATA');
    const source = Object.values(play.sources || play.m3u8?.sources || {}).flat().find(value => typeof value === 'string' && /^https?:\/\//.test(value));
    const base = { i: 5, p: 'web', n: source ? new URL(source).hostname : 'other', lob: 'plat2', fp: 0, tp: 0, sp: 1,
      u: requireId(data.user_id), uip: '', c: requireId(data.course_id), v: unit.id, skuid: requireId(data.sku_id), classroomid: String(course.classroomId), cc: media.ccid, d: duration,
      pg: `${unit.id}_${randomUUID().slice(0, 8)}`, t: 'video', cards_id: 0, slide: 0, v_url: '' };
    const records = []; let sequence = 0, timestamp = Date.now();
    const add = (et, cp) => records.push({ ...base, et, cp, ts: String(timestamp++), sq: ++sequence });
    ['loadstart', 'loadeddata', 'play', 'playing'].forEach(type => add(type, 0));
    for (let point = 5; point < duration; point += 5) add('heartbeat', point);
    add('videoend', duration);
    while (records.length) await request('POST', '/video-log/heartbeat/', { heart_data: records.splice(0, 50) });
    if (!await verify(async () => completeValue((await getProgress())?.completed))) throw failure('后端尚未确认视频完成', 'UNCONFIRMED');
    return { status: 'completed' };
  }
  return video;
}
module.exports = { createAction };
