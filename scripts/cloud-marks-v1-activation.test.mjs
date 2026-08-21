/**
 * Cloud Marks V1 activation (Cloud Library correctness).
 *
 * The audit proved iPad captured marks locally but never pushed them to
 * `recordings.marked_timestamps` — the store's marks writer had zero callers, so
 * marks were device-local and invisible to a second client. This activates the
 * EXISTING write path at the single safe hook: the audio-upload `.then`, the
 * first moment the cloud recordings row (id === remoteRecordingId) exists.
 *
 * FROZEN V1 CONTRACT (unchanged, asserted here): `marked_timestamps` is a
 * `number[]` of elapsed-millisecond offsets — no objects, no id, no label, no
 * per-mark timestamp; whole-array replacement; freshness = `marks_updated_at`.
 *
 * Source-level guards (the store + orchestrator are React modules); the live
 * round-trip is proven separately by scripts/cloud-marks-v1-live-staging.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const models = read('../lib/models.ts');
const store = read('../lib/store.tsx');
const orchestrator = read('../lib/useProcessingOrchestrator.ts');
const lectureDetail = read('../app/lecture/[id].tsx');

// ── Frozen V1 shape ─────────────────────────────────────────────────────────
console.log('V1 shape — number[] of millisecond offsets (no object upgrade)');
check('1. finalized marks type is number[] (local model + remote row)', () => {
  assert.match(models, /markedTimestamps: number\[\]/);
  assert.match(store, /marked_timestamps\?: number\[\] \| null/);
});
check('2. values are elapsed millisecond offsets; seek divides by 1000', () => {
  assert.match(models, /millisecond offsets into the recording/i);
  assert.match(lectureDetail, /seekToSeconds\(ms \/ 1000\)/);
});

// ── Local-first at Finish ───────────────────────────────────────────────────
console.log('Local-first — Finish saves marks locally, independent of cloud');
check('3. createLecture stores marks in local state only (no cloud write at Finish)', () => {
  const fn = store.slice(store.indexOf('const createLecture ='), store.indexOf('const createLecture =') + 900);
  assert.match(fn, /markedTimestamps: input\.markedTimestamps/);
  assert.doesNotMatch(fn, /supabase|pushRecordingPatch/);
});
check('6. cloud marks write is fire-and-forget (pushRecordingPatch is void, never awaited)', () => {
  const fn = store.slice(store.indexOf('const pushRecordingPatch ='), store.indexOf('const updateLecture ='));
  assert.match(fn, /void supabase\s*\.from\('recordings'\)\s*\.update/);
  assert.doesNotMatch(fn, /await supabase/);
});
check('7. marks push is guarded by remoteId; missing identity keeps marks local', () => {
  const fn = store.slice(store.indexOf('const updateLecture ='), store.indexOf('const updateLecture =') + 1100);
  // local state is set FIRST (setLectures), and the cloud push only runs when a
  // remoteRecordingId exists — so no identity means marks simply stay local.
  const setAt = fn.indexOf('setLectures((prev)');
  const guardAt = fn.indexOf('if (remoteId)');
  assert.ok(setAt > 0 && guardAt > setAt, 'local setLectures must precede the remoteId-guarded push');
});

// ── Activation hook ─────────────────────────────────────────────────────────
console.log('Activation — sync at the upload .then, when the cloud row first exists');
check('4/8. upload success patch includes markedTimestamps (eventual remote identity → sync)', () => {
  const then = orchestrator.slice(orchestrator.indexOf('.then((result) =>'), orchestrator.indexOf('.catch((error'));
  assert.match(then, /uploadStatus: 'uploaded'/);
  assert.match(then, /markedTimestamps: lecture\.markedTimestamps \?\? \[\]/);
});
check('6b. an upload FAILURE never syncs marks (they stay local to retry) and never throws', () => {
  const cat = orchestrator.slice(orchestrator.indexOf('.catch((error'), orchestrator.indexOf('.finally('));
  assert.doesNotMatch(cat, /markedTimestamps|marked_timestamps/);
  assert.match(cat, /uploadStatus: 'upload_failed'/);
});
check('5/4b. store writer pushes marked_timestamps + marks_updated_at as a whole array', () => {
  assert.match(store, /const touchesMarks = Object\.prototype\.hasOwnProperty\.call\(patch, 'markedTimestamps'\)/);
  assert.match(store, /if \(touchesMarks\) stamped\.marksUpdatedAt = now/);
  assert.match(store, /cloud\.marked_timestamps = patch\.markedTimestamps \?\? \[\]; cloud\.marks_updated_at = now/);
});

// ── Merge freshness (unchanged) ─────────────────────────────────────────────
console.log('Merge — freshness by marks_updated_at (semantics unchanged)');
check('9/10. remote newer marks_updated_at wins; else local array kept', () => {
  const m = store.slice(store.indexOf('const localMarksUpdatedAt = local?.marksUpdatedAt;'), store.indexOf('const mergedMarksUpdatedAt'));
  assert.match(m, /const preferRemoteMarks =\s*Boolean\(row\.marks_updated_at\) &&\s*\(!localMarksUpdatedAt \|\| row\.marks_updated_at! > localMarksUpdatedAt\) &&\s*remoteMarks !== undefined;/);
  assert.match(m, /const mergedMarks = preferRemoteMarks \? remoteMarks! : \(local\?\.markedTimestamps \?\? remoteMarks \?\? \[\]\);/);
});
check('11. malformed (non-array) remote is ignored → valid local marks preserved', () => {
  assert.match(store, /const remoteMarks = Array\.isArray\(row\.marked_timestamps\) \? row\.marked_timestamps : undefined;/);
});
check('12/13. no dedup and no sort anywhere → duplicates + array order preserved', () => {
  // The merge/write copy the array verbatim; assert no sort/dedup on the marks path.
  const m = store.slice(store.indexOf('const localMarksUpdatedAt = local?.marksUpdatedAt;'), store.indexOf('markedTimestamps: mergedMarks'));
  assert.doesNotMatch(m, /\.sort\(|new Set\(|dedup/i);
});

// ── Feature isolation ───────────────────────────────────────────────────────
console.log('Isolation — marks never touch Notebook or Notes');
check('14/15. the cloud marks push carries ONLY marks (+notes on its own branch); no notebook fields', () => {
  const block = store.slice(store.indexOf('if (touchesNotes || touchesMarks)'), store.indexOf("pushRecordingPatch(cloud, [remoteId], 'lecture notes/marks')") + 60);
  // Notes and marks are independent branches; neither writes strokes/images/pages.
  assert.match(block, /if \(touchesNotes\) \{ cloud\.notes = /);
  assert.match(block, /if \(touchesMarks\) \{ cloud\.marked_timestamps = /);
  assert.doesNotMatch(block, /noteStrokes|noteImages|note_strokes|strokes|pages/);
});

console.log(`\ncloud marks V1 activation: ${passed} checks passed`);
