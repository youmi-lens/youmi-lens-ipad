/**
 * Lifecycle contract: native durable audio is app-container scoped, while
 * Cloud Library ownership is exact lecture UUIDs scoped by the current account.
 * Deleting a lecture or its course must logically detach its native session
 * without deleting the physical audio. A later Course/Lecture must never adopt
 * that historical session merely because it is recoverable.
 */
import assert from 'node:assert/strict';

import { ownedUnresolvedRecoverableSessions } from '../lib/recording/policy.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const courseA = 'course-a-historical';
const lectureA = 'lecture-a-historical';
const courseB = 'course-b-new';
const lectureB = 'lecture-b-new';
const sessionA = Object.freeze({
  recordingSessionId: 'durable-session-a',
  lectureId: lectureA,
  recoverable: true,
  state: 'paused',
  updatedAt: '2026-09-24T12:00:00.000Z',
  segments: [{ sequence: 1, durationMs: 12_000, relativePath: 'segments/0001.m4a' }],
});
const sessionB = Object.freeze({
  recordingSessionId: 'durable-session-b',
  lectureId: lectureB,
  recoverable: true,
  state: 'paused',
  updatedAt: '2026-09-24T12:01:00.000Z',
  segments: [{ sequence: 1, durationMs: 6_000, relativePath: 'segments/0001.m4a' }],
});

const discover = (sessions, activeRecoveryLectureIds, excludeLectureId = 'fresh-pending-lecture') =>
  ownedUnresolvedRecoverableSessions(sessions, excludeLectureId, activeRecoveryLectureIds);

console.log('deleted recorder ownership isolation');

check('an active Course A / Lecture A may recover only its exact authoritative session', () => {
  assert.deepEqual(discover([sessionA], [lectureA]), [sessionA]);
});

check('after Lecture A deletion, session A is not unfinished even though native audio remains recoverable', () => {
  const visibleActiveLectureIdsAfterLectureDelete = [];
  assert.deepEqual(discover([sessionA], visibleActiveLectureIdsAfterLectureDelete), []);
  assert.equal(sessionA.lectureId, lectureA);
  assert.equal(sessionA.segments[0].relativePath, 'segments/0001.m4a');
});

check('after Course A deletion, its still-existing Lecture A cannot revive session A through normal discovery', () => {
  // DataContext removes children of deleted courses from its active lecture view.
  const visibleActiveLectureIdsAfterCourseDelete = [];
  assert.deepEqual(discover([sessionA], visibleActiveLectureIdsAfterCourseDelete), []);
  assert.equal(courseA, 'course-a-historical');
});

check('new Course B / Lecture B is isolated: historical session A is neither offered nor adopted', () => {
  const offered = discover([sessionA], [lectureB]);
  assert.deepEqual(offered, []);
  assert.notEqual(lectureA, lectureB);
  assert.notEqual(courseA, courseB);
  assert.equal(sessionA.lectureId, lectureA, 'ownership metadata must remain historical A');
  assert.ok(!offered.some((session) => session.lectureId === lectureB));
});

check('a legitimate active Course B recovery still works and does not pull in historical session A', () => {
  const offered = discover([sessionA, sessionB], [lectureB]);
  assert.deepEqual(offered, [sessionB]);
  assert.equal(offered[0].lectureId, lectureB);
});

check('account isolation is enforced by the current account active-ID set, not by shared native-store presence', () => {
  const accountBActiveRecoveryLectureIds = [lectureB];
  assert.deepEqual(discover([sessionA, sessionB], accountBActiveRecoveryLectureIds), [sessionB]);
  assert.deepEqual(discover([sessionA], accountBActiveRecoveryLectureIds), []);
});

console.log(`deleted-recorder-ownership-isolation: ${passed} checks passed`);
