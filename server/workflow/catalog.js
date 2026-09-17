const { parseCourseUrl } = require('../../src/video');
const { workers } = require('../../src/tasks');
const { responseError } = require('../../src/http');
const unitKinds = { 0: 'video', 3: 'article', 4: 'discussion', 5: 'homework', 6: 'homework' };
function validId(value) { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw new Error('课程单元标识无效'); return id; }
function createCatalog({ request }) {
  async function data(account, endpoint, signal) {
    const response = await request(account, 'GET', endpoint, null, { signal });
    if (response.status !== 200 || response.json?.success === false || !response.json?.data) {
      const error = new Error(responseError(response, '读取课程')); error.status = response.status; throw error;
    }
    return response.json.data;
  }
  async function listCourses(account, signal) {
    const found = new Map(); let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const result = await data(account, `/api/v1/lms/user/user-courses/?status=1&page=${page}`, signal);
      if (!Array.isArray(result.product_list)) throw new Error('课程列表格式无法识别');
      pages = Number(result.pages ?? 1); if (!Number.isInteger(pages) || pages < 0 || pages > 100) throw new Error('课程分页无效');
      for (const item of result.product_list) {
        const classroomId = validId(item.classroom_id);
        if (!item.sign || !item.course_sign) throw new Error('课程缺少学习页标识');
        found.set(classroomId, { classroomId, sign: item.sign, courseSign: item.course_sign, title: item.name,
          url: `https://www.xuetangx.com/learn/space/${encodeURIComponent(item.sign)}/${encodeURIComponent(item.course_sign)}/${classroomId}` });
      }
    }
    return [...found.values()];
  }
  async function discover(account, courseUrl, signal) {
    const target = parseCourseUrl(courseUrl), courses = await listCourses(account, signal);
    const course = courses.find(item => item.classroomId === target.classroomId && item.sign === target.sign && item.courseSign === target.courseSign);
    if (!course) { const error = new Error(account.role === 'test' ? '请先为测试账号手动加入同一课程班级，再点击继续' : '正式账号未加入所选课程'); error.code = 'ENROLLMENT_REQUIRED'; throw error; }
    const query = new URLSearchParams({ cid: course.classroomId, sign: course.sign });
    const directory = await data(account, `/api/v1/lms/learn/course/chapter?${query}`, signal);
    if (!Array.isArray(directory.course_chapter)) throw new Error('课程目录格式无法识别');
    const schedule = await data(account, `/api/v1/lms/learn/course/schedule?${query}`, signal);
    if (!schedule.leaf_schedules) throw new Error('课程进度格式无法识别');
    const found = new Map();
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      const kind = node.leaf_type != null && unitKinds[Number(node.leaf_type)];
      if (kind && node.id) { const id = validId(node.id); found.set(id, { id, kind, leafType: Number(node.leaf_type), title: node.name || `单元 ${id}`, locked: !!node.is_locked, progress: Number(schedule.leaf_schedules[id] || 0) }); }
      Object.values(node).forEach(visit);
    }
    visit(directory.course_chapter);
    return { course, units: [...found.values()], totalSchedule: Number(schedule.total_schedule || 0), exercises: [] };
  }
  async function exercises(account, inventory, signal) {
    const result = [];
    await workers(inventory.units.filter(unit => unit.kind === 'homework'), 3, async unit => {
      const exercise = { leafId: unit.id, title: unit.title, locked: unit.locked, problems: [] };
      try {
        if (unit.locked) throw new Error('练习未开放或被锁定');
        const leaf = await data(account, `/api/v1/lms/learn/leaf_info/${inventory.course.classroomId}/${unit.id}/?sign=${encodeURIComponent(inventory.course.sign)}`, signal);
        if (Number(leaf.id) !== unit.id || Number(leaf.classroom_id) !== inventory.course.classroomId || ![5, 6].includes(Number(leaf.leaf_type))) throw new Error('练习身份与课程不匹配');
        if (leaf.is_locked || leaf.locked_reason || leaf.upgrade_sku_id || leaf.is_deleted) throw new Error('当前账号无法访问该练习');
        exercise.exerciseId = validId(leaf.content_info?.leaf_type_id); exercise.skuId = validId(leaf.sku_id);
        const list = await data(account, `/api/v1/lms/exercise/get_exercise_list/${exercise.exerciseId}/${exercise.skuId}/`, signal);
        if (!Array.isArray(list.problems)) throw new Error('无法识别习题列表');
        exercise.problems = list.problems;
        for (const problem of list.problems) { validId(problem.problem_id); if (!problem.content?.Type) throw new Error('题目类型缺失'); }
      } catch (error) {
        if (signal?.aborted || ['ACCOUNT_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(error.code) || [401, 403, 429].includes(error.status)) throw error;
        exercise.error = error.message;
      }
      result.push(exercise);
    }, { signal });
    return result.sort((a, b) => a.leafId - b.leafId);
  }
  return { discover, exercises, listCourses, data };
}
module.exports = { createCatalog };
