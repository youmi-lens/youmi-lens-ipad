/**
 * P0 — deleted Lectures and Courses must stay deleted.
 *
 * Deletion on iPad is local-only: `public.recordings` has no `deleted_at`
 * column, so every deleted record still has a permanently ACTIVE remote row.
 * Two distinct mechanisms were resurrecting content:
 *
 *   1. PERMANENT delete removed the local record outright, leaving nothing for
 *      the merge to recognise. The next merge rebuilt the record from its
 *      still-active remote row as a NEW active lecture with `localAudioUri:
 *      null` — so the lecture came back, silent, forever.
 *
 *   2. A STALE IN-FLIGHT response. The merge was computed from a local snapshot
 *      taken before the request was issued; deleting during the request and
 *      then applying that older snapshot overwrote the fresh tombstone.
 *
 * Soft delete rides on the record as `deletedAt` and the merge copies it
 * forward; these tests pin that too, so it cannot silently stop working.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  addPurgedCourseNames,
  addPurgedRecordings,
  clearPurgedCourseName,
  emptyTombstones,
  isPurgedCourseName,
  isPurgedRecording,
  parseTombstones,
  toTombstoneIndex,
} from '../lib/deletionTombstones.mjs';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
};

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const store = stripComments(read('../lib/store.tsx'));

// ─────────────────────────────────────────────────────────────────────────────
console.log('purge tombstones');

check('a purged recording id is recognised', () => {
  const t = addPurgedRecordings(emptyTombstones(), ['rec-1']);
  const idx = toTombstoneIndex(t);
  assert.equal(isPurgedRecording(idx, 'rec-1'), true);
  assert.equal(isPurgedRecording(idx, 'rec-2'), false);
});

check('purges accumulate and never duplicate', () => {
  let t = addPurgedRecordings(emptyTombstones(), ['a']);
  t = addPurgedRecordings(t, ['b', 'a']);
  assert.deepEqual([...t.recordingIds].sort(), ['a', 'b']);
});

check('course names are matched trimmed and case-folded', () => {
  const idx = toTombstoneIndex(addPurgedCourseNames(emptyTombstones(), ['  Organic Chemistry ']));
  assert.equal(isPurgedCourseName(idx, 'organic chemistry'), true);
  assert.equal(isPurgedCourseName(idx, 'ORGANIC CHEMISTRY'), true);
  assert.equal(isPurgedCourseName(idx, 'Organic Chem'), false);
});

check('reusing a purged course name lifts the purge', () => {
  // Otherwise the user could never create a course with that name again.
  let t = addPurgedCourseNames(emptyTombstones(), ['Physics']);
  assert.equal(isPurgedCourseName(toTombstoneIndex(t), 'Physics'), true);
  t = clearPurgedCourseName(t, 'physics');
  assert.equal(isPurgedCourseName(toTombstoneIndex(t), 'Physics'), false);
});

check('corrupt or missing persisted data degrades to empty, not a throw', () => {
  assert.deepEqual(parseTombstones(null), emptyTombstones());
  assert.deepEqual(parseTombstones('nonsense'), emptyTombstones());
  assert.deepEqual(parseTombstones({ recordingIds: [1, 'ok', null] }).recordingIds, ['ok']);
  const idx = toTombstoneIndex(undefined);
  assert.equal(isPurgedRecording(idx, 'anything'), false);
  assert.equal(isPurgedCourseName(idx, 'anything'), false);
});

check('an empty tombstone set never suppresses live content', () => {
  const idx = toTombstoneIndex(emptyTombstones());
  assert.equal(isPurgedRecording(idx, 'rec-1'), false);
  assert.equal(isPurgedCourseName(idx, 'Physics'), false);
  assert.equal(isPurgedRecording(idx, undefined), false);
  assert.equal(isPurgedCourseName(idx, ''), false);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('merge honours tombstones');

check('the merge drops purged rows before materializing anything', () => {
  assert.match(store, /const purged = toTombstoneIndex\(tombstones\);/);
  assert.match(
    store,
    /const liveRemoteRows = remoteRows\.filter\(\(row\) => !isPurgedRecording\(purged, row\.id\)\);/,
  );
  // Lectures are built from the filtered set...
  assert.match(store, /const mergedRemoteLectures = liveRemoteRows\.map\(\(row\) => \{/);
  // ...and so is course derivation.
  assert.match(store, /for \(const row of liveRemoteRows\) \{/);
});

check('a purged course name is never re-derived from a remote row', () => {
  assert.match(store, /if \(isPurgedCourseName\(purged, courseName\)\) continue;/);
});

check('the soft-delete tombstone is carried forward by the deletion merge', () => {
  // Stage 2: deletion is resolved through resolveDeletionState (account-level,
  // no-resurrection). When the remote row carries no deletion decision it keeps
  // the local tombstone forward exactly as before — the local-only guarantee is
  // preserved, now as a special case of the shared merge.
  assert.match(store, /const resolvedDeletion = resolveDeletionState\(\{/);
  assert.match(store, /localDeletedAt: local\?\.deletedAt/);
  assert.match(store, /deletedAt: resolvedDeletion\.deletedAt/);
});

check('device-local audio is preserved across the merge', () => {
  // Same lookup that carries the tombstone carries the local file.
  assert.match(store, /localAudioUri: local\?\.localAudioUri \?\? null/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('permanent delete records a tombstone');

check('permanentlyDeleteLecture purges its remote id before removing it', () => {
  const fn = store.slice(
    store.indexOf('const permanentlyDeleteLecture'),
    store.indexOf('const addMaterial'),
  );
  assert.match(fn, /addPurgedRecordings\(prev, \[remoteId\]\)/);
  assert.match(fn, /prev\.filter\(\(lecture\) => lecture\.id !== id\)/);
});

check('permanentlyDeleteCourse purges the course name and its recordings', () => {
  const fn = store.slice(
    store.indexOf('const permanentlyDeleteCourse'),
    store.indexOf('const permanentlyDeleteLecture'),
  );
  assert.match(fn, /addPurgedRecordings\(prev, purgedRemoteIds\)/);
  assert.match(fn, /addPurgedCourseNames\(next, \[course\.name\]\)/);
});

check('creating a course lifts a matching purge', () => {
  assert.match(store, /clearPurgedCourseName\(prev, course\.name\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('tombstone persistence + stale-response safety');

check('tombstones are persisted per scope and loaded before the merge', () => {
  assert.match(store, /const scopedTombstonesKey = \(userId: string\) =>/);
  assert.match(store, /AsyncStorage\.setItem\(scopedTombstonesKey\(storageScopeId\), JSON\.stringify\(tombstones\)\)/);
  const hydration = store.slice(
    store.indexOf('const sequence = ++hydrateSequence.current;'),
    store.indexOf('const subscription = AppState.addEventListener'),
  );
  const loadAt = hydration.indexOf('tombstonesRef.current = storedTombstones');
  const mergeAt = hydration.indexOf('await applyRemoteRecordings');
  assert.ok(loadAt > 0 && loadAt < mergeAt, 'tombstones must be primed before the merge');
});

check('account switch clears tombstones with the rest of the scope', () => {
  assert.match(store, /setTombstones\(emptyTombstones\(\)\);\s*\n\s*tombstonesRef\.current = emptyTombstones\(\);/);
});

check('the merge reads local state AFTER the network, not a stale snapshot', () => {
  // This is the in-flight race: deleting while a request was open used to be
  // undone by applying the older pre-delete snapshot.
  const fn = store.slice(
    store.indexOf('const applyRemoteRecordings = useCallback'),
    store.indexOf('useEffect', store.indexOf('const applyRemoteRecordings = useCallback')),
  );
  const fetchAt = fn.indexOf('fetchRemoteRecordingsForUser');
  const readAt = fn.indexOf('coursesRef.current');
  assert.ok(fetchAt > 0 && readAt > fetchAt, 'local state must be read after the fetch resolves');
  // Stage 4: the merge also takes the authoritative `courses` rows.
  assert.match(fn, /mergeRemoteRecordingsIntoStore\(\s*liveCourses,\s*liveLectures,\s*remoteRows,\s*remoteCourses,\s*tombstonesRef\.current,?\s*\)/);
});

console.log(`\ndeletion tombstones: ${passed} checks passed`);
