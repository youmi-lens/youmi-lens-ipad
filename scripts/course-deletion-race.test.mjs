/**
 * P0 — closes the residual stale-hydration-window race left open after
 * restoreCourseIfDeletedForNewCommit (lib/store.tsx):
 *
 *   T0 local cache says course active (stale, pre-merge)
 *   T1 recording starts
 *   T2 cloud tombstone exists remotely but this device's merge has not landed
 *   T3 lecture commits locally (createLecture/saveInProgressLecture) — the
 *      commit-time guard sees "active" per the stale cache and no-ops
 *   T4 reconcile (applyRemoteRecordings) finally lands the remote tombstone
 *
 * Without protection, T4 would apply the remote deletion over a course that
 * now holds a lecture committed AFTER that deletion already happened server-
 * side — hiding it from UI and starving lib/useProcessingOrchestrator.ts
 * (which consumes the same activeLectures selector). resolveCourseDeletionState
 * (lib/deletionSync.mjs) is the fix: at the exact tombstone-adoption point
 * (lib/store.tsx's cloud-course merge loop), a local lecture whose commit
 * timestamp is NEWER than the remote deletion's freshness clock proves the
 * commit happened after the deletion — the race, not a lecture that
 * legitimately predates an intentional delete.
 */
import assert from 'node:assert/strict';

import { resolveCourseDeletionState, resolveDeletionState } from '../lib/deletionSync.mjs';

const T_DELETE = '2026-09-01T20:03:31.664Z';   // remote deletion_updated_at (T2)
const T_BEFORE = '2026-08-20T00:00:00.000Z';   // a lecture that predates the delete
const T_AFTER = '2026-09-10T16:40:54.491Z';    // the race lecture, committed at T3
const T_AFTER_LATER = '2026-09-10T16:46:00.000Z';

const courseId = '41dad0c1-55a2-4b3c-993c-93dfc7aa19f1';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('T0-T4 race — the exact proven incident shape');

check('1. qualifying lecture (date AFTER remote tombstone) — course stays/returns active', () => {
  const r = resolveCourseDeletionState({
    localDeletedAt: T_DELETE, localDeletionUpdatedAt: undefined, // stale local cache: no clock at all
    remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
    courseId,
    localLectures: [{ courseId, date: T_AFTER, deletedAt: null }],
  });
  assert.equal(r.deletedAt, null, 'the race must restore the course, not hide the new lecture');
  assert.equal(r.source, 'local');
});

check('2. matches what an explicit restore at the lecture timestamp would produce', () => {
  const viaRace = resolveCourseDeletionState({
    localDeletedAt: T_DELETE, remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
    courseId, localLectures: [{ courseId, date: T_AFTER, deletedAt: null }],
  });
  const viaExplicitRestore = resolveDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: T_AFTER,
    remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
  });
  assert.deepEqual(viaRace, viaExplicitRestore);
});

console.log('intentional-delete semantics — must NOT be disturbed');

check('3. lecture date BEFORE the remote tombstone — normal cascade-delete applies, no restore', () => {
  const r = resolveCourseDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: undefined,
    remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
    courseId,
    localLectures: [{ courseId, date: T_BEFORE, deletedAt: null }],
  });
  assert.equal(r.deletedAt, T_DELETE, 'a lecture that predates the deletion must never resurrect the course');
  assert.equal(r.source, 'remote');
});

check('4. no local lecture under this course at all — unaffected, delegates to plain resolveDeletionState', () => {
  const withGuard = resolveCourseDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: undefined,
    remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
    courseId, localLectures: [],
  });
  const plain = resolveDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: undefined,
    remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
  });
  assert.deepEqual(withGuard, plain);
  assert.equal(withGuard.deletedAt, T_DELETE, 'a truly deleted course with no new local lecture is NOT auto-restored');
});

check('5. lecture belongs to a DIFFERENT course — no cross-course leakage', () => {
  const r = resolveCourseDeletionState({
    localDeletedAt: null, remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
    courseId,
    localLectures: [{ courseId: 'some-other-course-id', date: T_AFTER, deletedAt: null }],
  });
  assert.equal(r.deletedAt, T_DELETE, 'a qualifying lecture on a different course must not protect this one');
});

check('6. a soft-deleted qualifying lecture does not trigger restore', () => {
  const r = resolveCourseDeletionState({
    localDeletedAt: null, remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
    courseId,
    localLectures: [{ courseId, date: T_AFTER, deletedAt: '2026-09-10T17:00:00.000Z' }],
  });
  assert.equal(r.deletedAt, T_DELETE, 'the user deleted that lecture themselves — it must not resurrect the course');
});

check('7. multiple qualifying lectures — uses the newest date, result still correct', () => {
  const r = resolveCourseDeletionState({
    localDeletedAt: null, remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
    courseId,
    localLectures: [
      { courseId, date: T_AFTER, deletedAt: null },
      { courseId, date: T_AFTER_LATER, deletedAt: null },
      { courseId, date: T_BEFORE, deletedAt: null },
    ],
  });
  assert.equal(r.deletedAt, null);
  assert.equal(r.deletionUpdatedAt, T_AFTER_LATER, 'must win using the newest qualifying commit, not just any');
});

check('8. remote row is not deleted at all — no-op regardless of local lectures', () => {
  const r = resolveCourseDeletionState({
    localDeletedAt: null, remoteDeletedAt: null, remoteDeletionUpdatedAt: undefined,
    courseId, localLectures: [{ courseId, date: T_AFTER, deletedAt: null }],
  });
  assert.equal(r.deletedAt, null);
});

check('9. an already-explicit, already-fresher local restore is untouched (not reinterpreted as the race)', () => {
  // The user restored this course themselves (restoreCourse) at a clock newer
  // than the remote tombstone — resolveDeletionState alone already wins this;
  // the wrapper must not change that outcome or its source.
  const r = resolveCourseDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: T_AFTER_LATER,
    remoteDeletedAt: T_DELETE, remoteDeletionUpdatedAt: T_DELETE,
    courseId, localLectures: [],
  });
  assert.equal(r.deletedAt, null);
  assert.equal(r.source, 'local');
});

console.log(`\ncourse deletion race guard: ${passed} checks passed`);
