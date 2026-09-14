/**
 * PHYSICAL FAIL (2026-09-13): a fresh disposable course "iii" was created and
 * deleted on the iPad. The cloud row updated correctly, but the app marked the
 * deletion `failed` — "Could not confirm this course change in the cloud. Retry
 * from Recently Deleted." — which then (correctly) made the new same-name create
 * guard refuse to recreate "iii".
 *
 * Proven cause: syncCourseDeletion confirmed its own write with
 *   row.deletion_updated_at === deletionUpdatedAt
 * `courses.deletion_updated_at` is `timestamptz` (see
 * supabase-staging-migration-cloud-library-stage4-courses-superset.sql) with no
 * trigger rewriting it, so PostgREST returns `+00:00` (often with six-digit
 * microseconds) while the client sends `new Date().toISOString()`, ending in
 * `Z`. Same instant, never the same string → confirmation failed 100% of the
 * time, for deletes AND for restores (restoreCourse runs the same path), so the
 * error's own advice ("Retry from Recently Deleted") could never succeed either.
 *
 * The literal values below are the real incident, read read-only from the Dev
 * container's youmi.courses.v1.<uid> blob.
 */
import assert from 'node:assert/strict';

import { confirmsDeletionWrite } from '../lib/deletionSync.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

// --- the actual "iii" incident -------------------------------------------
const III_SENT = '2026-09-13T03:42:49.974Z';          // client: new Date().toISOString()
const III_RETURNED = '2026-09-13T03:42:49.974+00:00'; // PostgREST: timestamptz

console.log('The real "iii" incident (a07b2831-7bb4-4a66-8a46-8cac8b91b5b5)');

check('REGRESSION: the old byte-identical compare rejected this successful write', () => {
  assert.equal(III_RETURNED === III_SENT, false, 'the two forms are never string-equal');
});

check('a successful delete is now confirmed despite the Z vs +00:00 difference', () => {
  assert.equal(confirmsDeletionWrite({
    rowDeletedAt: III_RETURNED,
    rowDeletionUpdatedAt: III_RETURNED,
    sentDeletedAt: III_SENT,
    sentDeletionUpdatedAt: III_SENT,
  }), true);
});

check('microsecond precision from timestamptz still confirms (same instant to the ms)', () => {
  assert.equal(confirmsDeletionWrite({
    rowDeletedAt: '2026-09-13T03:42:49.974000+00:00',
    rowDeletionUpdatedAt: '2026-09-13T03:42:49.974000+00:00',
    sentDeletedAt: III_SENT,
    sentDeletionUpdatedAt: III_SENT,
  }), true);
});

check('a restore (deleted_at -> null) is confirmed too — it was equally broken', () => {
  assert.equal(confirmsDeletionWrite({
    rowDeletedAt: null,
    rowDeletionUpdatedAt: III_RETURNED,
    sentDeletedAt: null,
    sentDeletionUpdatedAt: III_SENT,
  }), true);
});

console.log('\nConfirmation must still prove the write is genuinely ours');

check('a stale PRE-EXISTING tombstone is not mistaken for our write (older clock)', () => {
  // Stricter than the old code, which accepted any truthy deleted_at.
  assert.equal(confirmsDeletionWrite({
    rowDeletedAt: '2026-09-01T20:03:31.664+00:00',
    rowDeletionUpdatedAt: '2026-09-01T20:03:31.664+00:00',
    sentDeletedAt: III_SENT,
    sentDeletionUpdatedAt: III_SENT,
  }), false);
});

check("a NEWER clock from another device is accepted — our write landed, theirs superseded it", () => {
  assert.equal(confirmsDeletionWrite({
    rowDeletedAt: '2026-09-13T03:45:00.000+00:00',
    rowDeletionUpdatedAt: '2026-09-13T03:45:00.000+00:00',
    sentDeletedAt: III_SENT,
    sentDeletionUpdatedAt: III_SENT,
  }), true);
});

check('a delete that did not apply (row still active) is NOT confirmed', () => {
  assert.equal(confirmsDeletionWrite({
    rowDeletedAt: null,
    rowDeletionUpdatedAt: III_RETURNED,
    sentDeletedAt: III_SENT,
    sentDeletionUpdatedAt: III_SENT,
  }), false);
});

check('a restore that did not apply (row still deleted) is NOT confirmed', () => {
  assert.equal(confirmsDeletionWrite({
    rowDeletedAt: III_RETURNED,
    rowDeletionUpdatedAt: III_RETURNED,
    sentDeletedAt: null,
    sentDeletionUpdatedAt: III_SENT,
  }), false);
});

console.log('\nMalformed / missing data can never read as confirmed');

check('missing or unparseable clocks are not confirmed', () => {
  for (const rowClock of [null, undefined, '', 'not-a-date']) {
    assert.equal(confirmsDeletionWrite({
      rowDeletedAt: III_RETURNED,
      rowDeletionUpdatedAt: rowClock,
      sentDeletedAt: III_SENT,
      sentDeletionUpdatedAt: III_SENT,
    }), false, `rowDeletionUpdatedAt=${String(rowClock)}`);
  }
  assert.equal(confirmsDeletionWrite({
    rowDeletedAt: III_RETURNED,
    rowDeletionUpdatedAt: III_RETURNED,
    sentDeletedAt: III_SENT,
    sentDeletionUpdatedAt: 'not-a-date',
  }), false);
});

check('an empty call is not confirmed', () => {
  assert.equal(confirmsDeletionWrite(), false);
  assert.equal(confirmsDeletionWrite({}), false);
});

console.log('\nWiring: store.tsx must not compare these clocks as raw strings again');

const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const store = readFileSync(fileURLToPath(new URL('../lib/store.tsx', import.meta.url)), 'utf8');

check('syncCourseDeletion delegates confirmation to confirmsDeletionWrite', () => {
  assert.match(store, /confirmed = row != null && confirmsDeletionWrite\(\{/);
  assert.doesNotMatch(
    store,
    /row\.deletion_updated_at === deletionUpdatedAt/,
    'byte-identical timestamp confirmation must never come back',
  );
});

check('the exact-UUID and exact-user filters are still enforced', () => {
  const syncFn = store.slice(store.indexOf('const syncCourseDeletion ='), store.indexOf('const applyRemoteRecordings ='));
  assert.match(syncFn, /\.eq\('id', courseId\)/);
  assert.match(syncFn, /\.eq\('user_id', currentUserId\)/);
  assert.match(syncFn, /\.select\('id,deleted_at,deletion_updated_at'\)/);
  assert.match(syncFn, /\(data \?\? \[\]\)\.find\(\(item\) => item\.id === courseId\)/);
});

console.log(`\ncourse-deletion-confirm-timestamp: ${passed} checks passed`);
