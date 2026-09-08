/**
 * Cloud soft-delete delivery contract.
 *
 * The remote schema is additive, but delivery must be all-or-retry: a local
 * tombstone cannot masquerade as an account-level deletion when either
 * canonical field is rejected or unavailable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = readFileSync(new URL('../lib/store.tsx', import.meta.url), 'utf8');
const deletedScreen = readFileSync(new URL('../app/recently-deleted.tsx', import.meta.url), 'utf8');
let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const writer = store.slice(store.indexOf('const syncLectureDeletion ='), store.indexOf('const updateLecture ='));
const deleteOne = store.slice(store.indexOf('const deleteLecture = useCallback'), store.indexOf('const deleteLectures = useCallback'));
const deleteMany = store.slice(store.indexOf('const deleteLectures = useCallback'), store.indexOf('const deleteCourse = useCallback'));

check('canonical cloud delete writes exactly the two deletion-state fields together', () => {
  assert.match(writer, /\.update\(\{ deleted_at: deletedAt, deletion_updated_at: deletionUpdatedAt \}\)/);
  assert.match(writer, /\.select\('id'\)/);
  assert.doesNotMatch(writer, /storage_path|transcript|summary|audio/);
});

check('a failed delete remains durable locally and transitions to retryable failure', () => {
  assert.match(writer, /deletionSyncState: 'failed'/);
  assert.match(writer, /deletionSyncError: 'Could not sync this deletion/);
  assert.match(writer, /\(data \?\? \[\]\)\.length !== remoteIds\.length/);
  assert.match(deleteOne, /deletionSyncState: 'pending'/);
  assert.match(deleteMany, /deletionSyncState: 'pending'/);
});

check('retry reuses the original remote id and deletion freshness, without cloning lecture content', () => {
  const retry = store.slice(store.indexOf('const retryLectureDeletion ='), store.indexOf('const deleteLectures = useCallback'));
  assert.match(retry, /lecture\.remoteRecordingId/);
  assert.match(retry, /lecture\.deletedAt, lecture\.deletionUpdatedAt/);
  assert.doesNotMatch(retry, /createLecture|insert\(|storage_path/);
});

check('Recently Deleted makes an unconfirmed cloud deletion visible and retryable', () => {
  assert.match(deletedScreen, /Cloud deletion was not confirmed/);
  assert.match(deletedScreen, /Retry sync/);
  assert.match(deletedScreen, /retryLectureDeletion/);
});

check('a canonical remote merge clears a stale local delivery failure', () => {
  assert.match(store, /resolvedDeletion\.source === 'remote' \? undefined : local\?\.deletionSyncState/);
});

console.log(`\ncloud delete delivery: ${passed} checks passed`);
