/**
 * Multi-select lecture delete — batch soft-delete contract.
 *
 * Pins two things:
 *
 *   1. The pure plan (lib/lectureBatchDelete.mjs) always stamps the canonical
 *      soft-delete fields — `deletedAt` + `deletionUpdatedAt` + `deletedReason:
 *      'manual'` — and NEVER removes the record. A soft-deleted lecture stays
 *      restorable (Recently Deleted), so the delete is a state stamp, not a
 *      removal. It also collects the selected lectures' remote recording ids
 *      for ONE `.in('id', ids)` push, and the remote patch carries
 *      `deleted_at` + `deletion_updated_at`.
 *
 *   2. The mutation guard: the Course Detail UI must route its delete through
 *      the store's `deleteLectures` (which delegates to the pure helper +
 *      `pushRecordingPatch`). If someone changes the UI to simply hide/filter
 *      the cards without calling the canonical soft delete, the first guard
 *      assertion below fails; if someone makes the batch a hard delete, the
 *      tombstone / hard-delete guards fail.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { batchSoftDeleteIsEmpty, buildBatchSoftDelete } from '../lib/lectureBatchDelete.mjs';

const NOW = '2026-12-01T00:00:00.000Z';

const lectures = [
  { id: 'lecture_a', remoteRecordingId: 'rec_1' },
  { id: 'lecture_b', remoteRecordingId: 'rec_2' },
  { id: 'lecture_c', remoteRecordingId: null },
];

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('batch lecture soft-delete core');

check('stamps the canonical soft-delete fields (never removes the record)', () => {
  const plan = buildBatchSoftDelete({ lectures, ids: ['lecture_a', 'lecture_b', 'lecture_c'], now: NOW });
  assert.equal(plan.localPatches.length, 3);
  for (const p of plan.localPatches) {
    assert.equal(p.patch.deletedAt, NOW);
    assert.equal(p.patch.deletionUpdatedAt, NOW);
    assert.equal(p.patch.deletedReason, 'manual');
  }
});

check('preserves deletion_updated_at alongside deleted_at (restorable freshness clock)', () => {
  const plan = buildBatchSoftDelete({ lectures, ids: ['lecture_a'], now: NOW });
  assert.equal(plan.localPatches[0].patch.deletedAt, NOW);
  assert.equal(plan.localPatches[0].patch.deletionUpdatedAt, NOW);
});

check('collects only the selected lectures remote ids for one .in() push', () => {
  const plan = buildBatchSoftDelete({ lectures, ids: ['lecture_a', 'lecture_b'], now: NOW });
  assert.deepEqual(plan.remoteIds, ['rec_1', 'rec_2']);
  assert.deepEqual(plan.remotePatch, { deleted_at: NOW, deletion_updated_at: NOW });
});

check('a lecture with no remote id still soft-deletes locally', () => {
  const plan = buildBatchSoftDelete({ lectures, ids: ['lecture_c'], now: NOW });
  assert.deepEqual(plan.remoteIds, []);
  assert.equal(plan.localPatches.length, 1);
});

check('empty / unknown selection is a no-op (no state churn, no network)', () => {
  assert.equal(batchSoftDeleteIsEmpty(buildBatchSoftDelete({ lectures, ids: [], now: NOW })), true);
  assert.equal(batchSoftDeleteIsEmpty(buildBatchSoftDelete({ lectures, ids: ['nope'], now: NOW })), true);
});

check('dedupes repeated ids', () => {
  const plan = buildBatchSoftDelete({ lectures, ids: ['lecture_a', 'lecture_a'], now: NOW });
  assert.equal(plan.localPatches.length, 1);
  assert.deepEqual(plan.remoteIds, ['rec_1']);
});

console.log('mutation guard: UI must route through the canonical soft delete');

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const courseDetail = read('app/course/[id].tsx');
const store = read('lib/store.tsx');
const helper = read('lib/lectureBatchDelete.mjs');

check('Course Detail calls deleteLectures(ids) — not card-only removal', () => {
  assert.ok(courseDetail.includes('deleteLectures('), 'course detail must call the store batch soft-delete');
});

check('Course Detail never hard-deletes during selection', () => {
  assert.equal(courseDetail.includes('permanentlyDeleteLecture'), false, 'selection delete must never hard-delete');
});

check('store.deleteLectures delegates to the pure plan + canonical pushRecordingPatch', () => {
  const fn = store.slice(store.indexOf('const deleteLectures = useCallback'), store.indexOf('const deleteCourse = useCallback'));
  assert.ok(fn.includes('buildBatchSoftDelete('), 'deleteLectures must build the soft-delete plan');
  assert.ok(fn.includes('pushRecordingPatch('), 'deleteLectures must push through the canonical remote path');
});

check('store.deleteLectures never hard-deletes / tombstones', () => {
  const fn = store.slice(store.indexOf('const deleteLectures = useCallback'), store.indexOf('const deleteCourse = useCallback'));
  assert.equal(fn.includes('setTombstones'), false, 'soft delete must not write purge tombstones');
  assert.equal(fn.includes('addPurgedRecordings'), false, 'soft delete must not write purge tombstones');
});

check('pure helper carries the remote soft-delete columns + soft-delete reason', () => {
  assert.ok(helper.includes('deleted_at'), 'remote patch must include deleted_at');
  assert.ok(helper.includes('deletion_updated_at'), 'remote patch must include deletion_updated_at');
  assert.ok(helper.includes("deletedReason: 'manual'"), 'local patch must include the manual soft-delete reason');
});

console.log(`\nlecture batch delete: ${passed} checks passed`);
