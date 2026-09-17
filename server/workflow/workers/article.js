const { completeValue, failure, requireId } = require('./common');
function createAction({ rpc, request, leaf, verify }) {
  async function article(course, unit) {
    const data = await leaf(course, unit); if (completeValue(data.finish)) return { status: 'skipped' };
    await request('GET', `/api/v1/lms/learn/user_article_finish/${unit.id}/?${new URLSearchParams({ cid: course.classroomId, sid: requireId(data.sku_id) })}`);
    if (!await verify(async () => completeValue((await leaf(course, unit)).finish))) throw failure('后端尚未确认图文完成', 'UNCONFIRMED');
    return { status: 'completed' };
  }
  return article;
}
module.exports = { createAction };
