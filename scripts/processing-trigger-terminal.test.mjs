/**
 * P0 — post-recording processing stuck on "Waiting…" (physical staging).
 *
 * Repro: Finish → trigger processing → UI never leaves "Waiting to start
 * processing" / "Waiting for processing updates", never reaches View Lecture.
 *
 * Root cause: the orchestrator's startProcessing optimistically marked the
 * lecture 'processing' BEFORE the trigger request. On a dev backend with no
 * transcription provider the trigger returns HTTP 503 and the job is never
 * enqueued (remote ai_status stays 'pending'). But the optimistic 'processing'
 * had already started the status poll, which then read that never-terminal
 * 'pending' and repeatedly overwrote the local 'failed' back to a waiting
 * state — for the whole poll budget. The failure never stuck; the UI waited.
 *
 * Fix (locked in below): 'processing' is entered ONLY after a successful
 * trigger (.then). A failed trigger goes straight to terminal 'failed' with no
 * poll to clobber it. nextProcessingAction already treats 'failed' as terminal
 * ('none'), so it settles immediately and the manual Retry drives recovery.
 *
 * Invariant: AI processing failure must never trap the user — "View Lecture"
 * on app/processing.tsx is gated on the lecture existing, not on processing
 * completing.
 *
 * Source-level guards (the orchestrator is a React hook; the behaviour was
 * confirmed against the physical staging device).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const orchestrator = read('../lib/useProcessingOrchestrator.ts');
const processingScreen = read('../app/processing.tsx');

console.log('P0 — processing trigger settles terminally (no infinite Waiting)');

check('startProcessing does NOT mark processing before the trigger request', () => {
  const fn = orchestrator.slice(
    orchestrator.indexOf('const startProcessing ='),
    orchestrator.indexOf('const startPoll ='),
  );
  assert.ok(fn.length > 0, 'startProcessing must exist');
  const triggerAt = fn.indexOf('startRemoteProcessing(');
  const optimisticProcessingAt = fn.indexOf("processingStatus: 'processing'");
  assert.ok(triggerAt > 0, 'startProcessing must call startRemoteProcessing');
  assert.ok(optimisticProcessingAt > 0, "startProcessing must set 'processing' somewhere");
  // The ONLY 'processing' write must come AFTER the request is issued, inside
  // the success handler — never before it.
  assert.ok(
    optimisticProcessingAt > triggerAt,
    "'processing' must be set only after startRemoteProcessing (in .then), never optimistically before it",
  );
  assert.match(fn, /\.then\(\(\) => \{[\s\S]{0,120}processingStatus: 'processing'/);
});

check('a failed trigger goes straight to terminal failed', () => {
  const fn = orchestrator.slice(
    orchestrator.indexOf('const startProcessing ='),
    orchestrator.indexOf('const startPoll ='),
  );
  assert.match(fn, /\.catch\(\(error: unknown\) => \{[\s\S]{0,200}processingStatus: 'failed'/);
});

check("nextProcessingAction keeps 'failed' terminal (no auto-retry loop)", () => {
  const resume = read('../lib/processingResume.mjs');
  // 'processing' → poll; 'failed' → none (manual Retry only).
  assert.match(resume, /processingStatus === 'processing'\) return 'poll'/);
  assert.match(resume, /\/\/ 'failed'[\s\S]{0,80}return 'none'/);
});

console.log('\nInvariant — processing failure never traps the user');

check('View Lecture is available whenever the lecture exists, not gated on done', () => {
  // The primary action is gated on `lecture`, not on processingDone/'ready'.
  assert.match(processingScreen, /\{lecture \? <PrimaryButton label=\{t\('processing\.viewLecture'\)/);
  assert.doesNotMatch(
    processingScreen,
    /\{processingDone \? <PrimaryButton label=\{t\('processing\.viewLecture'\)/,
    'View Lecture must not be gated on processingDone',
  );
});

console.log(`\nprocessing trigger/terminal: ${passed} checks passed`);
