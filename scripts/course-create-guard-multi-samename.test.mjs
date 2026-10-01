/**
 * PHYSICAL FAIL takeover (2026-09-12): "create / delete / recreate a same-name
 * Course" kept failing on the owner's iPad even though the delete/recreate
 * contract had shipped and its tests passed.
 *
 * Those tests passed because they were REGEX assertions over store.tsx source
 * ("does the string reason: 'same_name_active' appear"), never a behavioral
 * exercise of the guard. The guard resolved the same-name predecessor with
 * Array#find — the FIRST row sharing the name — so once a name accumulated
 * several tombstones from earlier cycles, a long-resolved one shadowed the row
 * that actually blocked the name, every guard read "clear", and an optimistic
 * duplicate was created straight into a 23505 that the insert path swallows.
 *
 * The fixtures below are the owner's REAL device state, read read-only from
 * the Dev container's youmi.courses.v1.<uid> blob: four rows named "Hhh",
 * three long-confirmed tombstones at array indexes 11/25/27 and the genuinely
 * ACTIVE one last, at index 31. Array#find returned index 11.
 */
import assert from 'node:assert/strict';

import { sameNameCreateBlock } from '../lib/courseCreateGuard.mjs';

// Mirrors store.tsx's own normalizedCourseName contract.
const UNFILED = 'Unfiled';
const normalizeKey = (value) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNFILED;
};
const block = (courses, name) => sameNameCreateBlock(courses, normalizeKey(name).toLowerCase(), normalizeKey);

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const tombstone = (id, name) => ({ id, name, deletedAt: '2026-09-01T20:03:31.664Z', deletionSyncState: undefined });
const active = (id, name) => ({ id, name, deletedAt: null, deletionSyncState: undefined });
const pending = (id, name) => ({ id, name, deletedAt: '2026-09-12T23:20:00.000Z', deletionSyncState: 'pending' });
const failed = (id, name) => ({ id, name, deletedAt: '2026-09-12T23:20:00.000Z', deletionSyncState: 'failed' });

console.log("The owner's real device state — four 'Hhh' rows, ACTIVE one last");

// Exactly the shape pulled off the device: three resolved tombstones, then the
// active row. This is the case that shipped broken.
const ownerDeviceHhh = [
  tombstone('41dad0c1-55a2-4b3c-993c-93dfc7aa19f1', 'Hhh'),
  tombstone('eb0cfd43-3e01-4909-9b90-5a0b0f437cc8', 'Hhh'),
  tombstone('7d8b4ee0-ed07-43eb-babc-54eae0930a59', 'Hhh'),
  active('8c2882d0-b65e-4390-a359-c5b2ad79aa9d', 'Hhh'),
];

check('an ACTIVE namesake blocks creation even when three resolved tombstones sort ahead of it', () => {
  assert.equal(block(ownerDeviceHhh, 'Hhh'), 'same_name_active');
});

check('REGRESSION: first-match resolution would have returned null here (the exact defect)', () => {
  // Demonstrates the old behavior explicitly so this can never silently return.
  const firstMatch = ownerDeviceHhh.find((c) => normalizeKey(c.name).toLowerCase() === 'hhh');
  const oldVerdict = firstMatch && !firstMatch.deletedAt
    ? 'same_name_active'
    : firstMatch?.deletedAt && firstMatch.deletionSyncState === 'failed'
      ? 'delete_failed'
      : firstMatch?.deletedAt && firstMatch.deletionSyncState === 'pending'
        ? 'delete_pending'
        : null;
  assert.equal(oldVerdict, null, 'the old first-match guard let this through');
  assert.notEqual(block(ownerDeviceHhh, 'Hhh'), oldVerdict, 'the fixed guard must not agree with the broken one');
});

console.log('\nThe delete-then-immediately-recreate window (owner acceptance step 5)');

check('a PENDING delete blocks creation even when an older resolved tombstone sorts first', () => {
  const courses = [
    tombstone('old-1', 'Hhh'),
    tombstone('old-2', 'Hhh'),
    pending('just-deleted', 'Hhh'),
  ];
  assert.equal(block(courses, 'Hhh'), 'delete_pending');
});

check('a FAILED delete blocks creation even when an older resolved tombstone sorts first', () => {
  const courses = [tombstone('old-1', 'Hhh'), failed('stuck', 'Hhh')];
  assert.equal(block(courses, 'Hhh'), 'delete_failed');
});

console.log('\nPrecedence — the most authoritative blocker wins');

check('ACTIVE outranks failed and pending', () => {
  const courses = [pending('p', 'Hhh'), failed('f', 'Hhh'), active('a', 'Hhh')];
  assert.equal(block(courses, 'Hhh'), 'same_name_active');
});

check('failed outranks pending (a failed delete needs an explicit retry first)', () => {
  const courses = [pending('p', 'Hhh'), failed('f', 'Hhh')];
  assert.equal(block(courses, 'Hhh'), 'delete_failed');
});

console.log('\nLegitimate recreate must still be allowed (no over-blocking)');

check('all same-name rows confirmed-deleted → creation proceeds', () => {
  assert.equal(block(ownerDeviceHhh.slice(0, 3), 'Hhh'), null);
});

check('a different name is never blocked by an unrelated active course', () => {
  assert.equal(block(ownerDeviceHhh, 'PY105'), null);
});

check('name matching stays case/whitespace-normalized, per store.tsx', () => {
  assert.equal(block([active('a', 'Hhh')], '  hHh '), 'same_name_active');
});

check('empty/blank names collapse to the Unfiled bucket rather than matching everything', () => {
  assert.equal(block([active('a', UNFILED)], '   '), 'same_name_active');
  assert.equal(block([active('a', 'Hhh')], '   '), null);
});

console.log('\nDefensive input handling (the guard runs on every create tap)');

check('empty and nullish course lists are safe', () => {
  assert.equal(block([], 'Hhh'), null);
  assert.equal(sameNameCreateBlock(null, 'hhh', normalizeKey), null);
  assert.equal(sameNameCreateBlock(undefined, 'hhh', normalizeKey), null);
});

console.log(`\ncourse-create-guard-multi-samename: ${passed} checks passed`);
