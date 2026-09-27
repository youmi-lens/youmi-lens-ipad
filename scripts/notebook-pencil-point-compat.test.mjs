/** Backward-compatibility regression for the additive `p?`/`t?` NotePoint
 * fields (Phase 3B-2): historical `{x, y}` points must keep working exactly
 * as before, and new `{x, y, p, t}` points must round-trip through the
 * existing pure stroke helpers without being stripped.
 * Run: node --experimental-strip-types --test scripts/notebook-pencil-point-compat.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendStrokePoint,
  shouldAcceptStrokePoint,
  snapshotLiveInkPoints,
  strokeToPath,
} from '../lib/notebookStroke.ts';

test('snapshotLiveInkPoints preserves p/t on new-style points (does not silently strip them)', () => {
  const points = [{ x: 1, y: 2, p: 0.6, t: 111 }, { x: 3, y: 4, p: null, t: 222 }];
  const snapshot = snapshotLiveInkPoints(points);
  assert.deepEqual(snapshot, points);
  // Must be a real copy (new array + new objects), not the same references —
  // this is the property ActiveInkHost relies on to force a React update.
  assert.notEqual(snapshot, points);
  assert.notEqual(snapshot[0], points[0]);
});

test('snapshotLiveInkPoints still works for historical {x, y}-only points', () => {
  const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  const snapshot = snapshotLiveInkPoints(points);
  assert.deepEqual(snapshot, points);
  assert.equal('p' in snapshot[0], false, 'must not fabricate a p field on old points');
  assert.equal('t' in snapshot[0], false, 'must not fabricate a t field on old points');
});

test('shouldAcceptStrokePoint / appendStrokePoint distance filtering is unaffected by extra p/t fields', () => {
  const points = [];
  assert.equal(appendStrokePoint(points, { x: 0, y: 0, p: 0.1, t: 1 }), true);
  // Too close (< default 1.8) — rejected regardless of pressure/timestamp.
  assert.equal(appendStrokePoint(points, { x: 0.5, y: 0, p: 0.9, t: 2 }), false);
  assert.equal(points.length, 1);
  assert.equal(shouldAcceptStrokePoint(points[0], { x: 5, y: 0, p: null, t: 3 }), true);
});

test('strokeToPath renders identically whether or not points carry p/t — Phase 3B-2 changes no rendering', () => {
  const legacy = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }];
  const withPressure = legacy.map((pt, i) => ({ ...pt, p: 0.1 * i, t: i * 16 }));
  assert.equal(strokeToPath(legacy), strokeToPath(withPressure));
});
