const { completeValue, failure, requireId } = require('./common');
function createAction({ rpc, request, leaf, verify }) {
  async function discussion(course, unit) {
    const data = await leaf(course, unit);
    const query = new URLSearchParams({ product_sign: course.sign, leaf_id: unit.id, classroom_id: course.classroomId, topic_type: 4, channel: 'xt' });
    const topic = await request('GET', `/api/v1/lms/forum/unit/discussion/?${query}`);
    if (Number(topic.classroom_id) !== course.classroomId || Number(topic.chapter_id) !== unit.id || !Number.isInteger(Number(topic.user_comment_num))) throw failure('无法确认讨论身份或发言记录', 'INVALID_METADATA');
    let posted = false;
    if (Number(topic.user_comment_num) === 0) {
      const response = await rpc('publish-discussion', { leafId: unit.id, topicId: requireId(topic.id), toUser: requireId(topic.user_id) });
      posted = response.posted;
    }
    if (!await verify(async () => completeValue((await request('POST', '/api/v1/lms/learn/chapter/schedule', { leaf_id: unit.id, classroom_id: course.classroomId, sku_id: requireId(data.sku_id) })).leaf_schedule))) throw failure('已发表或待核对，后端尚未确认讨论完成；不会重复发帖', 'UNCONFIRMED');
    return { status: posted ? 'completed' : 'skipped' };
  }
  return discussion;
}
module.exports = { createAction };
