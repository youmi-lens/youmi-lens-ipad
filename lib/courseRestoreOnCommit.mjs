/**
 * Pure decision for whether a new lecture commit (createLecture /
 * saveInProgressLecture in lib/store.tsx) must un-delete its target course
 * before the lecture is written.
 *
 * A recording session's courseId is captured once when the recording screen
 * mounts (`sessionCourseIdRef` in app/recording.tsx) and is never
 * re-validated against the live course list. If the course is soft-deleted
 * while that session is still open — backgrounded, crashed, or hidden by a
 * cross-device cloud merge — the courseId baked into the session is now
 * "deleted" from every active view, because activeLectures (lib/store.tsx)
 * hides any lecture whose courseId maps to a deleted course. Writing a
 * brand-new commit there would silently orphan real, already-recorded
 * content: no error, no warning, no recovery affordance — exactly the
 * "lecture disappeared from the Course" failure.
 *
 * This mirrors what restoreLecture already does when restoring a deleted
 * lecture whose course is also deleted: the user is actively producing real
 * content for this course right now, so data preservation wins over whatever
 * caused the earlier deletion.
 */

/**
 * @param {string | null | undefined} courseId
 * @param {Array<{ id: string, name: string, deletedAt?: string | null }>} courses
 * @returns {{ courseId: string, courseName: string } | null} the restore
 *   patch to apply, or null if no restore is needed (courseId missing, or
 *   the course doesn't exist / isn't deleted).
 */
export function courseRestorePatchForNewCommit(courseId, courses) {
  if (!courseId) return null;
  const course = (courses ?? []).find((c) => c.id === courseId);
  if (!course?.deletedAt) return null;
  return { courseId, courseName: course.name ?? '' };
}
