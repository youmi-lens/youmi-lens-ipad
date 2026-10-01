import assert from 'node:assert/strict';

import { courseRestorePatchForNewCommit } from '../lib/courseRestoreOnCommit.mjs';

// P0: "lecture disappears after a backgrounded upload" — a recording
// session's courseId is captured once at mount (app/recording.tsx) and never
// re-validated. If the course is deleted while the session is still open
// (background, crash, cross-device merge), Finish/autosave must not be
// allowed to silently attach a brand-new, fully-recorded lecture to a
// courseId that every active-view selector treats as gone.

const activeCourse = { id: 'course-1', name: 'CS 101', deletedAt: null };
const deletedCourse = { id: 'course-2', name: 'Hhh', deletedAt: '2026-09-01T20:03:31.664Z' };
const courses = [activeCourse, deletedCourse];

// ---- No restore needed ----
assert.equal(courseRestorePatchForNewCommit(undefined, courses), null, 'no courseId -> no-op');
assert.equal(courseRestorePatchForNewCommit('', courses), null, 'empty courseId -> no-op');
assert.equal(courseRestorePatchForNewCommit('course-1', courses), null, 'active course -> no-op');
assert.equal(
  courseRestorePatchForNewCommit('course-does-not-exist', courses),
  null,
  'unknown courseId -> no-op (nothing to restore)',
);
assert.equal(courseRestorePatchForNewCommit('course-2', []), null, 'empty course list -> no-op');
assert.equal(courseRestorePatchForNewCommit('course-2', undefined), null, 'missing course list -> no-op');

// ---- Restore needed: the exact real-incident shape ----
// A NEW commit (createLecture) targeting a soft-deleted course must produce a
// restore patch so the lecture — and the course that holds it — become
// visible again instead of vanishing into deletedCourseIds forever.
const patch = courseRestorePatchForNewCommit('course-2', courses);
assert.deepEqual(patch, { courseId: 'course-2', courseName: 'Hhh' });

// A course with no name on record still produces a restorable patch (never
// throws, never skips the restore just because the name is missing).
const unnamedDeletedCourse = { id: 'course-3', deletedAt: '2026-09-01T00:00:00.000Z' };
const unnamedPatch = courseRestorePatchForNewCommit('course-3', [unnamedDeletedCourse]);
assert.deepEqual(unnamedPatch, { courseId: 'course-3', courseName: '' });

console.log('Course-restore-on-new-commit tests passed.');
