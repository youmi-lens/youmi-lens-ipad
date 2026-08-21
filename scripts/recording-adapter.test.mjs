import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_RECORDING_ENGINE,
  canFallbackBeforeNativeAudio,
  finalAssetIsComplete,
  finalizedDurationMillis,
  orderedSourceSegmentIds,
  recoverableSessionsForLecture,
  resolveRecordingEngineValue,
} from '../lib/recording/policy.mjs';

const segment = (sequence, id, durationMs = 1000) => ({ sequence, segmentId: id, durationMs });
const older = { recordingSessionId: 'b', lectureId: 'lecture-a', updatedAt: '2026-01-01T00:00:00Z', recoverable: true, segments: [segment(1, 's1')] };
const newer = { recordingSessionId: 'a', lectureId: 'lecture-a', updatedAt: '2026-01-02T00:00:00Z', recoverable: true, segments: [segment(1, 's2'), segment(2, 's3', 2500)] };

assert.equal(DEFAULT_RECORDING_ENGINE, 'legacy');
assert.equal(resolveRecordingEngineValue(undefined), 'legacy');
assert.equal(resolveRecordingEngineValue('unexpected'), 'legacy');
assert.equal(resolveRecordingEngineValue('nativeDurable'), 'nativeDurable');
assert.equal(resolveRecordingEngineValue('nativeDurable', true), 'legacy', 'guest/protected flows force legacy');
assert.deepEqual(recoverableSessionsForLecture([], 'lecture-a'), []);
assert.deepEqual(recoverableSessionsForLecture([older, { ...newer, lectureId: 'lecture-b' }], 'lecture-a'), [older]);
assert.deepEqual(recoverableSessionsForLecture([older, newer], 'lecture-a'), [newer, older]);
assert.deepEqual(recoverableSessionsForLecture([{ ...older, recoverable: false }], 'lecture-a'), []);
assert.equal(recoverableSessionsForLecture([{ ...older, recoverable: false, state: 'finalized', finalAsset: undefined }], 'lecture-a').length, 1, 'interrupted final export remains discoverable');
assert.deepEqual(
  recoverableSessionsForLecture([{ ...older, recoverable: false, state: 'finalized', handoffCompletedAt: '2026-01-03T00:00:00Z' }], 'lecture-a'),
  [],
  'acknowledged final output is not offered for recovery again',
);
assert.equal(finalizedDurationMillis(newer), 3500, 'paused wall time is not counted');
assert.deepEqual(orderedSourceSegmentIds({ segments: [segment(2, 'two'), segment(1, 'one')] }), ['one', 'two']);
assert.equal(canFallbackBeforeNativeAudio(null), true);
assert.equal(canFallbackBeforeNativeAudio({ segments: [] }), true);
assert.equal(canFallbackBeforeNativeAudio({ segments: [segment(1, 'audio')] }), false, 'native data forbids silent fallback');

const finalized = {
  state: 'finalized',
  segments: [segment(2, 'two'), segment(1, 'one')],
  finalAsset: {
    relativePath: 'final/lecture.m4a', durationMs: 2000, sourceSegmentIds: ['one', 'two'],
  },
};
assert.equal(finalAssetIsComplete(finalized), true);
assert.equal(finalAssetIsComplete({ ...finalized, finalAsset: { ...finalized.finalAsset, sourceSegmentIds: ['two', 'one'] } }), false);
assert.equal(finalAssetIsComplete({ ...finalized, finalAsset: undefined }), false, 'missing final asset is detected');

const [featureGate, facade, legacy, native, screen, appConfig] = await Promise.all([
  readFile(new URL('../lib/recording/featureGate.ts', import.meta.url), 'utf8'),
  readFile(new URL('../lib/useLectureRecorder.ts', import.meta.url), 'utf8'),
  readFile(new URL('../lib/recording/useLegacyLectureRecorder.ts', import.meta.url), 'utf8'),
  readFile(new URL('../lib/recording/useNativeDurableLectureRecorder.ts', import.meta.url), 'utf8'),
  readFile(new URL('../app/recording.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../app.json', import.meta.url), 'utf8'),
]);
assert.match(featureGate, /CONFIGURED_RECORDING_ENGINE[^=]*= 'legacy'/, 'committed gate defaults to legacy');
assert.match(facade, /useLegacyLectureRecorder/);
assert.match(facade, /useNativeDurableLectureRecorder/);
assert.match(legacy, /RecordingPresets\.HIGH_QUALITY/, 'legacy recording preset is unchanged');
assert.doesNotMatch(legacy, /createSession|listRecoverableSessions/, 'legacy never creates native sessions');
assert.match(native, /createSession\(\{ lectureId \}\)/, 'native session maps to one lecture ID');
assert.match(native, /pauseNative/);
assert.match(native, /resumeNative/);
assert.match(native, /session\.state === 'paused'[\s\S]*prepareRecording[\s\S]*startNative/, 'recovery can resume paused audio or safely start an empty prepared session');
assert.match(native, /exportFinalizedAsset/);
assert.match(native, /acknowledgeFinalAssetHandoff/);
assert.match(native, /recoverRecordingSession/);
assert.match(native, /incomplete_temporary_file/, 'an unfinalized crash artifact cannot be silently skipped');
assert.match(native, /addRecordingStatusListener/, 'native forced-pause status must reach the adapter');
assert.match(native, /evaluateNativeStatusUpdate/, 'status updates must be gated against stale/cross-session events');
assert.match(native, /abandonSession/);
assert.match(native, /deleteSession/);
assert.match(screen, /finishRecoverableRecording/);
assert.match(screen, /finishedRef\.current/, 'shared finish guard prevents duplicate completion');
assert.match(screen, /await acknowledgeFinalizedOutput\(\)/, 'native handoff is acknowledged after the lecture record is saved');
assert.match(screen, /ensureNativeProgressIdentity/, 'native start persists lecture identity before a process kill');
assert.match(screen, /if \(options\?\.recoverable\) autoStarted\.current = true/, 'recovery finish cannot race automatic recording');
assert.match(screen, /autoStarted\.current = true;\s+void discardRecoverableRecording\(\)/, 'recovery discard cannot race automatic recording');
assert.match(screen, /startCaptionPipeline/, 'caption path remains shared by both engines');
assert.match(appConfig, /"UIBackgroundModes"\s*:\s*\[\s*"audio"\s*\]/, 'the canonical Expo config declares the iOS audio background capability');
assert.match(appConfig, /"iosBackgroundMode": true/, 'iOS audio background capability is enabled for the next native build');

console.log('Recording adapter, feature-gate, and recovery policy tests passed.');
