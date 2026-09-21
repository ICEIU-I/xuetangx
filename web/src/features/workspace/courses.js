export function selectedCourse(state) {
  return state.courses.find(course => course.url === state.selectedCourseUrl) || state.courses[0] || null;
}
export function scoreCourse(state) {
  if (state.detailId) {
    const job = state.jobs.find(item => item.id === state.detailId);
    if (!job || Number(job.primaryId) !== Number(state.session.user?.user_id || state.session.user?.id || 0)) return null;
    return job.course;
  }
  const course = selectedCourse(state);
  // A pinned course is not an enrollment. Do not probe grades for it until
  // enrollment was confirmed, including by an existing task for this account.
  if (course?.enrolled === false && !(state.jobs || []).some(job => Number(job.primaryId) === Number(state.session.user?.user_id || state.session.user?.id || 0) && courseIdentity(job.course) === courseIdentity(course))) return null;
  return course;
}
export function courseIdentity(course) {
  return course ? `${course.classroomId}:${course.sign || ''}:${course.courseSign || ''}` : '';
}
