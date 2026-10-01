/**
 * LINE is physically accepted and FROZEN. This pins the exact Phase 1 line behavior:
 * `scripts/fixtures/shape-snap-line-baseline.json` was generated from the Phase 1
 * engine (the build the owner physically accepted) over a deterministic corpus of
 * lines and line-like near-misses. Any change to what snaps as a line, or to its
 * anchored endpoints, fails here.
 * Run: node --experimental-strip-types scripts/shape-snap-line-regression.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { recognizeShape } from '../lib/shapeSnap.ts';
import { shapeToPoints } from '../lib/annotationShape.ts';
import { SHAPE_SNAP_HOLD_MS, SHAPE_SNAP_HOLD_TOLERANCE_PT, SHAPE_SNAP_MIN_SAMPLES, SHAPE_SNAP_MIN_TRAVEL_PT } from '../lib/shapeSnapHold.ts';
import { lineCorpus } from './fixtures/shape-snap-line-corpus.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(readFileSync(path.join(dir, 'fixtures/shape-snap-line-baseline.json'), 'utf8'));
const corpus = lineCorpus();
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };

check('the corpus is the same size as the pinned baseline', () => assert.equal(corpus.length, expected.length));
check('every stroke gets the IDENTICAL Line decision and anchored endpoints as the accepted Phase 1 engine', () => {
  let lines = 0;
  corpus.forEach((c, i) => {
    const r = recognizeShape(c.points, { minSize: 24 });
    const want = expected[i];
    assert.equal(c.name, want.name);
    assert.equal(r ? r.type : 'none', want.type, `${c.name}: decision changed`);
    if (want.type === 'line') {
      lines += 1;
      assert.deepEqual([+r.a.x.toFixed(6), +r.a.y.toFixed(6)], want.a, `${c.name}: start anchor moved`);
      assert.deepEqual([+r.b.x.toFixed(6), +r.b.y.toFixed(6)], want.b, `${c.name}: end anchor moved`);
    }
  });
  assert.equal(lines, 155);
});
check('a snapped line is still exactly two points: the drawn start and the final Pencil position', () => {
  const c = corpus.find((x) => expected[corpus.indexOf(x)].type === 'line');
  const r = recognizeShape(c.points, { minSize: 24 });
  assert.deepEqual(shapeToPoints(r, c.points), [c.points[0], c.points[c.points.length - 1]]);
});
check('the hold semantics accepted by the owner are unchanged (650 ms, 3.5 pt, 8 samples, 30 pt travel)', () => {
  assert.equal(SHAPE_SNAP_HOLD_MS, 650);
  assert.equal(SHAPE_SNAP_HOLD_TOLERANCE_PT, 3.5);
  assert.equal(SHAPE_SNAP_MIN_SAMPLES, 8);
  assert.equal(SHAPE_SNAP_MIN_TRAVEL_PT, 30);
});
console.log('\nshape-snap-line-regression: all checks passed');
