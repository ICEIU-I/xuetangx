import { activeStatuses, modules, primaryId } from './presentation.js';

// A tool run (including auto-added collection) describes its own scope, not
// completion of every module in a course. Targeted exercises/videos remain partial.
export function isWholeCourseTask(job) {
  return !!job && !Number(job.unitId || 0) && !(job.targets?.length) && modules.every(({kind}) => !!job.modules?.[kind]);
}

export function homepageJob(jobs, session, course) {
  if (!primaryId(session) || !course) return null;
  const matches = jobs.filter(job => Number(job.primaryId) === primaryId(session) && Number(job.course.classroomId) === Number(course.classroomId))
    .sort((a,b) => b.createdAt - a.createdAt);
  // Preserve active tasks and older whole-course progress even if a newer tool
  // run finished. With only completed tool runs, return to the start screen.
  return matches.find(job => activeStatuses.includes(job.status))
    || matches.find(isWholeCourseTask)
    || matches.find(job => job.status !== 'done')
    || null;
}

export function startScope(options = {}) {
  return { modules: options.modules?.length ? [...options.modules] : modules.map(m => m.kind), targets: [...(options.targets || [])], unitId: options.unitId || 0 };
}
export function matchesPendingScope(job, pending) {
  // Pending starts from older clients had no explicit scope; keep their recovery.
  if (!pending.modules) return true;
  return pending.modules.every(kind => !!job.modules?.[kind])
    && Number(job.unitId || 0) === Number(pending.unitId || 0)
    && JSON.stringify(job.targets || []) === JSON.stringify(pending.targets || []);
}
