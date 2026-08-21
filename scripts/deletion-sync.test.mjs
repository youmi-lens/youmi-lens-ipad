/**
 * Account-level deletion merge (Cloud Library Stage 2).
 *
 * Pins the no-resurrection invariant: whichever side made the newer explicit
 * deletion decision (by `deletion_updated_at`) wins, and ambiguity never
 * resurrects. Covers the Stage-2 conflict matrix (spec §16 C/D/G).
 */
import assert from 'node:assert/strict';

import { applyDeletionDecision, isDeleted, resolveDeletionState } from '../lib/deletionSync.mjs';

const OLD = '2026-01-01T00:00:00.000Z';
const MID = '2026-06-01T00:00:00.000Z';
const NEW = '2026-12-01T00:00:00.000Z';
const D = '2026-06-01T00:00:00.000Z'; // a deletedAt timestamp

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('no-resurrection core');

check('newer DELETE + older ACTIVE snapshot → stays deleted', () => {
  // remote fetch was ACTIVE (old); local deleted afterward (new).
  const r = resolveDeletionState({
    localDeletedAt: D, localDeletionUpdatedAt: NEW,
    remoteDeletedAt: null, remoteDeletionUpdatedAt: OLD,
  });
  assert.equal(isDeleted(r.deletedAt), true);
  assert.equal(r.source, 'local');
});

check('stale ACTIVE remote (no clock) cannot resurrect a fresh local DELETE', () => {
  const r = resolveDeletionState({
    localDeletedAt: D, localDeletionUpdatedAt: NEW,
    remoteDeletedAt: null, remoteDeletionUpdatedAt: undefined,
  });
  assert.equal(isDeleted(r.deletedAt), true);
});

check('newer remote DELETE overrides a stale local ACTIVE cache', () => {
  const r = resolveDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: OLD,
    remoteDeletedAt: D, remoteDeletionUpdatedAt: NEW,
  });
  assert.equal(isDeleted(r.deletedAt), true);
  assert.equal(r.source, 'remote');
});

console.log('restore only via explicit newer decision');

check('newer RESTORE + older tombstone → restored', () => {
  const r = resolveDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: NEW,   // restored locally
    remoteDeletedAt: D, remoteDeletionUpdatedAt: OLD,     // stale deleted
  });
  assert.equal(r.deletedAt, null);
  assert.equal(r.source, 'local');
});

check('remote RESTORE propagates to a stale local tombstone', () => {
  const r = resolveDeletionState({
    localDeletedAt: D, localDeletionUpdatedAt: OLD,
    remoteDeletedAt: null, remoteDeletionUpdatedAt: NEW,
  });
  assert.equal(r.deletedAt, null);
  assert.equal(r.source, 'remote');
});

check('hydration is NOT restore: an unversioned active side never undoes a tombstone', () => {
  // remote row simply "exists and is active" but carries no deletion decision.
  const r = resolveDeletionState({
    localDeletedAt: D, localDeletionUpdatedAt: MID,
    remoteDeletedAt: null, remoteDeletionUpdatedAt: undefined,
  });
  assert.equal(isDeleted(r.deletedAt), true);
});

console.log('ties & ambiguity');

check('equal clocks → deterministic (local wins the tie, no flip-flop)', () => {
  const a = resolveDeletionState({ localDeletedAt: D, localDeletionUpdatedAt: MID, remoteDeletedAt: null, remoteDeletionUpdatedAt: MID });
  const b = resolveDeletionState({ localDeletedAt: D, localDeletionUpdatedAt: MID, remoteDeletedAt: null, remoteDeletionUpdatedAt: MID });
  assert.deepEqual(a, b);
});

check('both unversioned + either deleted → stays deleted (never resurrect on ambiguity)', () => {
  assert.equal(isDeleted(resolveDeletionState({ localDeletedAt: D, remoteDeletedAt: null }).deletedAt), true);
  assert.equal(isDeleted(resolveDeletionState({ localDeletedAt: null, remoteDeletedAt: D }).deletedAt), true);
});

check('both active → active', () => {
  const r = resolveDeletionState({ localDeletedAt: null, remoteDeletedAt: null });
  assert.equal(r.deletedAt, null);
});

console.log('idempotence & decision stamping');

check('merging twice is stable', () => {
  const once = resolveDeletionState({ localDeletedAt: D, localDeletionUpdatedAt: NEW, remoteDeletedAt: null, remoteDeletionUpdatedAt: OLD });
  const twice = resolveDeletionState({
    localDeletedAt: once.deletedAt, localDeletionUpdatedAt: once.deletionUpdatedAt,
    remoteDeletedAt: null, remoteDeletionUpdatedAt: OLD,
  });
  assert.deepEqual(twice, once);
});

check('applyDeletionDecision stamps delete and restore with the same clock', () => {
  const del = applyDeletionDecision(true, NEW);
  assert.equal(del.deletedAt, NEW);
  assert.equal(del.deletionUpdatedAt, NEW);
  const res = applyDeletionDecision(false, NEW);
  assert.equal(res.deletedAt, null);
  assert.equal(res.deletionUpdatedAt, NEW);
});

console.log(`\ndeletion sync: ${passed} checks passed`);
