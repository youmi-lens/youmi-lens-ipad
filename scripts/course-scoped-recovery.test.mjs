/**
 * P0 (2026-09-12) — course-scoped unfinished-recording recovery, and the
 * "Start New Recording" hang this ticket's own physical repro surfaced.
 *
 * Two blocking defects on the same Start New Lecture / recovery flow:
 *
 * BUG A (course-scoping): useUnresolvedRecordingGuard was account-wide — an
 * unfinished recording in Course A blocked "Start New Lecture" in EVERY
 * course, including ones with no unfinished recording of their own. Proven
 * root cause: the guard never received a courseId at all, and neither
 * unresolvedRecoverableSessions nor classifyUnresolvedSessions (both pure,
 * in policy.mjs) ever considered course ownership — a native
 * `DurableRecordingSession` has no courseId of its own, only `lectureId`.
 *
 * BUG B ("Preparing microphone…" hang): after choosing "Start New
 * Recording" in the (correctly-shown) Resume/Start-New choice Alert, the
 * app entered the recording screen but never actually started recording.
 * Proven root cause: a SEPARATE auto-start effect in app/recording.tsx
 * (the one that calls `startRecording()`) still gated on the raw
 * `unresolvedGuard.singleMatch` truthiness — a value that stays a non-null
 * object FOREVER once a match is found, regardless of the owner's later
 * choice. The "Start New" choice only ever set `dismissedSingleMatchId`
 * (introduced by the PRIOR ticket's fix), which the auto-start effect never
 * looked at — so `startRecording()` was never invoked, `started` was never
 * set, `startFailed` never became true, and the UI sat at "Preparing
 * microphone…" indefinitely (audioActive stays false forever, and the
 * failed_start branch — which DOES clear this and show a real error — was
 * never reached because no failure ever occurred; nothing was ever tried).
 *
 * Device forensics (read-only pull) proved this precisely: no new native
 * session directory was ever created anywhere in
 * Library/Application Support/YoumiLens/DurableRecorder/sessions, and no
 * new lecture record ever landed in the account's youmi.lectures.v1.<uid>
 * AsyncStorage blob, for the entire "stuck at Preparing microphone" test
 * window — startRecording() was never called at all, not a native failure.
 *
 * The native ownership-release mechanism this fix depends on
 * (DurableForegroundRecorder.swift's `claim()`/`currentOwnerIsSafeToRelease`)
 * was already built by an EARLIER, separate ticket and is only verified
 * (not re-implemented) here — see the "Phase 4 already solved" section.
 */
/*
 * RC NOTE (release/rc-integration): the pure-policy checks below are the accepted P0 tests VERBATIM.
 * The WIRING checks were adapted to the integrated line's guard, which keeps its stricter exact-ID
 * ownership boundary (ownedUnresolvedRecoverableSessions over the current account's active in-progress
 * lectures) and layers course scoping on top of it. Provenance: docs/rc-provenance.md, group 2.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  classifyUnresolvedSessions, courseScopedUnresolvedSessions, ownedUnresolvedRecoverableSessions, unresolvedRecoverableSessions,
} from '../lib/recording/policy.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const recordingScreen = await read('../app/recording.tsx');
const guardHook = await read('../lib/recording/useUnresolvedRecordingGuard.ts');
const nativeRecorder = await read('../modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift');
const nativeDurableHook = await read('../lib/recording/useNativeDurableLectureRecorder.ts');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const session = (recordingSessionId, lectureId, overrides = {}) => ({
  recordingSessionId, lectureId, recoverable: true, state: 'paused',
  segments: [{ sequence: 1, durationMs: 1000 }],
  updatedAt: '2026-09-12T00:00:00.000Z',
  ...overrides,
});
const lecture = (id, courseId, overrides = {}) => ({ id, courseId, status: 'in_progress', deletedAt: null, ...overrides });
const lookupFrom = (activeLectures) => (lectureId) => {
  const l = activeLectures.find((x) => x.id === lectureId);
  return l ? { id: l.id, deletedAt: l.deletedAt, status: l.status } : undefined;
};

console.log('Pure policy — courseScopedUnresolvedSessions');

check('TEST 1/2 — same course, one unfinished: that one candidate is the single match', () => {
  const A1 = session('sess-A1', 'A1');
  const active = [lecture('A1', 'course-A')];
  const blocking = classifyUnresolvedSessions([A1], 'fresh-A2', lookupFrom(active));
  const scoped = courseScopedUnresolvedSessions(blocking, active, 'course-A');
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].recordingSessionId, 'sess-A1');
});

check('TEST 4/5/6 — cross course (including identical titles, distinct ids): Course A\'s unfinished recording has ZERO effect on Course B', () => {
  const A1 = session('sess-A1', 'A1');
  const active = [lecture('A1', 'course-A', { title: 'Hhh' })];
  const blocking = classifyUnresolvedSessions([A1], 'fresh-B1', lookupFrom(active));
  const scopedForB = courseScopedUnresolvedSessions(blocking, active, 'course-B');
  assert.equal(scopedForB.length, 0, 'Course A\'s unfinished recording must not block Course B, even with a same-name-course scenario');
});

check('TEST 5 — both courses have unfinished: only the current course\'s candidate is considered', () => {
  const A1 = session('sess-A1', 'A1');
  const B1 = session('sess-B1', 'B1');
  const active = [lecture('A1', 'course-A'), lecture('B1', 'course-B')];
  const blocking = classifyUnresolvedSessions([A1, B1], 'fresh-B2', lookupFrom(active));
  const scopedForB = courseScopedUnresolvedSessions(blocking, active, 'course-B');
  assert.equal(scopedForB.length, 1);
  assert.equal(scopedForB[0].recordingSessionId, 'sess-B1', 'A1 (a different course) must be irrelevant to Course B\'s action');
});

check('TEST 7 — deleted/finished lectures in the current course never block (already dropped by classifyUnresolvedSessions before course-scoping even runs)', () => {
  const A1 = session('sess-A1', 'A1');
  const deletedActive = [lecture('A1', 'course-A', { deletedAt: '2026-01-01T00:00:00.000Z' })];
  const blockingDeleted = classifyUnresolvedSessions([A1], 'fresh-A2', lookupFrom(deletedActive));
  assert.equal(blockingDeleted.length, 0);

  const finishedActive = [lecture('A1', 'course-A', { status: 'local_recorded' })];
  const blockingFinished = classifyUnresolvedSessions([A1], 'fresh-A2', lookupFrom(finishedActive));
  assert.equal(blockingFinished.length, 0);
});

check('TEST 8 — unknown/orphan ownership: preserved (never dropped from classification) but excluded from every course\'s check (never falsely attached, never globally hijacks)', () => {
  const orphan = session('sess-orphan', 'unknown-lecture-id');
  const active = [lecture('A1', 'course-A')];
  const blocking = classifyUnresolvedSessions([orphan], 'fresh-A2', lookupFrom(active));
  assert.equal(blocking.length, 1, 'classification alone must still protect an unproven candidate (UNKNOWN stays protected)');
  const scopedForA = courseScopedUnresolvedSessions(blocking, active, 'course-A');
  const scopedForB = courseScopedUnresolvedSessions(blocking, active, 'course-B');
  assert.equal(scopedForA.length, 0, 'must not be falsely attached to Course A just because it is the current course');
  assert.equal(scopedForB.length, 0, 'must not block Course B either — no global hijack');
});

check('TEST 4-variant — Course A has an unfinished recording; a course with none sees zero candidates regardless of how many OTHER courses have real unfinished recordings', () => {
  const many = [session('sess-A1', 'A1'), session('sess-C1', 'C1'), session('sess-D1', 'D1')];
  const active = [lecture('A1', 'course-A'), lecture('C1', 'course-C'), lecture('D1', 'course-D')];
  const blocking = classifyUnresolvedSessions(many, 'fresh-B1', lookupFrom(active));
  const scopedForB = courseScopedUnresolvedSessions(blocking, active, 'course-B');
  assert.equal(scopedForB.length, 0);
});

console.log('\nWiring — the hook receives and applies courseId');

check('useUnresolvedRecordingGuard takes the canonical courseId + active lectures and applies courseScopedUnresolvedSessions AFTER the ownership boundary', () => {
  assert.match(
    guardHook,
    /export function useUnresolvedRecordingGuard\(\s*\n\s*enabled: boolean,\s*\n\s*excludeLectureId: string,\s*\n\s*activeRecoveryLectureIds: readonly string\[\],\s*\n\s*courseId: string,\s*\n\s*activeLectures: readonly \{ id: string; courseId: string \}\[\],\s*\n\)/,
  );
  assert.match(guardHook, /const owned = ownedUnresolvedRecoverableSessions\(sessions, excludeLectureId, activeRecoveryLectureIds\);/);
  assert.match(guardHook, /const matches = courseScopedUnresolvedSessions\(owned, activeLecturesRef\.current, courseId\);/);
  assert.match(guardHook, /\}, \[enabled, excludeLectureId, activeRecoveryLectureIds, courseId\]\);/, 'the lookup re-runs only when the course changes, not on every lecture-list change');
});

check('recording.tsx passes the canonical currentCourseId (never title/name) into the guard', () => {
  assert.match(recordingScreen, /const currentCourseId = resumeLecture\?\.courseId \?\? params\.courseId \?\? '';/);
  assert.match(
    recordingScreen,
    /useUnresolvedRecordingGuard\(\s*\n\s*dataLoaded && !isResume && !isGuest && !visualFixture,\s*\n\s*pendingLectureId,\s*\n\s*activeRecoveryLectureIds,\s*\n\s*currentCourseId,\s*\n\s*lectures,\s*\n\s*\)/,
  );
});

console.log('\nRC — accepted behaviors through the REAL composed path (ownership boundary, then course scope)');
const guardPath = (sessions, activeLectures, courseId, excludeLectureId = 'fresh') => {
  const ownedIds = activeLectures.filter((l) => l.status === 'in_progress').map((l) => l.id); // exactly recording.tsx's activeRecoveryLectureIds
  return courseScopedUnresolvedSessions(ownedUnresolvedRecoverableSessions(sessions, excludeLectureId, ownedIds), activeLectures, courseId);
};
check('an unfinished recording in ANOTHER course never blocks Start New Recording here, and never triggers a cross-course prompt', () => {
  const active = [lecture('A1', 'course-A')];
  assert.equal(guardPath([session('sess-A1', 'A1')], active, 'course-B').length, 0);
});
check('the SAME course\'s unfinished recording is still found (accepted recovery behavior remains)', () => {
  const active = [lecture('A1', 'course-A')];
  const found = guardPath([session('sess-A1', 'A1')], active, 'course-A');
  assert.equal(found.length, 1); assert.equal(found[0].lectureId, 'A1');
});
check('two unfinished recordings in the same course are still ambiguous; one per course is not', () => {
  const active = [lecture('A1', 'course-A'), lecture('A2', 'course-A'), lecture('B1', 'course-B')];
  const sessions = [session('sess-A1', 'A1'), session('sess-A2', 'A2'), session('sess-B1', 'B1')];
  assert.equal(guardPath(sessions, active, 'course-A').length, 2);
  assert.equal(guardPath(sessions, active, 'course-B').length, 1);
});
check('sessions whose owner is deleted, already finished, from another account, or unknown never block ANY course (the 2026-09-11 false "Unfinished Recordings" incident)', () => {
  const activeVisible = [lecture('done1', 'course-A', { status: 'local_recorded' })]; // deleted/other-account lectures are not in the current account\'s view at all
  const sessions = [session('s-deleted', 'deleted-lecture'), session('s-finished', 'done1'), session('s-other-account', 'other-account-lecture'), session('s-unknown', 'never-seen')];
  for (const courseId of ['course-A', 'course-B', '']) assert.equal(guardPath(sessions, activeVisible, courseId).length, 0, courseId);
});
check('nothing here touches native sessions: candidates are only filtered, never deleted or mutated', () => {
  const sessions = [session('sess-A1', 'A1')];
  const snapshot = JSON.stringify(sessions);
  guardPath(sessions, [lecture('A1', 'course-A')], 'course-B');
  assert.equal(JSON.stringify(sessions), snapshot);
});

console.log('\nBUG B — the auto-start effect must respect the owner\'s Start-New choice, not the raw singleMatch object');

check('the auto-start effect gates on singleMatchPendingChoice, not unresolvedGuard.singleMatch directly — the exact stale condition that caused the infinite "Preparing microphone…" hang', () => {
  const effectStart = recordingScreen.indexOf('// Begin recording automatically when the screen opens');
  const effectBody = recordingScreen.slice(effectStart, effectStart + 2400);
  assert.match(
    effectBody,
    /if \(!isResume && \(!dataLoaded \|\| !unresolvedGuard\.checked \|\| singleMatchPendingChoice \|\| unresolvedGuard\.ambiguous\)\) return;/,
  );
  assert.doesNotMatch(
    effectBody,
    /if \(!isResume && \(!dataLoaded \|\| !unresolvedGuard\.checked \|\| unresolvedGuard\.singleMatch \|\| unresolvedGuard\.ambiguous\)\) return;/,
    'the OLD, buggy condition (checking singleMatch directly, ignoring the Start-New choice) must not still be present',
  );
  assert.match(effectBody, /singleMatchPendingChoice\]\);/, 'singleMatchPendingChoice must be a dependency so the effect re-evaluates the instant the owner dismisses the match');
});

check('TEST 3/9 — choosing Start New Recording never touches the old lecture: no delete/finish/merge call anywhere in the dismissal path', () => {
  const onPressIdx = recordingScreen.indexOf("onPress: () => setDismissedSingleMatchId(matchedLectureId)");
  assert.ok(onPressIdx > -1);
  const nearby = recordingScreen.slice(onPressIdx - 400, onPressIdx + 200);
  assert.doesNotMatch(nearby, /deleteLecture|finishSession|updateLecture\(matchedLectureId|abandonSession|deleteSession/);
});

console.log('\nTEST 9/10 — native ownership handoff (already built by an earlier ticket; verified here, not re-implemented)');

check('a merely inactive (paused/interrupted/idle/failed) owner is safely releasable; only a genuinely active one is a hard conflict — this is what makes Start New Recording able to claim the recorder while the OLD session stays untouched on disk', () => {
  const fn = nativeRecorder.slice(nativeRecorder.indexOf('private var currentOwnerIsSafeToRelease'), nativeRecorder.indexOf('private func claim('));
  assert.match(fn, /case \.paused, \.interrupted, \.idle, \.failed:\s*\n\s*return true/);
  assert.match(fn, /case \.preparing, \.ready, \.recording, \.pausing, \.resuming, \.stopping:\s*\n\s*return false/);
});

check('claim() releases a safely-releasable different owner in memory only, then claims — never touches store/segments/disk', () => {
  const fn = nativeRecorder.slice(nativeRecorder.indexOf('private func claim('), nativeRecorder.indexOf('private func requireOwner('));
  assert.match(fn, /guard currentOwnerIsSafeToRelease else \{ throw DurableRecorderCoreError\.recorderBusy \}/);
  assert.match(fn, /releaseOwnership\(\)/);
  assert.doesNotMatch(fn, /store\.(delete|finalize|abandon)/i);
});

check('prepareRecording calls claim() before transitioning state — the exact call path Start New Recording exercises once it is actually reached', () => {
  const fn = nativeRecorder.slice(nativeRecorder.indexOf('func prepareRecording('), nativeRecorder.indexOf('func startRecording(recordingSessionId'));
  assert.match(fn, /try claim\(recordingSessionId\)/);
});

check('TEST 10 — a genuinely active conflict surfaces as ERR_DURABLE_RECORDER_BUSY, mapped to an explicit, actionable message (not a silent failure or a stolen ownership)', () => {
  assert.match(nativeDurableHook, /function isRecorderBusyError\(failure: unknown\): boolean/);
  assert.match(nativeDurableHook, /'Another recording is currently active\. Finish or pause it before starting a new one\.'/);
});

console.log('\nTEST 11 — a failed start must never leave the UI stuck at "Preparing microphone…" forever');

check('a start failure sets startFailed, which the UI already renders as a distinct, actionable failed_start state with the real error and a Retry — this is what BUG B could never reach, because startRecording() was never even called', () => {
  const autoStartIdx = recordingScreen.indexOf('// Begin recording automatically when the screen opens');
  const autoStartBody = recordingScreen.slice(autoStartIdx, autoStartIdx + 2400);
  assert.match(autoStartBody, /setStartFailed\(!started\)/);
  assert.match(recordingScreen, /captionAreaState === 'failed_start'/);
  const failedStartBlock = recordingScreen.slice(
    recordingScreen.indexOf("captionAreaState === 'failed_start'"),
    recordingScreen.indexOf("captionAreaState === 'failed_start'") + 700,
  );
  assert.match(failedStartBlock, /\{error \?\? t\('recording\.couldNotStart'\)\}/);
  assert.match(failedStartBlock, /t\('recording\.retryStart'\)/);
});

console.log(`\ncourse-scoped-recovery: ${passed} checks passed`);
