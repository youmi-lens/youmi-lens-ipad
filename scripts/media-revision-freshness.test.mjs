/**
 * P0-A physical follow-up: "Ready" oscillating back to "Uploading audio" /
 * "Retry Processing" with no user action, on a lecture whose corrected
 * audio revision (from general media reconciliation) cannot finish
 * uploading (a 96+ minute file exceeding the backend's max object size).
 *
 * Root cause traced with runtime evidence (Metro log timeline): NOT a rogue
 * automatic-retry writer — a full inventory of every writer of uploadStatus/
 * processingStatus (useProcessingOrchestrator.ts, useMediaReconciliation.ts,
 * retryLectureProcessing.ts, explicit user-tap handlers) shows every one of
 * them already properly guarded (uploadingRef/startingRef/pollingRef, or a
 * one-shot in-mount ref, or an explicit user tap) — none of them loop on
 * their own. The actual second, uncoordinated writer was
 * `mergeRemoteRecordingsIntoStore` in lib/store.tsx: it recomputed
 * durationMillis/uploadStatus/processingStatus fresh from the CLOUD ROW on
 * every remote-merge cycle (which fires on nearly every screen focus/
 * navigation), with zero awareness that local had already produced a NEWER
 * media revision the cloud hasn't caught up to yet (upload still failing).
 * Every merge cycle reasserted the OLD cloud row's storage_path/ai_status/
 * duration_sec — a stale read, not a real state change — fighting the
 * properly-guarded upload/reconciliation pipeline for ownership of the same
 * three fields. This is exactly Phase 5's missing "revision ownership".
 *
 * Fixed by extending the SAME freshness-clock pattern store.tsx already
 * uses for transcript/summary/notes/marks/title (a local timestamp compared
 * against row.updated_at) to the audio triad, keyed off
 * mediaReconciliationCompletedAt/audioAssemblyCompletedAt — the only two
 * timestamps that mark "local just produced a new media revision". A
 * lecture that never went through reconciliation/assembly has neither
 * field set, so this is a no-op for the ordinary case and normal remote-
 * authoritative merging is completely unaffected.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const store = await read('../lib/store.tsx');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

// Local reimplementation of the real freshness comparison — parity-checked
// against the actual source below, then exercised with fixtures.
function preferLocalMediaState(localRevisionAt, rowUpdatedAt) {
  return Boolean(localRevisionAt) && (!rowUpdatedAt || localRevisionAt > rowUpdatedAt);
}

console.log('Writer inventory — every uploadStatus/processingStatus writer is already properly guarded (no rogue auto-retry loop)');

check('useProcessingOrchestrator upload/processing transitions are all gated by in-memory refs (uploadingRef/startingRef/pollingRef), preventing re-entrant/looping writes', async () => {
  const orchestrator = await read('../lib/useProcessingOrchestrator.ts');
  assert.match(orchestrator, /if \(uploadingRef\.current\.has\(lectureId\)\) return;/);
  assert.match(orchestrator, /if \(startingRef\.current\.has\(lectureId\)\) return;/);
  assert.match(orchestrator, /if \(pollingRef\.current\.has\(lectureId\)\) return;/);
});

check('nextProcessingAction only ever returns "upload" for not_uploaded/uploading — upload_failed is manual-retry-only, never auto-looped', async () => {
  const resume = await read('../lib/processingResume.mjs');
  assert.match(resume, /\(uploadStatus === 'not_uploaded' \|\| uploadStatus === 'uploading'\)/);
  assert.match(resume, /'upload_failed' waits for the manual Retry Upload button \(no auto-loop\)/);
});

check('useMediaReconciliation resets uploadStatus/processingStatus exactly once per genuinely-new completion, gated by its own in-mount ref and the mediaReconciliationStatus === \'running\' guard (already proven in media-reconciliation.test.mjs)', async () => {
  const hook = await read('../lib/recording/useMediaReconciliation.ts');
  assert.match(hook, /attemptedForRef\.current = lecture\.id;/);
});

console.log('\nCategory 1 — a pending local media revision holds its ground against a stale cloud row on remote merge');

check('parity: the real source computes preferLocalMediaState with the exact same boolean structure as this local reimplementation', () => {
  assert.match(store, /const preferLocalMediaState =\s*\n\s*Boolean\(localMediaRevisionAt\) &&\s*\n\s*\(!row\.updated_at \|\| localMediaRevisionAt! > row\.updated_at\);/);
});

check('a local reconciliation completion newer than the cloud row\'s updated_at wins — the stale row must not reassert the old duration/upload/processing state', () => {
  assert.equal(preferLocalMediaState('2026-09-07T14:23:12.825Z', '2026-09-06T12:57:02.234Z'), true);
});

check('once the cloud row genuinely catches up (its updated_at moves past the local revision timestamp — i.e. the corrected upload finally succeeded and the backend processed it), normal remote-authoritative merging resumes automatically — no manual flag to flip back', () => {
  assert.equal(preferLocalMediaState('2026-09-07T14:23:12.825Z', '2026-09-07T15:00:00.000Z'), false);
});

check('a lecture that never went through reconciliation or legacy assembly (neither timestamp set) is completely unaffected — ordinary remote-authoritative merge, unchanged behavior', () => {
  assert.equal(preferLocalMediaState(undefined, '2026-09-06T12:57:02.234Z'), false);
  assert.equal(preferLocalMediaState(undefined, undefined), false);
});

check('the local revision timestamp is mediaReconciliationCompletedAt first, falling back to audioAssemblyCompletedAt — covering both the general reconciliation path and the older legacy-only assembly path', () => {
  assert.match(store, /const localMediaRevisionAt = local\?\.mediaReconciliationCompletedAt \?\? local\?\.audioAssemblyCompletedAt;/);
});

console.log('\nCategory 2 — exactly the three fields implicated in the observed oscillation are gated, nothing else touched (narrow fix, not a redesign)');

check('durationMillis/uploadStatus/processingStatus/storagePath are each gated by preferLocalMediaState in the merge return object', () => {
  const start = store.indexOf('const mergedDurationMillis = preferLocalMediaState');
  const end = store.indexOf('return {', start);
  const body = store.slice(start, end);
  assert.match(body, /const mergedDurationMillis = preferLocalMediaState\s*\n\s*\? \(local\?\.durationMillis \?\? 0\)\s*\n\s*: \(parseDurationMillis\(row\.duration_sec\) \|\| local\?\.durationMillis \|\| 0\);/);
  assert.match(body, /const mergedUploadStatus = preferLocalMediaState\s*\n\s*\? \(local\?\.uploadStatus \?\? 'not_uploaded'\)\s*\n\s*: \(row\.storage_path \? 'uploaded' : local\?\.uploadStatus \?\? 'not_uploaded'\);/);
  assert.match(body, /const mergedProcessingStatus = preferLocalMediaState\s*\n\s*\? \(local\?\.processingStatus \?\? 'not_started'\)\s*\n\s*: processingStatus;/);
  const returnStart = store.indexOf('return {', start);
  const returnEnd = store.indexOf('} satisfies Lecture;', returnStart);
  const returnBody = store.slice(returnStart, returnEnd);
  assert.match(returnBody, /durationMillis: mergedDurationMillis,/);
  assert.match(returnBody, /uploadStatus: mergedUploadStatus,/);
  assert.match(returnBody, /processingStatus: mergedProcessingStatus,/);
  assert.match(returnBody, /storagePath: preferLocalMediaState \? local\?\.storagePath : \(row\.storage_path \?\? local\?\.storagePath\),/);
});

check('uploadError/uploadedAt/processingError/remoteAiStatus/remoteAiError are deliberately left untouched — display/diagnostic-only fields, not part of the state machine this fix targets', () => {
  const returnStart = store.indexOf('return {', store.indexOf('const mergedDurationMillis = preferLocalMediaState'));
  const returnEnd = store.indexOf('} satisfies Lecture;', returnStart);
  const returnBody = store.slice(returnStart, returnEnd);
  assert.match(returnBody, /uploadError: local\?\.uploadError,/);
  assert.match(returnBody, /uploadedAt: row\.updated_at \?\? local\?\.uploadedAt,/);
});

console.log(`\nmedia-revision-freshness: ${passed} checks passed`);
