/**
 * Client processing poll-timeout must never mean "backend job failed."
 *
 * Real production incident (2026-09-24, lecture 9ca64d1f-1b5e-4dc2-a7cf-9c76ebe1db7b,
 * 38m41s recording): the backend legitimately took 6m14s (attempt 1) and 5m33s
 * (attempt 2) just to transcribe — both longer than the poller's old fixed
 * budget, MAX_POLL_ATTEMPTS(80) * POLL_INTERVAL_MS(3000) = 4 minutes. The old
 * poll loop wrote `processingStatus: 'failed'` + "Processing is taking longer
 * than expected. Please retry in a moment." directly from elapsed attempt
 * count, with NO backend input — turning a healthy, still-running job into a
 * false, terminal failure and offering a Retry button that could resubmit a
 * job whose lease might still be held server-side.
 *
 * Physically confirmed: the owner saw exactly that message on a Sociology
 * lecture, then left the Course and re-entered it — which triggers
 * app/(tabs)/courses.tsx's useFocusEffect -> refreshCloudLibrary(), a full
 * cloud pull that overwrote the false local 'failed' with the true backend
 * 'ready' state. The bug was never that the job failed; it was that the
 * client declared failure on its own clock instead of the backend's.
 *
 * Root fix: elapsed polling attempts now only ever switch cadence (fast ->
 * slow) and set an informational `processingSlow` flag. Only a REAL backend
 * response (via mergeProcessingSnapshot -> resolveProcessingStatus, in
 * lib/processingResume.mjs) can resolve a lecture to 'ready' or 'failed'.
 * This file covers lib/processingResume.mjs's resolvePollTick /
 * unreachablePollTickPatch (executed, not just pattern-matched) plus the
 * source-level wiring in lib/useProcessingOrchestrator.ts and app/processing.tsx.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolvePollTick, unreachablePollTickPatch, mergeProcessingSnapshot } from '../lib/processingResume.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const MAX_FAST_ATTEMPTS = 80;

console.log('resolvePollTick — pure decision logic (executed, not just pattern-matched)');

check('1. backend still processing, well within the fast window -> stays Processing, not slow', () => {
  const result = resolvePollTick({ processingStatus: 'processing' }, 5, MAX_FAST_ATTEMPTS);
  assert.equal(result.action, 'poll');
  assert.equal(result.slow, false);
  assert.equal(result.patch.processingStatus, 'processing');
  assert.equal(result.patch.processingSlow, false);
});

check('2. backend still processing PAST the fast window -> stays Processing, marked slow, NEVER failed', () => {
  const result = resolvePollTick({ processingStatus: 'processing' }, 80, MAX_FAST_ATTEMPTS);
  assert.equal(result.action, 'poll');
  assert.equal(result.slow, true);
  assert.equal(result.patch.processingStatus, 'processing');
  assert.equal(result.patch.processingSlow, true);
});

check('3. the exact real-incident attempt counts (6m14s and 5m33s at the old 3s cadence) both stay healthy', () => {
  // 6m14s / 3s ≈ 125 attempts; 5m33s / 3s ≈ 111 attempts. Both exceed the old
  // 80-attempt/4-minute budget that used to hard-fail the lecture.
  for (const attempts of [125, 111]) {
    const result = resolvePollTick({ processingStatus: 'processing' }, attempts, MAX_FAST_ATTEMPTS);
    assert.equal(result.patch.processingStatus, 'processing', `attempt ${attempts} must not be marked failed`);
    assert.equal(result.action, 'poll', `attempt ${attempts} must keep polling`);
  }
});

check('4. backend completes after the previous active-poll window -> Ready, slow flag cleared, polling stops', () => {
  const result = resolvePollTick({ processingStatus: 'ready' }, 200, MAX_FAST_ATTEMPTS);
  assert.equal(result.action, 'stop');
  assert.equal(result.patch.processingStatus, 'ready');
  assert.equal(result.patch.processingSlow, false);
});

check('5. backend genuinely reports failed -> client shows failure (unaffected by elapsed time)', () => {
  const result = resolvePollTick({ processingStatus: 'failed', processingError: 'HOSTED_SUMMARY_SHAPE' }, 3, MAX_FAST_ATTEMPTS);
  assert.equal(result.action, 'stop');
  assert.equal(result.patch.processingStatus, 'failed');
  assert.equal(result.patch.processingError, 'HOSTED_SUMMARY_SHAPE');
  assert.equal(result.patch.processingSlow, false);
});

check('6. a genuine failure reported EARLY (before the fast window elapses) still fails immediately — not masked', () => {
  const result = resolvePollTick({ processingStatus: 'failed' }, 2, MAX_FAST_ATTEMPTS);
  assert.equal(result.action, 'stop');
  assert.equal(result.patch.processingStatus, 'failed');
});

console.log('\nunreachablePollTickPatch — a dropped status check is uncertainty, not backend failure');

check('7. network/status check unavailable -> only the slow flag is set, processingStatus is untouched', () => {
  const patch = unreachablePollTickPatch();
  assert.deepEqual(patch, { processingSlow: true });
  assert.equal('processingStatus' in patch, false, 'must never itself declare a status, let alone failed');
});

console.log('\nmergeProcessingSnapshot integration — resolvePollTick composes correctly with real backend responses');

check('8. a real in-progress backend snapshot merged then ticked past the fast window stays healthy', () => {
  const merged = mergeProcessingSnapshot({}, { ai_status: 'pending' });
  const result = resolvePollTick(merged, 90, MAX_FAST_ATTEMPTS);
  assert.equal(result.patch.processingStatus, 'processing');
  assert.equal(result.action, 'poll');
  assert.equal(result.patch.processingSlow, true);
});

check('9. a real ai_status:"done" snapshot (with complete content) resolves Ready regardless of attempt count', () => {
  const merged = mergeProcessingSnapshot(
    { sourceLanguage: 'en', translationLanguage: 'en' },
    { ai_status: 'done', transcript: 'hello', summary_en: 'summary' },
  );
  const result = resolvePollTick(merged, 500, MAX_FAST_ATTEMPTS);
  assert.equal(result.patch.processingStatus, 'ready');
  assert.equal(result.action, 'stop');
});

check('10. a real ai_status:"failed" snapshot resolves failed regardless of attempt count', () => {
  const merged = mergeProcessingSnapshot({}, { ai_status: 'failed', ai_error: 'HOSTED_SUMMARY_SHAPE' });
  const result = resolvePollTick(merged, 1, MAX_FAST_ATTEMPTS);
  assert.equal(result.patch.processingStatus, 'failed');
  assert.equal(result.action, 'stop');
});

console.log('\nWiring: lib/useProcessingOrchestrator.ts calls the pure decision points, not inline elapsed-time logic');

const orchestrator = read('../lib/useProcessingOrchestrator.ts');

check('the poll tick delegates to resolvePollTick — no inline "attempts >= MAX" failure branch remains', () => {
  assert.match(orchestrator, /import \{[\s\S]*?resolvePollTick,[\s\S]*?unreachablePollTickPatch,?[\s\S]*?\} from '\.\/processingResume\.mjs';/);
  assert.match(orchestrator, /const result = resolvePollTick\(merged, state\.attempts, MAX_POLL_ATTEMPTS\);/);
  assert.doesNotMatch(orchestrator, /processingStatus:\s*'failed',\s*\n\s*processingError:\s*'Processing is taking longer than expected/);
});

check('a dropped status check (catch branch) never writes processingStatus — only the uncertainty flag', () => {
  const tickFnForCatch = orchestrator.slice(orchestrator.indexOf('const tick = async'), orchestrator.indexOf('void tick();'));
  const catchBlock = tickFnForCatch.slice(tickFnForCatch.indexOf('} catch {'));
  assert.match(catchBlock, /updateLecture\(lectureId, unreachablePollTickPatch\(\)\);/);
  assert.doesNotMatch(catchBlock, /processingStatus:\s*'failed'/);
});

check('slow-cadence polling continues indefinitely after the fast budget — no second hard-stop ceiling was introduced', () => {
  const tickFn = orchestrator.slice(orchestrator.indexOf('const tick = async'), orchestrator.indexOf('void tick();'));
  assert.doesNotMatch(tickFn, /MAX_POLL_ATTEMPTS\s*\*\s*2|attempts\s*>=?\s*\d{3,}/, 'no new numeric ceiling that could itself fail the lecture');
  assert.match(tickFn, /state\.timer = setTimeout\(\(\) => void tick\(\), result\.slow \? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS\);/);
});

check('the orchestrator is still mounted once at the app root — polling survives Course navigation by construction', () => {
  assert.match(orchestrator, /This hook is mounted once at the app root \(see app\/_layout\.tsx\)/);
});

const layout = read('../app/_layout.tsx');
check('app/_layout.tsx actually mounts useProcessingOrchestrator (the claim above is true, not just documented)', () => {
  assert.match(layout, /useProcessingOrchestrator\(\)/);
});

console.log('\nUI: app/processing.tsx distinguishes "still processing, slow" from "failed" — no retry offered for a healthy job');

const processingScreen = read('../app/processing.tsx');

check('the slow-processing message is shown ONLY while processingStatus is still "processing", never confused with failed/ready', () => {
  assert.match(
    processingScreen,
    /processingStatus === 'processing' && lecture\?\.processingSlow \? t\('processing\.step\.stillProcessingSlow'\)/,
  );
});

check('the remote step indicator stays "active" (spinner), never "failed" (red), while genuinely still processing', () => {
  const indicatorLine = processingScreen.slice(processingScreen.indexOf('const remoteStepState'), processingScreen.indexOf('function remoteStatusKey') > -1 ? processingScreen.indexOf(';', processingScreen.indexOf('const remoteStepState')) + 1 : undefined);
  assert.match(indicatorLine, /processingStatus === 'processing' \? 'active'/);
});

check('the Retry Processing button is gated ONLY on a genuine processingStatus === "failed" — it structurally cannot appear during the slow-but-healthy state, so a poll-timeout can never itself trigger a premature/duplicate retry', () => {
  const retryLine = processingScreen.split('\n').find((line) => line.includes("t('processing.step.retryProcessing')"));
  assert.ok(retryLine, 'retry button line not found');
  assert.match(retryLine, /processingStatus === 'failed' \?/);
  assert.doesNotMatch(retryLine, /processingSlow/);
});

check('the new locale string exists', () => {
  const en = read('../lib/locales/en.mjs');
  assert.match(en, /'processing\.step\.stillProcessingSlow':/);
});

console.log('\nRetry-duplication audit: prove current backend contract already prevents duplicate in-flight work');

const processRecordingClient = read('../lib/processRecording.ts');

check('the backend already exposes lease-aware, idempotent outcomes for a re-submitted trigger — this is pre-existing, not new', () => {
  assert.match(processRecordingClient, /'resumed_from_transcription' \| 'resumed_from_summary' \| 'already_processing' \| 'already_complete'/);
});

check('the orchestrator already treats "already_processing" as normal in-progress state, not an error or a second trigger', () => {
  const startProcessingFn = orchestrator.slice(
    orchestrator.indexOf('const startProcessing = (lectureId'),
    orchestrator.indexOf('const startPoll = ('),
  );
  assert.match(startProcessingFn, /'already_processing' means another\s*\n\s*\/\/ request\/worker already/);
  assert.match(startProcessingFn, /updateLecture\(lectureId, \{ processingStatus: 'processing', processingError: undefined \}\);/);
});

check('"already_complete" fetches the real snapshot directly instead of re-polling from scratch — avoids a spurious "Processing" flash on an already-finished job', () => {
  const startProcessingFn = orchestrator.slice(
    orchestrator.indexOf('const startProcessing = (lectureId'),
    orchestrator.indexOf('const startPoll = ('),
  );
  assert.match(startProcessingFn, /result\.status === 'already_complete'/);
  assert.match(startProcessingFn, /fetchRemoteRecording\(\{ remoteRecordingId, accessToken, userId \}\)/);
});

check('Retry Processing (the shared recovery action) never mints a new remoteRecordingId — retries key on the SAME stable id the lease system tracks', () => {
  const retryFn = read('../lib/retryLectureProcessing.ts');
  assert.match(retryFn, /Same lecture id, same remoteRecordingId/);
  assert.doesNotMatch(retryFn, /remoteRecordingId:\s*makeUuid/);
});

console.log(`\nprocessing-poll-timeout-not-failure: ${passed} checks passed`);
