/**
 * P0 — durable checkpoint rollover failure + recording identity safety.
 *
 * Real incident (2026-09-11, Dev iPad): a native durable checkpoint rollover
 * committed segment 3 (132.767s total across 3 validated segments) but the
 * subsequent beginSegment() for segment 4 failed while the app was deeply
 * backgrounded. DurableForegroundRecorder correctly transitioned the session
 * to paused/recoverable and preserved every committed segment — but nothing
 * distinguished this from an ordinary pause, so the owner had no clear
 * recovery signal. Separately, a later param-less /recording mount silently
 * created a brand-new, empty lecture+session (lecture_mtx1ql0u1o4uz,
 * duration 0, zero segments) rather than surfacing the original
 * (lecture_mtx193fwepczt, session 60812c57-...) for recovery — and Finishing
 * that empty session collapsed into the same generic "Could not finish the
 * recording." a real finalize failure would show.
 *
 * The native-behavioral proof (checkpoint commits, beginSegment fails,
 * session ends paused/recoverable with committed audio preserved, Resume
 * retries the SAME session, Finish still finalizes what's committed) lives
 * in durable-recorder-audio-core.test.swift (run via
 * durable-recorder-audio.test.mjs) — this file covers the JS-facing pieces:
 * pure policy math and structural wiring, following this repo's established
 * convention for code that needs a live device/React tree to fully execute
 * (see durable-media-ownership.test.mjs for the same constraint).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { finalizedDurationMillis, recoverableSessionsForLecture, unresolvedRecoverableSessions } from '../lib/recording/policy.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const recordingScreen = await read('../app/recording.tsx');
const nativeDurableHook = await read('../lib/recording/useNativeDurableLectureRecorder.ts');
const guardHook = await read('../lib/recording/useUnresolvedRecordingGuard.ts');
const legacyHook = await read('../lib/recording/useLegacyLectureRecorder.ts');
const facade = await read('../lib/useLectureRecorder.ts');
const types = await read('../lib/recording/types.ts');
const enLocale = await read('../lib/locales/en.mjs');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('unresolvedRecoverableSessions — pure policy math');

// Fixture reconstructing the real incident's shape (real ids kept ONLY in
// this test file, per this repo's convention — never in product code).
const originalSession = {
  lectureId: 'lecture_mtx193fwepczt',
  recordingSessionId: '60812c57-10ec-472c-86ea-893a1695199b',
  recoverable: true,
  state: 'paused',
  updatedAt: '2026-09-11T14:14:11.333Z',
  segments: [
    { sequence: 1, durationMs: 12700 },
    { sequence: 2, durationMs: 60045 },
    { sequence: 3, durationMs: 60022 },
  ],
};
const emptyNewSession = {
  lectureId: 'lecture_mtx1ql0u1o4uz',
  recordingSessionId: '28400069-ad3c-4434-8860-d0a76d48b63b',
  recoverable: true,
  state: 'created',
  updatedAt: '2026-09-11T14:23:21.759Z',
  segments: [],
};

check('the real incident\'s original session (3 validated segments) is found as an unresolved match, excluding the fresh empty lecture itself', () => {
  const matches = unresolvedRecoverableSessions([originalSession, emptyNewSession], emptyNewSession.lectureId);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].recordingSessionId, originalSession.recordingSessionId);
});

check('a zero-segment "created" session (abandoned at the permission prompt) is never treated as something to protect', () => {
  const matches = unresolvedRecoverableSessions([emptyNewSession], 'some-other-fresh-lecture');
  assert.equal(matches.length, 0, 'an empty, never-started session must not block a legitimate new recording');
});

check('a session belonging to the excluded (current) lectureId is never matched against itself', () => {
  const matches = unresolvedRecoverableSessions([originalSession], originalSession.lectureId);
  assert.equal(matches.length, 0);
});

check('a finalized session is never treated as unresolved, even if still recoverable is somehow set', () => {
  const finalized = { ...originalSession, state: 'finalized', recoverable: true };
  const matches = unresolvedRecoverableSessions([finalized], 'other-lecture');
  assert.equal(matches.length, 0);
});

check('two real, distinct unresolved sessions are BOTH returned — never silently picking one (ambiguity is the caller\'s job to detect via .length > 1)', () => {
  const second = { ...originalSession, lectureId: 'lecture-second', recordingSessionId: 'second-session-id', updatedAt: '2026-09-11T15:00:00.000Z' };
  const matches = unresolvedRecoverableSessions([originalSession, second], 'a-third-fresh-lecture');
  assert.equal(matches.length, 2, 'ambiguous case: both real candidates must surface, not just the newest');
});

console.log('\ntimer invariant — a 132s recoverable session can never rehydrate to 0');

check('finalizedDurationMillis on the real incident session sums to the exact byte-for-byte duration recorded on-device', () => {
  assert.equal(finalizedDurationMillis(originalSession), 132767);
});

check('recoverableSessionsForLecture, queried by the ORIGINAL lectureId, finds the real session and never the empty one', () => {
  const matches = recoverableSessionsForLecture([originalSession, emptyNewSession], originalSession.lectureId);
  assert.equal(matches.length, 1);
  assert.equal(finalizedDurationMillis(matches[0]), 132767, 'a correct reattachment must rehydrate the full preserved duration, never 0');
});

check('a session with zero segments always rehydrates to exactly 0 — proving the guard in finishSession (below) is checking the right thing', () => {
  assert.equal(finalizedDurationMillis(emptyNewSession), 0);
});

console.log('\nFIX A — checkpoint rollover failure surfaced distinguishably to JS');

check('useNativeDurableLectureRecorder exposes a degradedReason, set ONLY on a forced (never user-chosen) transition FROM recording into paused', () => {
  assert.match(nativeDurableHook, /const \[degradedReason, setDegradedReason\] = useState<string \| null>\(null\)/);
  const wasRecordingIdx = nativeDurableHook.indexOf('if (wasRecording) {');
  assert.ok(wasRecordingIdx > -1, 'the forced-pause branch must exist');
  const block = nativeDurableHook.slice(wasRecordingIdx, wasRecordingIdx + 1200);
  assert.match(block, /setDegradedReason\(status\.interruptionState \?\? status\.routeChangeState \?\? 'native_forced_pause'\)/);
});

check('an explicit user pause/resume/finish (applySession) always clears any stale degradedReason', () => {
  const applySessionFn = nativeDurableHook.slice(
    nativeDurableHook.indexOf('const applySession = useCallback'),
    nativeDurableHook.indexOf('const applyNativeStatus = useCallback'),
  );
  assert.match(applySessionFn, /setDegradedReason\(null\)/);
});

check('a successful Resume — including retrying the segment a checkpoint rollover failed to open — clears degradedReason', () => {
  const resumeFn = nativeDurableHook.slice(
    nativeDurableHook.indexOf('const resumeRecording = useCallback'),
    nativeDurableHook.indexOf('const finishSession = useCallback'),
  );
  assert.match(resumeFn, /setDegradedReason\(null\)/);
  // Resume on a paused session must call the native resume path (which
  // itself retries beginSegment on the SAME session — proven natively in
  // testResumeAfterFailedCheckpointRollover).
  assert.match(resumeFn, /session\.state === 'paused'\s*\n?\s*\? await resumeNative/);
});

check('the checkpoint-specific failure reuses the EXISTING error surface with a clear, distinct recovery message — no new UI', () => {
  assert.match(
    nativeDurableHook,
    /if \(status\.interruptionState === 'checkpoint_begin_segment_failed'\) \{\s*\n\s*fail\('Recording paused — tap Resume to continue\.', 'checkpoint_begin_segment_failed'\);/,
  );
  // A plain interruption/route-change forced pause is explicitly NOT given
  // this treatment — out of this P0's scope, left exactly as it behaved.
});

check('LectureRecorder exposes degradedReason as a documented, always-safe-to-show reason code (never raw native error text)', () => {
  assert.match(types, /degradedReason: string \| null;/);
});

check('the legacy engine (no forced-pause concept of its own) always returns degradedReason: null', () => {
  assert.match(legacyHook, /degradedReason: null,/);
});

check('the __DEV__ visual fixture also satisfies the LectureRecorder shape with degradedReason', () => {
  assert.match(facade, /degradedReason: null,/);
});

console.log('\nFIX B — UI must never claim "audio recording still alive" when native capture is actually paused');

check('the captions-unavailable copy is chosen from the CURRENT isRecording value at render time, not baked into stale caption-pipeline state', () => {
  const block = recordingScreen.slice(
    recordingScreen.indexOf("captionAreaState === 'captions_unavailable'"),
    recordingScreen.indexOf("captionAreaState === 'captions_unavailable'") + 1400,
  );
  assert.match(block, /isRecording\s*\n?\s*\? \(micStreamError \?\? liveCaptionError \?\? t\('recording\.captionsUnavailable'\)\)\s*\n?\s*: t\('recording\.captionsUnavailablePaused'\)/);
});

check('the paused-specific caption copy exists and does not claim recording is still active', () => {
  assert.match(enLocale, /'recording\.captionsUnavailablePaused': '[^']*'/);
  const [, value] = enLocale.match(/'recording\.captionsUnavailablePaused': '([^']*)'/);
  assert.doesNotMatch(value, /still active|still alive/i);
});

console.log('\nFIX C — a recoverable, unresolved durable session must never be silently orphaned by a fresh param-less recording');

check('the guard is only consulted for the param-less path — an explicit lectureId (isResume) is always authoritative and bypasses it entirely', () => {
  assert.match(recordingScreen, /useUnresolvedRecordingGuard\(!isResume && !isGuest && !visualFixture, pendingLectureId\)/);
});

check('exactly one real unresolved match redirects to it via the SAME existing /recording route with an explicit lectureId — reusing the existing recovery UI, not inventing a new one', () => {
  const effectBody = recordingScreen.slice(
    recordingScreen.indexOf('useEffect(() => {\n    if (isResume || isGuest || visualFixture) return;'),
    recordingScreen.indexOf('useEffect(() => {\n    if (isResume || isGuest || visualFixture) return;') + 1600,
  );
  assert.match(effectBody, /router\.replace\(\{ pathname: '\/recording', params: \{ lectureId: matchedLectureId \} \}\)/);
});

check('a matched lectureId is cross-checked against the local lecture record — never resurrecting a deleted or already-finished lecture by blind reattachment', () => {
  const effectBody = recordingScreen.slice(
    recordingScreen.indexOf('useEffect(() => {\n    if (isResume || isGuest || visualFixture) return;'),
    recordingScreen.indexOf('useEffect(() => {\n    if (isResume || isGuest || visualFixture) return;') + 1600,
  );
  assert.match(effectBody, /!matchedLecture\.deletedAt && matchedLecture\.status === 'in_progress'/);
});

check('ambiguous (more than one real unresolved session) blocks the fresh recording with a choice, never guessing', () => {
  const effectBody = recordingScreen.slice(
    recordingScreen.indexOf('useEffect(() => {\n    if (isResume || isGuest || visualFixture) return;'),
    recordingScreen.indexOf('useEffect(() => {\n    if (isResume || isGuest || visualFixture) return;') + 1600,
  );
  assert.match(effectBody, /unresolvedGuard\.ambiguous/);
  assert.match(effectBody, /Alert\.alert\(/);
  assert.match(effectBody, /router\.back\(\)/);
});

check('auto-start itself is gated on the guard resolving cleanly — it never fires while the lookup is in flight, nor when a match/ambiguity was found', () => {
  const autoStartEffect = recordingScreen.slice(
    recordingScreen.indexOf('// Begin recording automatically when the screen opens'),
    recordingScreen.indexOf('// Begin recording automatically when the screen opens') + 1800,
  );
  assert.match(
    autoStartEffect,
    /if \(!isResume && \(!unresolvedGuard\.checked \|\| unresolvedGuard\.singleMatch \|\| unresolvedGuard\.ambiguous\)\) return;/,
  );
});

check('the guard hook queries the durable store directly (native ground truth), never the persisted lecture list, and fails OPEN (never permanently blocks recording on a lookup hiccup)', () => {
  assert.match(guardHook, /listRecoverableSessions\(\)/);
  assert.match(guardHook, /unresolvedRecoverableSessions\(sessions, excludeLectureId\)/);
  const catchBlock = guardHook.slice(guardHook.indexOf('.catch('));
  assert.match(catchBlock, /setState\(\{ checked: true, singleMatch: null, ambiguous: false \}\)/);
});

console.log('\nFIX D — a genuinely empty (never-started) session must not collapse into the generic finish-failure message');

check('finishSession short-circuits ONLY when there are zero committed segments AND no active capture in flight (an actively-recording first segment still goes through the normal finalize path)', () => {
  const finishFn = nativeDurableHook.slice(
    nativeDurableHook.indexOf('const finishSession = useCallback'),
    nativeDurableHook.indexOf('const stopRecording = useCallback'),
  );
  assert.match(finishFn, /if \(session\.segments\.length === 0 && session\.state !== 'recording'\) \{/);
  assert.match(finishFn, /fail\('Nothing has been recorded yet\.', 'zero_segment_session'\)/);
  // Must return before ever calling the export path — never fabricate success.
  const guardIdx = finishFn.indexOf("session.state !== 'recording'");
  const exportIdx = finishFn.indexOf('finalizeAndExportDurableSession(');
  assert.ok(guardIdx > -1 && exportIdx > guardIdx, 'the zero-segment guard must run before any export attempt');
});

check('both Finish entry points (the live screen\'s stopRecording and the Recovery modal\'s finishRecoverableRecording) route through the same guarded finishSession — no separate, unguarded path', () => {
  assert.match(nativeDurableHook, /const stopRecording = useCallback\(async \(\) => \{\s*\n\s*const session = sessionRef\.current; return session \? finishSession\(session\) : null;/);
  assert.match(nativeDurableHook, /const finishRecoverableRecording = useCallback\(async \(\) => \{\s*\n\s*const session = recoverableSession; if \(!session\) return null;\s*\n\s*const uri = await finishSession\(session\);/);
});

console.log(`\ncheckpoint-rollover-identity-safety: ${passed} checks passed`);
