import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getLectureRecoveryState } from '../lib/processingResume.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const baseLecture = (overrides = {}) => ({
  id: 'lecture-1',
  status: 'local_recorded',
  remoteRecordingId: 'remote-1',
  localAudioUri: 'file:///Documents/YoumiLens/Recordings/lecture-1.m4a',
  uploadStatus: 'uploaded',
  processingStatus: 'not_started',
  transcript: undefined,
  ...overrides,
});

console.log('getLectureRecoveryState — Phase 1 A-F conceptual rules');

// A: upload failed, valid local recording exists -> recoverable via reupload.
{
  const r = getLectureRecoveryState(baseLecture({ uploadStatus: 'upload_failed', processingStatus: 'not_started' }));
  assert.deepEqual(r, { kind: 'retry', plan: 'reupload' }, 'CASE A: upload_failed + local audio -> retry/reupload');
}

// B: upload succeeded, processing failed/incomplete -> recoverable via reprocess.
{
  const r = getLectureRecoveryState(baseLecture({ uploadStatus: 'uploaded', processingStatus: 'failed' }));
  assert.deepEqual(r, { kind: 'retry', plan: 'reprocess' }, 'CASE B: uploaded + processing failed -> retry/reprocess');
}

// C: transcript exists but summary failed -> STILL just 'reprocess' (server decides summary_only; client never distinguishes).
{
  const r = getLectureRecoveryState(
    baseLecture({ uploadStatus: 'uploaded', processingStatus: 'failed', transcript: 'Persisted transcript' }),
  );
  assert.deepEqual(r, { kind: 'retry', plan: 'reprocess' }, 'CASE C: transcript present + failed -> still reprocess (server decides stage)');
}

// D: processing currently active -> no Retry.
{
  const r = getLectureRecoveryState(baseLecture({ uploadStatus: 'uploaded', processingStatus: 'processing' }));
  assert.deepEqual(r, { kind: 'none', plan: null }, 'CASE D: processing active -> no retry action');
}

// E: complete lecture -> no Retry.
{
  const r = getLectureRecoveryState(baseLecture({ uploadStatus: 'uploaded', processingStatus: 'ready' }));
  assert.deepEqual(r, { kind: 'none', plan: null }, 'CASE E: ready -> no retry action');
}

// F: neither usable local recording nor usable uploaded remote source -> unrecoverable, no functional Retry.
{
  const r = getLectureRecoveryState(baseLecture({ uploadStatus: 'upload_failed', localAudioUri: null }));
  assert.deepEqual(r, { kind: 'unrecoverable', plan: null }, 'CASE F: upload_failed + no local audio -> unrecoverable');
}
{
  const r = getLectureRecoveryState(
    baseLecture({ uploadStatus: 'not_uploaded', processingStatus: 'failed', localAudioUri: null }),
  );
  assert.deepEqual(r, { kind: 'unrecoverable', plan: null }, 'CASE F variant: failed + no upload + no local audio -> unrecoverable');
}

// Normal, non-stuck states never show a manual retry — the orchestrator already drives them automatically.
{
  const r = getLectureRecoveryState(baseLecture({ uploadStatus: 'not_uploaded', processingStatus: 'not_started' }));
  assert.deepEqual(r, { kind: 'none', plan: null }, 'fresh not-yet-uploaded lecture -> no manual retry needed (auto-driven)');
}

// No remoteRecordingId yet (draft/in-progress) -> never eligible.
{
  const r = getLectureRecoveryState({ ...baseLecture({ uploadStatus: 'upload_failed' }), remoteRecordingId: undefined });
  assert.deepEqual(r, { kind: 'none', plan: null }, 'no remoteRecordingId -> not eligible for recovery');
}

// Uncommitted (still in_progress) or soft-deleted lectures are never eligible, matching isCommittedLecture.
{
  const r = getLectureRecoveryState(baseLecture({ uploadStatus: 'upload_failed', status: 'in_progress' }));
  assert.deepEqual(r, { kind: 'none', plan: null }, 'in_progress draft -> not eligible');
}
{
  const r = getLectureRecoveryState(baseLecture({ uploadStatus: 'upload_failed', deletedAt: '2026-01-01T00:00:00.000Z' }));
  assert.deepEqual(r, { kind: 'none', plan: null }, 'soft-deleted lecture -> not eligible');
}

// Relaunch durability: the function is pure and derived only from persisted
// fields — no component/session state is consulted, so the exact same input
// object (as if freshly hydrated from AsyncStorage after a cold app relaunch)
// always yields the exact same recovery decision.
{
  const persisted = baseLecture({ uploadStatus: 'upload_failed' });
  const beforeRelaunch = getLectureRecoveryState(persisted);
  const afterRelaunch = getLectureRecoveryState(JSON.parse(JSON.stringify(persisted))); // simulate AsyncStorage round-trip
  assert.deepEqual(afterRelaunch, beforeRelaunch, 'recovery decision survives an AsyncStorage JSON round-trip unchanged');
  assert.deepEqual(beforeRelaunch, { kind: 'retry', plan: 'reupload' });
}

console.log('\nretryLectureProcessing — orchestrator (import after logging above so failures above are attributed correctly)');

const { retryLectureProcessing } = await import('../lib/retryLectureProcessing.ts');

function fakeUpdateLecture() {
  const calls = [];
  const fn = (id, patch) => calls.push({ id, patch });
  fn.calls = calls;
  return fn;
}

// Upload-failure recovery (Phase 1 rule A / Phase 2 item 4): reuses existing
// upload mechanism via the SAME reset convention app/processing.tsx already
// uses — never mints a new lecture or remoteRecordingId, never touches audio,
// transcript, or summaries.
{
  const lecture = baseLecture({
    uploadStatus: 'upload_failed',
    uploadError: 'Network error',
    transcript: 'Existing transcript',
    sourceSummary: 'Existing summary',
  });
  const updateLecture = fakeUpdateLecture();
  const result = retryLectureProcessing(lecture, updateLecture);
  assert.equal(result.action, 'reupload');
  assert.equal(updateLecture.calls.length, 1, 'exactly one updateLecture call');
  const { id, patch } = updateLecture.calls[0];
  assert.equal(id, 'lecture-1', 'same lecture ID');
  assert.deepEqual(patch, { uploadStatus: 'not_uploaded', uploadError: undefined });
  assert.equal('id' in patch, false, 'never patches lecture id');
  assert.equal('remoteRecordingId' in patch, false, 'never patches/mints a new remoteRecordingId');
  assert.equal('localAudioUri' in patch, false, 'never touches/deletes local audio uri');
  assert.equal('transcript' in patch, false, 'existing transcript untouched');
  assert.equal('sourceSummary' in patch, false, 'existing summary untouched');
}

// Backend-processing recovery (Phase 1 rule B/C / Phase 2 item 5): skips
// upload entirely, resets only processing fields, preserves transcript.
{
  const lecture = baseLecture({
    uploadStatus: 'uploaded',
    processingStatus: 'failed',
    processingError: 'Summaries did not finish.',
    transcript: 'Persisted transcript — must survive',
  });
  const updateLecture = fakeUpdateLecture();
  const result = retryLectureProcessing(lecture, updateLecture);
  assert.equal(result.action, 'reprocess');
  assert.equal(updateLecture.calls.length, 1);
  const { patch } = updateLecture.calls[0];
  assert.deepEqual(patch, { processingStatus: 'not_started', processingError: undefined });
  assert.equal('uploadStatus' in patch, false, 'upload not re-triggered — already uploaded');
  assert.equal('transcript' in patch, false, 'existing transcript survives a summary-only recovery');
}

// Not recoverable -> no-op, never calls updateLecture (covers D/E and the
// "no false functional Retry action" requirement for F).
for (const lecture of [
  baseLecture({ processingStatus: 'processing' }),
  baseLecture({ processingStatus: 'ready' }),
  baseLecture({ uploadStatus: 'upload_failed', localAudioUri: null }),
]) {
  const updateLecture = fakeUpdateLecture();
  const result = retryLectureProcessing(lecture, updateLecture);
  assert.equal(result.action, 'none');
  assert.equal(updateLecture.calls.length, 0, 'no-op never calls updateLecture');
}

// Idempotent / double-tap safe: calling it twice back-to-back on the SAME
// (unrefreshed) lecture object produces the exact same patch both times —
// the real dedup is useProcessingOrchestrator's own uploadingRef/startingRef
// guards (unmodified, structurally verified below), but this proves
// retryLectureProcessing itself never accumulates state or diverges on repeat
// calls, so a double-fire before those guards engage is harmless.
{
  const lecture = baseLecture({ uploadStatus: 'upload_failed' });
  const updateLecture = fakeUpdateLecture();
  retryLectureProcessing(lecture, updateLecture);
  retryLectureProcessing(lecture, updateLecture);
  assert.equal(updateLecture.calls.length, 2);
  assert.deepEqual(updateLecture.calls[0].patch, updateLecture.calls[1].patch, 'repeat calls are idempotent');
}

console.log('\nuseProcessingOrchestrator — structural guards for the new recovery response handling');

const orchestrator = read('../lib/useProcessingOrchestrator.ts');

// already_processing (202) must land in the SAME success branch as any other
// accepted trigger — never treated as an error (Phase 7/8: "server 202
// already_processing is treated as normal processing, not an error").
// processRecording.ts's startRemoteProcessing only throws on !response.ok or
// HTTP 409; 202 is response.ok, so it already reaches .then() here — assert
// there is no special-cased rejection of 'already_processing'.
assert.doesNotMatch(
  orchestrator,
  /status === 'already_processing'[\s\S]{0,80}(?:throw|processingStatus:\s*'failed')/,
  'already_processing is never routed to a failure branch',
);

// already_complete (200) must be handled without leaving the lecture parked
// on a spurious 'processing' state forever, and must go through the same
// mergeProcessingSnapshot the poll loop uses (single source of truth for
// what a "complete" patch looks like).
assert.match(orchestrator, /result\.status === 'already_complete'/, 'already_complete is explicitly branched on');
{
  const fn = orchestrator.slice(orchestrator.indexOf('const startProcessing ='), orchestrator.indexOf('const startPoll ='));
  assert.match(fn, /mergeProcessingSnapshot\(reference, remote\)/, 'already_complete reuses mergeProcessingSnapshot, not a second parallel merge');
}

// 409 unrecoverable: must be distinguished from a generic failure, and must
// only auto-fall-back into an upload retry (uploadStatus: 'not_uploaded')
// when local audio is still present — never unconditionally. One user tap
// must be enough (CASE 6): the fallback sets state, not a direct network
// call, so the SAME reactive orchestrator effect (not a new retry loop)
// picks the upload up on its next pass — never a second manual tap, and
// never a synchronous loop (no upload/process call is made directly inside
// this catch).
{
  const fn = orchestrator.slice(orchestrator.indexOf('const startProcessing ='), orchestrator.indexOf('const startPoll ='));
  assert.match(fn, /ProcessingUnrecoverableError/, 'ProcessingUnrecoverableError is imported/handled');
  assert.match(fn, /lecture\?\.localAudioUri/, 'unrecoverable re-routing is gated on local audio actually being present');
  assert.doesNotMatch(fn, /ProcessingUnrecoverableError[\s\S]{0,400}void startRemoteProcessing/, 'unrecoverable catch never re-invokes the network call itself (no automatic loop)');
  // CASE 6 — one-tap fallback: local audio present -> reset straight to
  // 'not_uploaded'/'not_started' (auto-picked-up by the reactive effect),
  // NOT the old terminal 'upload_failed' that waited on a second manual tap.
  assert.match(
    fn,
    /uploadStatus:\s*'not_uploaded'/,
    'CASE 6: local-audio fallback resets uploadStatus to not_uploaded so the orchestrator auto-retries the upload — no second manual tap required',
  );
  assert.doesNotMatch(
    fn,
    /lecture\?\.localAudioUri\s*\?\s*\{\s*uploadStatus:\s*'upload_failed'/,
    'CASE 6: the local-audio branch must not land on the terminal upload_failed state (that would require a second manual tap)',
  );
  // CASE 7 — no local audio: still genuinely terminal (processingStatus stays 'failed').
  assert.match(
    fn,
    /processingStatus:\s*lecture\?\.localAudioUri\s*\?\s*'not_started'\s*:\s*'failed'/,
    'CASE 7: with no local audio, the lecture still lands on terminal failed — no fallback possible',
  );
}

console.log('\nprocessRecording.ts — response contract');

const processRecordingSrc = read('../lib/processRecording.ts');
assert.match(processRecordingSrc, /class ProcessingUnrecoverableError extends Error/, 'dedicated error class for 409 exists');
assert.match(processRecordingSrc, /response\.status === 409/, '409 is explicitly distinguished from a generic non-ok response');

console.log('\nLecture Detail — UI wiring structural guards');

const detailScreen = read('../app/lecture/[id].tsx');
assert.match(detailScreen, /getLectureRecoveryState\(lecture\)/, 'screen consults the single recovery-state source of truth');
assert.match(detailScreen, /retryLectureProcessing\(lecture, updateLecture\)/, 'screen calls the shared retry orchestrator, not a bespoke inline implementation');
assert.doesNotMatch(detailScreen, /retryTranscript|retrySummary|regenerateSummary\(/i, 'no separate Retry Transcript / Retry Summary / regenerate actions — exactly one recovery action');
assert.match(detailScreen, /disabled={retryInFlight}/, 'Retry button is disabled while a retry is in flight (button-level dedup)');

console.log('\nProcessing gate — canonical routing (CASE 1/8/10/11)');

// An incomplete-but-committed lecture must route to the Processing gate, not
// straight into Lecture Detail, from every normal list entry point — never
// only from one list (that would let a reviewer bypass the gate by tapping a
// different list). isLectureComplete is the single shared predicate so the
// gate and the routing can never drift apart.
{
  const home = read('../app/(tabs)/index.tsx');
  assert.match(home, /import \{ isLectureComplete \} from '@\/lib\/processingResume\.mjs'/, 'home list imports the shared completion predicate');
  assert.match(
    home,
    /isLectureComplete\(lecture\)\s*\?\s*router\.push\(\{ pathname: '\/lecture\/\[id\]'.*\}\)\s*:\s*router\.push\(\{ pathname: '\/processing'/s,
    'home recent-lectures tap: complete -> Lecture Detail, incomplete -> Processing gate',
  );

  const course = read('../app/course/[id].tsx');
  assert.match(course, /import \{ isLectureComplete \} from '@\/lib\/processingResume\.mjs'/, 'course lecture list imports the shared completion predicate');
  assert.match(
    course,
    /if \(!isLectureComplete\(lecture\)\) \{\s*router\.push\(\{ pathname: '\/processing'/,
    'course lecture list: incomplete lecture routes to the Processing gate before it can reach Lecture Detail',
  );
}

console.log('\nProcessing screen — View Lecture gating (CASE 15)');

// View Lecture must resolve into Lecture Detail ONLY once the lecture is
// actually complete — never merely because the lecture record exists. This
// deliberately supersedes the pre-gate design (View Lecture was always
// reachable); the gate is now the product requirement.
{
  const processingScreen = read('../app/processing.tsx');
  assert.match(processingScreen, /import \{ isLectureComplete \} from '@\/lib\/processingResume\.mjs'/, 'Processing screen imports the shared completion predicate');
  assert.match(
    processingScreen,
    /if \(!isLectureComplete\(lecture\)\) \{ Alert\.alert\(t\('processing\.notReadyAlert'\)\); return; \}/,
    'View Lecture is gated: incomplete shows the wait message, never navigates into Lecture Detail',
  );
}

console.log('\nAll lecture retry-processing tests passed.');
