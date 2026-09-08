/**
 * Processing status UI consistency (the WR112/WR2 production bug, Sep 4 2026).
 *
 * Root cause: lib/processingResume.mjs's hasCompleteLanguagePair() only
 * recognized translated_transcript/transcript_zh as valid translated-transcript
 * content. For recordings where the backend's translation lands only in
 * translated_live_transcript (the live-caption-derived translation), that
 * check could never be satisfied, so the polling orchestrator's
 * mergeProcessingSnapshot() could never conclude 'ready' for an otherwise
 * fully-done recording (ai_status='done', translation_ready=true) — even
 * though lib/store.tsx's separate, simpler processingStatusFromRemote()
 * hydration path (ai_status-only) correctly computed 'ready' for the same
 * row. Whichever of the two independently-writing paths last touched the
 * stored lecture.processingStatus determined what every screen showed —
 * the observed "alternates between Ready and Processing" behavior, including
 * navigation routing back to the Processing screen (app/course/[id].tsx and
 * app/(tabs)/index.tsx both gate on isLectureComplete()).
 *
 * The actual fix lives in lib/processingResume.mjs (translated_live_transcript
 * fallback + terminal-state monotonicity) and lib/syncRecording.ts (fetching
 * that column at all) — proven directly in scripts/processing-resume.test.mjs.
 * This file proves the OTHER half of the bug's mechanism: that every screen
 * reads the SAME stored field, with no independent re-derivation of its own,
 * so once the write-side is correct, every screen agrees by construction.
 *
 * Source-level structural guards, same idiom as the rest of this suite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const lectureDetail = stripComments(read('../app/lecture/[id].tsx'));
const processingScreen = stripComments(read('../app/processing.tsx'));
const courseScreen = stripComments(read('../app/course/[id].tsx'));
const homeScreen = stripComments(read('../app/(tabs)/index.tsx'));
const orchestrator = stripComments(read('../lib/useProcessingOrchestrator.ts'));
const syncRecording = read('../lib/syncRecording.ts');
const processingResume = read('../lib/processingResume.mjs');

console.log('Every screen derives its displayed status from the SAME stored field, never independently');

check('Lecture Detail\'s status badge reads lecture.processingStatus directly — no independent live-status derivation', () => {
  const statusDecl = lectureDetail.slice(lectureDetail.indexOf('const status =\n'), lectureDetail.indexOf('const handleRetryProcessing'));
  assert.match(statusDecl, /lecture\.processingStatus === 'ready'/);
  assert.match(statusDecl, /lecture\.processingStatus === 'processing'/);
  assert.match(statusDecl, /lecture\.processingStatus === 'failed'/);
  assert.doesNotMatch(statusDecl, /ai_status|hasCompleteLanguagePair|mergeProcessingSnapshot/, 'the badge must not re-derive status from raw remote fields — one source of truth only');
});

check('the Processing screen reads the same lecture.processingStatus (via isLectureComplete/processingStatus), not a screen-local recomputation', () => {
  assert.match(processingScreen, /import \{ isLectureComplete \} from '@\/lib\/processingResume\.mjs';/);
  assert.match(processingScreen, /const processingStatus = lecture\?\.processingStatus \?\? 'not_started';/);
  assert.doesNotMatch(processingScreen, /hasCompleteLanguagePair|ai_status ===/, 'the processing screen must not reimplement the readiness decision itself');
});

check('navigation gating (course list, home list) routes on the SAME isLectureComplete predicate that Lecture Detail and the Processing screen use — one canonical semantic status for the whole app', () => {
  assert.match(courseScreen, /import \{ isLectureComplete \} from '@\/lib\/processingResume\.mjs';/);
  assert.match(courseScreen, /if \(!isLectureComplete\(lecture\)\) \{/);
  assert.match(homeScreen, /import \{ isLectureComplete \} from '@\/lib\/processingResume\.mjs';/);
  assert.match(homeScreen, /isLectureComplete\(lecture\)/);
});

console.log('\nTerminal completion actually stops polling (does not keep loading forever)');

check('the poll loop stops as soon as the merged patch reaches a terminal status (ready or failed) — it does not keep ticking past completion', () => {
  const tickFn = orchestrator.slice(orchestrator.indexOf('const tick = async () => {'), orchestrator.indexOf('void tick();'));
  assert.match(tickFn, /if \(patch\.processingStatus === 'ready' \|\| patch\.processingStatus === 'failed'\) \{\s*stop\(\);\s*return;\s*\}/);
});

check('once processingStatus is ready, the orchestrator will not even start a new poll for that lecture (nextProcessingAction returns none)', () => {
  assert.match(processingResume, /if \(processingStatus === 'ready'\) return 'none';/);
});

console.log('\nThe orchestrator actually has the data it needs to reach "ready" (translated_live_transcript is fetched, not just referenced)');

check('fetchRemoteRecording selects translated_live_transcript in both the primary and legacy column sets', () => {
  const columnsBlock = syncRecording.slice(syncRecording.indexOf('const RECORDING_COLUMNS ='), syncRecording.indexOf('export async function fetchRemoteRecording'));
  assert.match(columnsBlock, /translated_live_transcript/);
  const legacyLine = columnsBlock.slice(columnsBlock.indexOf('RECORDING_COLUMNS_LEGACY'));
  assert.match(legacyLine, /translated_live_transcript/);
});

check('the fetched value is actually returned on the snapshot object, not silently dropped', () => {
  const returnBlock = syncRecording.slice(syncRecording.indexOf('return {\n    id: String'), syncRecording.length);
  assert.match(returnBlock, /translated_live_transcript: row\.translated_live_transcript \?\? null,/);
});

console.log(`\nprocessing-status-consistency: ${passed} checks passed`);
