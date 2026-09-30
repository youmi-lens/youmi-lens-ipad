/**
 * P0-C (production session d184e93f / lecture_muo90g0p4haa0): actual recorded audio was 2,099,056 ms (34:59) but the
 * lecture was saved as 6,007,860 ms (1:40:07).
 *
 * Proven mechanism: the JS recorder timer is `baseDurationRef + (Date.now() - activeStartedAtRef)` while `isRecording`.
 * Successful checkpoint rollovers are deliberately invisible to JS and the timer is wall-clock, so it keeps counting
 * while native capture is stopped (here: Finish had already finalized the session) and while the app is suspended. The
 * 6,007,860 value is exactly `finalizedDurationMillis(19 committed segments) = 1,140,257` plus the wall-clock since the
 * last Resume (15:50:48.614Z) evaluated at 17:11:56.2Z — the instant the suspended app's JS resumed. The screen's
 * autosave persisted it (store.saveInProgressLecture is `Math.max(existing, input)`, so it can only grow) and Finish saved
 * `Math.max(existing.durationMillis, finalDuration)`, which preserved it.
 *
 * Contract after the fix: the durable engine's final lecture duration comes ONLY from the durable audio (final asset
 * duration, else committed-segment sum). Wall-clock timers, pauses, gaps and previously autosaved values never widen it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { finalizedDurationMillis, resolveFinalLectureDurationMillis } from '../lib/recording/policy.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

console.log('Final lecture duration authority (P0-C)');

// The exact production numbers.
const PROD = {
  finalAssetMs: 2_099_056,
  committedMs: 2_099_054,
  staleAutosaveMs: 6_007_860,
  jsTimerAtTapMs: 2_100_257,
};

check('durable engine: final duration equals the final asset duration, not a larger autosaved/timer value', () => {
  assert.equal(resolveFinalLectureDurationMillis({
    engine: 'nativeDurable',
    finalAssetDurationMs: PROD.finalAssetMs,
    committedDurationMs: PROD.committedMs,
    existingDurationMs: PROD.staleAutosaveMs,
    sessionDurationMs: PROD.staleAutosaveMs,
  }), PROD.finalAssetMs);
});

check('the production incident value can never be selected for the durable engine', () => {
  const result = resolveFinalLectureDurationMillis({
    engine: 'nativeDurable', finalAssetDurationMs: PROD.finalAssetMs, existingDurationMs: PROD.staleAutosaveMs,
    sessionDurationMs: PROD.staleAutosaveMs,
  });
  assert.notEqual(result, PROD.staleAutosaveMs);
  assert.ok(result < 2_100_000);
});

check('wall-clock gap / pause time (elapsed 3,002,298 ms vs 2,099,054 ms of audio) is not included', () => {
  const wallElapsedMs = 3_002_298;
  const gapsMs = 901_500;
  assert.equal(wallElapsedMs - gapsMs > 0, true);
  assert.equal(resolveFinalLectureDurationMillis({
    engine: 'nativeDurable', finalAssetDurationMs: PROD.committedMs, existingDurationMs: 0, sessionDurationMs: wallElapsedMs,
  }), PROD.committedMs);
});

check('explicit Pause/Resume: duration is the sum of committed segments (audio only), not elapsed wall time', () => {
  // 3 segments of ~60 s, a 10 minute explicit pause between seg 1 and 2.
  const session = { segments: [{ durationMs: 60_022 }, { durationMs: 60_045 }, { durationMs: 12_300 }] };
  const committed = finalizedDurationMillis(session);
  assert.equal(committed, 132_367);
  const wallWithPause = committed + 600_000;
  assert.equal(resolveFinalLectureDurationMillis({
    engine: 'nativeDurable', finalAssetDurationMs: null, committedDurationMs: committed, existingDurationMs: wallWithPause,
    sessionDurationMs: wallWithPause,
  }), 132_367);
});

check('falls back to committed segments, then to the session value, only when the final asset duration is unavailable', () => {
  assert.equal(resolveFinalLectureDurationMillis({ engine: 'nativeDurable', finalAssetDurationMs: 0, committedDurationMs: 77_000, sessionDurationMs: 99_000 }), 77_000);
  assert.equal(resolveFinalLectureDurationMillis({ engine: 'nativeDurable', finalAssetDurationMs: null, committedDurationMs: null, sessionDurationMs: 99_000 }), 99_000);
  assert.equal(resolveFinalLectureDurationMillis({ engine: 'nativeDurable', finalAssetDurationMs: Number.NaN, committedDurationMs: undefined, sessionDurationMs: -5 }), 0);
});

check('legacy engine keeps its existing monotonic rule', () => {
  assert.equal(resolveFinalLectureDurationMillis({ engine: 'legacy', existingDurationMs: 500_000, sessionDurationMs: 300_000 }), 500_000);
  assert.equal(resolveFinalLectureDurationMillis({ engine: 'legacy', existingDurationMs: 100_000, sessionDurationMs: 300_000 }), 300_000);
});

check('the production timer formula reproduces the incident value (documents the proven mechanism)', () => {
  // Sum of committed segments 1..19 (manifest of session d184e93f) at the moment of the last Resume.
  const resumeAt = Date.parse('2026-09-30T15:50:48.614Z');
  const tickAt = Date.parse('2026-09-30T17:11:56.217Z');
  const timer = 1_140_257 + (tickAt - resumeAt);
  assert.equal(timer, PROD.staleAutosaveMs);
});

const recordingScreen = read('../app/recording.tsx');
const hook = read('../lib/recording/useNativeDurableLectureRecorder.ts');
const types = read('../lib/recording/types.ts');

check('Finish derives the saved duration from resolveFinalLectureDurationMillis using the native final asset duration', () => {
  assert.match(recordingScreen, /resolveFinalLectureDurationMillis\(\{/);
  assert.match(recordingScreen, /finalAssetDurationMs: getFinalAudioDurationMillis\?\.\(\) \?\? null/);
  assert.doesNotMatch(
    recordingScreen.slice(recordingScreen.indexOf('const rawFinalAudio'), recordingScreen.indexOf('const currentLinks = materialLinksForLecture(pendingLectureId);\n    const currentAnnotations = materialAnnotations.filter(\n      (annotation) => annotation.lectureId === pendingLectureId && !annotation.deletedAt,\n    );\n    const meaningful')),
    /const savedDuration = Math\.max\(existing\?\.durationMillis/,
    'the durable engine must not widen the final duration with the previously autosaved value',
  );
});

check('the durable hook exposes the final asset duration and records it only on a successful Finish', () => {
  assert.match(types, /getFinalAudioDurationMillis\?: \(\) => number \| null;/);
  assert.match(hook, /finalAssetDurationMillisRef\.current = result\.durationMs;/);
  assert.match(hook, /getFinalAudioDurationMillis: \(\) => finalAssetDurationMillisRef\.current,/);
  assert.match(hook, /finalAssetDurationMillisRef\.current = null;\s*\n\s*const result = await finalizeAndExportDurableSession/);
});

check('a failed Finish reconciles JS with the native session so the wall-clock timer stops counting', () => {
  const failure = hook.slice(hook.indexOf('if (!result.ok) {'), hook.indexOf('finalAssetDurationMillisRef.current = result.durationMs;'));
  assert.match(failure, /await getSession\(session\.recordingSessionId\)/);
  assert.match(failure, /latest\.state !== 'recording'/);
  assert.match(failure, /applySession\(latest\); activeRef\.current = false; setIsRecording\(false\); setIsPaused\(true\);/);
  assert.match(failure, /fail\('Could not finish the recording\.', result\.error\);/);
});

console.log(`Final lecture duration authority tests passed (${passed}).`);
