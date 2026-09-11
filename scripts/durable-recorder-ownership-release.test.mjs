/**
 * P0 — cross-lecture native recorder ownership: a paused session must never
 * permanently deadlock every OTHER in-progress lecture in the app.
 *
 * Real incident: four separate Hhh lectures each had their own real,
 * recoverable durable session (paused, validated committed segments) — but
 * only the FIRST one ever paused could be resumed. Every other one's
 * Resume/Finish failed with ERR_DURABLE_RECORDER_BUSY ("Another durable
 * recording session already owns the native recorder"), because
 * DurableForegroundRecorder.pauseRecording() never released
 * `ownedSessionId` — only Finish, discard, or a cold process relaunch did.
 * The owner's exact words: "I found your unfinished recording, but I
 * cannot let you continue it."
 *
 * The behavioral proof (paused owner released, active owner still blocks,
 * merely-`.ready` owner still blocks, Finish works across a paused owner,
 * four lectures cycling ownership without corrupting each other) lives in
 * durable-recorder-audio-core.test.swift (run via
 * durable-recorder-audio.test.mjs) — real compiled-and-executed Swift, not
 * source-pattern matching. This file covers the JS-facing pieces: the
 * distinct, actionable error message shown for the one conflict that must
 * still block (a GENUINELY active other session), following this repo's
 * established convention for native-behavioral code (see
 * durable-media-ownership.test.mjs and
 * checkpoint-rollover-identity-safety.test.mjs for the same constraint).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const nativeCore = await read('../modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift');
const nativeDurableHook = await read('../lib/recording/useNativeDurableLectureRecorder.ts');
const moduleIndex = await read('../modules/expo-durable-recorder/index.ts');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('native claim() — narrow, correct release scope');

check('currentOwnerIsSafeToRelease exists and treats ONLY paused/interrupted/idle/failed as releasable', () => {
  const idx = nativeCore.indexOf('private var currentOwnerIsSafeToRelease: Bool {');
  assert.ok(idx > -1, 'the shared release-eligibility check must exist');
  const block = nativeCore.slice(idx, idx + 500);
  assert.match(block, /case \.paused, \.interrupted, \.idle, \.failed:\s*\n\s*return true/);
  assert.match(block, /case \.preparing, \.ready, \.recording, \.pausing, \.resuming, \.stopping:\s*\n\s*return false/);
});

check('claim() releases a merely-paused/interrupted prior owner instead of always throwing recorderBusy', () => {
  const fn = nativeCore.slice(nativeCore.indexOf('private func claim(_ recordingSessionId: String) throws {'), nativeCore.indexOf('private func requireOwner'));
  assert.match(fn, /guard currentOwnerIsSafeToRelease else \{ throw DurableRecorderCoreError\.recorderBusy \}/);
  assert.match(fn, /releaseOwnership\(\)/);
});

check('claimForFinalization applies the SAME narrow release rule — Finish must also work across a merely-paused other owner', () => {
  const fn = nativeCore.slice(
    nativeCore.indexOf('private func claimForFinalization('),
    nativeCore.indexOf('private func clearActiveCapture'),
  );
  assert.match(fn, /guard currentOwnerIsSafeToRelease else \{ throw DurableRecorderCoreError\.recorderBusy \}/);
  assert.match(fn, /releaseOwnership\(\)/);
});

check('releaseOwnership never touches store/segment data — it is purely the in-memory ownership pointer', () => {
  const fn = nativeCore.slice(nativeCore.indexOf('private func releaseOwnership() {'), nativeCore.indexOf('private func publishStatus'));
  assert.doesNotMatch(fn, /store\.(commitSegment|transitionSession|deleteSession|abandonSession|reconcileSession)/);
  assert.match(fn, /ownedSessionId = nil/);
});

check('a genuinely active (.recording) owner is never silently released — recorderBusy is preserved for the one real conflict', () => {
  // Already proven behaviorally by testActiveOwnerStillBlocksDifferentSessionClaim
  // and testReadyOwnerStillBlocksDifferentSessionClaim in the compiled Swift
  // suite; this is a structural cross-check that .recording/.ready/.preparing
  // are explicitly excluded from the releasable case list (see the first
  // check above) — not re-asserted here to avoid duplicating that proof.
  assert.match(nativeCore, /case \.preparing, \.ready, \.recording, \.pausing, \.resuming, \.stopping:/);
});

console.log('\nJS — a genuinely-busy conflict gets a distinct, actionable message (the one case that still fails)');

check('isRecorderBusyError checks the DurableRecorderError code, not a fragile message-string match', () => {
  assert.match(nativeDurableHook, /function isRecorderBusyError\(failure: unknown\): boolean \{\s*\n\s*return failure instanceof DurableRecorderError && failure\.code === 'ERR_DURABLE_RECORDER_BUSY';/);
});

check('startRecording distinguishes a genuine ownership conflict from every other start failure', () => {
  const fn = nativeDurableHook.slice(nativeDurableHook.indexOf('const startRecording = useCallback'), nativeDurableHook.indexOf('const pauseRecording = useCallback'));
  assert.match(fn, /isRecorderBusyError\(failure\)\s*\n\s*\? 'Another recording is currently active\. Finish or pause it before starting a new one\.'\s*\n\s*: 'Could not start the recording\. Please try again\.'/);
});

check('resumeRecording distinguishes a genuine ownership conflict from every other resume failure', () => {
  const fn = nativeDurableHook.slice(nativeDurableHook.indexOf('const resumeRecording = useCallback'), nativeDurableHook.indexOf('const finishSession = useCallback'));
  assert.match(fn, /isRecorderBusyError\(failure\)\s*\n\s*\? 'Another recording is currently active\. Finish or pause it before resuming this one\.'\s*\n\s*: 'Could not resume the recording\.'/);
});

check('ERR_DURABLE_RECORDER_BUSY is a real, documented error code the native module actually bridges (code+message via Exception), not a made-up string', () => {
  assert.match(moduleIndex, /'ERR_DURABLE_RECORDER_BUSY'/);
  assert.match(moduleIndex, /class DurableRecorderError extends Error/);
  assert.match(moduleIndex, /readonly code: DurableRecorderErrorCode;/);
});

console.log(`\ndurable-recorder-ownership-release: ${passed} checks passed`);
