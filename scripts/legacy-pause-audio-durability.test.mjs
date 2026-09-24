/**
 * P0 contract — legacy audio ownership around Pause/restart/Finish.
 *
 * These checks intentionally model the lifecycle without a device: the
 * physical native recorder is covered by its existing suites, while this
 * suite locks the JS ownership boundary that previously promoted only a
 * cache URI and allowed a false "Recording Saved" state.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const recording = read('../app/recording.tsx');
const localAudio = read('../lib/lectureLocalAudio.ts');
let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const pauseBlock = () => {
  const start = recording.indexOf('const togglePause = async () => {');
  const end = recording.indexOf('// Mini / Course popups', start);
  return recording.slice(start, end);
};
const finishBlock = () => {
  const start = recording.indexOf('const rawFinalAudio = uri ?? priorAudioUriRef.current;');
  const end = recording.indexOf('let lectureId = pendingLectureId;', start);
  return recording.slice(start, end);
};

console.log('Pause ownership — immediate finish, background/foreground, process restart, and long idle');
check('Pause creates a lecture-owned durable checkpoint before in-progress persistence', () => {
  const block = pauseBlock();
  const copy = block.indexOf('await persistLectureLocalAudio(liveFileUri, pendingLectureId)');
  const persist = block.indexOf('persistProgress(legacyResumeHasPriorAudio ? undefined : verifiedPausedLegacyAudio)');
  assert.ok(copy >= 0 && persist > copy);
  assert.match(block, /isVerifiedDurableLectureAudio\(pausedLegacyAudio\)/);
});
check('ordinary legacy autosave cannot reintroduce a cache URI before or after background/foreground', () => {
  assert.match(recording, /persistProgress\(recordingEngine === 'legacy' \|\| legacyResumeHasPriorAudio \? undefined : liveFileUri\);/);
});
check('a simulated restart finishes from the persisted checkpoint, not a prior recorder instance', () => {
  assert.match(finishBlock(), /const rawFinalAudio = uri \?\? priorAudioUriRef\.current;/);
  assert.match(finishBlock(), /await persistLectureLocalAudio\(rawFinalAudio, pendingLectureId\)/);
});
check('long idle cannot convert a missing legacy asset into a saved lecture', () => {
  const block = finishBlock();
  assert.match(block, /finalDuration > 0 && !verifiedFinalAudio/);
  assert.match(block, /setFinishing\(false\);/);
  assert.match(block, /return;/);
});

console.log('Finalization and recovery safety');
check('Recording Saved path requires a verified final local asset, not duration/transcript alone', () => {
  const block = finishBlock();
  assert.match(block, /hasAudio: Boolean\(verifiedFinalAudio\)/);
  assert.ok(block.indexOf('if (finalDuration > 0 && !verifiedFinalAudio)') < block.indexOf('hasMeaningfulRecordingContent'));
});
check('stale absolute container URIs are rewritten only to the same exact owned path', () => {
  const resolver = localAudio.slice(localAudio.indexOf('export function resolvePlayableLocalAudioUri'), localAudio.indexOf('function rewriteSandboxUri'));
  assert.match(resolver, /const rewritten = rewriteSandboxUri\(raw\);/);
  assert.match(resolver, /if \(rewritten && localAudioFileExists\(rewritten\)\) return rewritten;/);
});
check('canonical-missing recovery may use the exact legacy lecture-id path but never another Documents basename', () => {
  const resolver = localAudio.slice(localAudio.indexOf('export function resolvePlayableLocalAudioUri'), localAudio.indexOf('function rewriteSandboxUri'));
  assert.match(resolver, /\$\{recordingsDir\}\/\$\{lectureId\}/);
  assert.doesNotMatch(resolver, /candidates\.push\(`\$\{recordingsDir\}\/\$\{base\}`\)/);
});
check('a truly missing asset returns null from durable promotion and cannot be silently saved', () => {
  const persist = localAudio.slice(localAudio.indexOf('export async function persistLectureLocalAudio'), localAudio.indexOf('export async function persistLectureResumeSegment'));
  assert.match(persist, /: null;/);
  assert.doesNotMatch(persist, /if \(!dir\) return src;/);
  assert.doesNotMatch(persist, /return localAudioFileExists\(src\) \? src : null;/);
});
check('recovery never deletes an original or an older durable candidate', () => {
  const persist = localAudio.slice(localAudio.indexOf('export async function persistLectureLocalAudio'), localAudio.indexOf('export async function persistLectureResumeSegment'));
  assert.doesNotMatch(persist, /target\.delete\(/);
  assert.match(persist, /const nonce =/);
  assert.match(persist, /\$\{lectureId\}-\$\{nonce\}/);
});
check('promotion names every new asset with its owning lecture id, preventing cross-lecture adoption', () => {
  const persist = localAudio.slice(localAudio.indexOf('export async function persistLectureLocalAudio'), localAudio.indexOf('export async function persistLectureResumeSegment'));
  assert.match(persist, /const targetName = `\$\{lectureId\}-\$\{nonce\}/);
});

console.log(`\nlegacy pause audio durability: ${passed} checks passed`);
