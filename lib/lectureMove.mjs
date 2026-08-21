/**
 * Single-lecture course move — pure canonical contract.
 *
 * This module intentionally has no React, storage, or Supabase dependency so
 * identity/data preservation and destination eligibility are testable without
 * mutating a live library.
 */

/** Active destination courses, excluding the lecture's current course. */
export function moveTargets(courses, lecture) {
  if (!lecture || lecture.deletedAt) return [];
  return courses.filter((course) =>
    Boolean(course) && !course.deletedAt && course.id !== lecture.courseId,
  );
}

/**
 * Build the sole allowed move mutation. The returned lecture is the same
 * record with only its canonical courseId replaced; cloud targets the existing
 * remote recording row and dual-writes the legacy name for older clients.
 */
export function buildLectureMove({ lecture, targetCourse, courses }) {
  if (!lecture || lecture.deletedAt) return null;
  if (!targetCourse || targetCourse.deletedAt || targetCourse.id === lecture.courseId) return null;
  if (!moveTargets(courses, lecture).some((course) => course.id === targetCourse.id)) return null;

  return {
    lecture: { ...lecture, courseId: targetCourse.id },
    remoteIds: lecture.remoteRecordingId ? [lecture.remoteRecordingId] : [],
    remotePatch: { course_id: targetCourse.id, course: targetCourse.name },
  };
}
