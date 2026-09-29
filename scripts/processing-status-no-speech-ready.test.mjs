/**
 * RC validation of the ACCEPTED no-speech convergence rule (owner physical pass):
 *
 *     explicit backend AI status 'done'  +  transcript === ''   =>   READY
 *
 * evaluated BEFORE the language/content completeness gates, without weakening them.
 * Also proves the two sibling requirements:
 *   - no Ready <-> Processing flicker (the two status paths agree and Ready is a latch)
 *   - a genuinely incomplete normal processing job is NEVER classified Ready.
 *
 * (lib/processingResume.mjs cites this file by name.)
 * Run: node --experimental-strip-types scripts/processing-status-no-speech-ready.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeProcessingSnapshot, resolvePollTick } from '../lib/processingResume.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const store = readFileSync(new URL('../lib/store.tsx', import.meta.url), 'utf8');
/** The store's separate remote-status mapper, executed from source (TS annotations stripped). */
function storeProcessingStatusFromRemote() {
  const start = store.indexOf('function processingStatusFromRemote(');
  const end = store.indexOf('\n}\n', start) + 3;
  const js = store.slice(start, end).replace(/\(status: string \| null\): Lecture\['processingStatus'\]/, '(status)');
  return new Function(`${js}\nreturn processingStatusFromRemote;`)();
}
const storeStatus = storeProcessingStatusFromRemote();

const NO_SPEECH = { ai_status: 'done', transcript: '', summary_en: '', summary_zh: '', source_summary: '', translated_summary: null };

console.log('No-speech => Ready');
check('done + transcript "" is READY, from a blank lecture and from an in-flight one', () => {
  assert.equal(mergeProcessingSnapshot({}, NO_SPEECH).processingStatus, 'ready');
  assert.equal(mergeProcessingSnapshot({ processingStatus: 'processing' }, NO_SPEECH).processingStatus, 'ready');
});
check('the poll loop STOPS on it (no infinite "Waiting for Processing updates")', () => {
  assert.equal(resolvePollTick(mergeProcessingSnapshot({}, NO_SPEECH), 1, 80).action, 'stop');
});
check('it is decided BEFORE the language/content gates: multilingual settings do not block it', () => {
  const multilingual = { ...NO_SPEECH, source_language: 'fr', translation_language: 'zh-Hans' };
  assert.equal(mergeProcessingSnapshot({}, multilingual).processingStatus, 'ready');
});

console.log('\nNo Ready <-> Processing flicker');
check('the store\'s independent remote-status mapper agrees: done => ready (two paths cannot fight)', () => {
  assert.equal(storeStatus('done'), 'ready');
  assert.equal(mergeProcessingSnapshot({}, NO_SPEECH).processingStatus, storeStatus(NO_SPEECH.ai_status));
});
check('across a whole poll sequence the status never goes back to processing once Ready (latch)', () => {
  let lecture = { processingStatus: 'processing' };
  const series = [];
  const snapshots = [
    { ai_status: 'transcribing', transcript: null },
    NO_SPEECH,
    NO_SPEECH,
    { ai_status: 'transcribing', transcript: null }, // a stale/late in-flight response
    NO_SPEECH,
  ];
  for (const snapshot of snapshots) {
    lecture = { ...lecture, ...mergeProcessingSnapshot(lecture, snapshot) };
    series.push(lecture.processingStatus);
  }
  assert.deepEqual(series, ['processing', 'ready', 'ready', 'ready', 'ready']);
});

console.log('\nA genuinely incomplete job is NEVER Ready');
check('every in-flight backend status with no transcript yet stays processing', () => {
  for (const ai_status of ['queued', 'transcribing', 'transcript_ready', 'summarizing']) {
    for (const transcript of [null, undefined]) {
      assert.equal(mergeProcessingSnapshot({}, { ai_status, transcript }).processingStatus, 'processing', `${ai_status}/${transcript}`);
    }
  }
});
check('transcript "" WITHOUT an explicit done is not the no-speech signal', () => {
  for (const ai_status of ['queued', 'transcribing', 'transcript_ready', 'summarizing', undefined]) {
    assert.equal(mergeProcessingSnapshot({}, { ai_status, transcript: '' }).processingStatus, 'processing', String(ai_status));
  }
});
check('done with a MISSING transcript (null / absent) is a race, not readiness', () => {
  assert.equal(mergeProcessingSnapshot({}, { ai_status: 'done', transcript: null }).processingStatus, 'processing');
  assert.equal(mergeProcessingSnapshot({}, { ai_status: 'done' }).processingStatus, 'processing');
});
check('done with REAL transcript but the translated pair still landing keeps the completeness gate (French/Chinese race)', () => {
  const race = mergeProcessingSnapshot({}, {
    source_language: 'fr', translation_language: 'zh-Hans', transcript: 'FR transcript', translated_transcript: '中文转录',
    summary_zh: '中文摘要', source_summary: null, translated_summary: null, ai_status: 'done',
  });
  assert.equal(race.processingStatus, 'processing');
});
check('an explicit backend failure is failed even when the transcript is ""', () => {
  assert.equal(mergeProcessingSnapshot({}, { ai_status: 'failed', transcript: '' }).processingStatus, 'failed');
});
console.log(`\nprocessing-status-no-speech-ready: ${passed} checks passed`);
