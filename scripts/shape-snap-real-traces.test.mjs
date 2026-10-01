/**
 * Real Apple Pencil traces captured from the owner's physical device
 * (scripts/fixtures/shape-snap-real-traces.json: geometry only). Replayed through the
 * SHARED recognizer exactly as recorded — no synthetic approximation.
 *  - the real rough rectangle (with its start/end pen hooks) MUST snap;
 *  - the real triangles MUST snap as triangles (Phase 2);
 *  - the real scribble / stray line-with-tail MUST stay ink.
 * More real traces (squares, circles, ellipses) are added here from the Dev capture log.
 * Run: node --experimental-strip-types scripts/shape-snap-real-traces.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { recognizeShapeDetailed } from '../lib/shapeSnap.ts';

const traces = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/shape-snap-real-traces.json'), 'utf8'));
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
// Production passes minSize in workspace units = 24 screen pt / zoom; Course Material page units are ~1.3 pt/unit at fit.
const run = (t) => recognizeShapeDetailed(t.points.map(([x, y]) => ({ x, y })), { minSize: t.unit === 'pdf-page' ? 24 / 1.3 : 24 });
const byLabel = (label) => traces.find((t) => t.label === label);

check('the real rough rectangle snaps (it failed on the device before Phase 1B: pen hooks pushed turning to 7.4 rad)', () => {
  const d = run(byLabel('rectangle'));
  assert.ok(d.result && (d.result.type === 'rectangle' || d.result.type === 'square'), JSON.stringify(d.reasons));
});
check('all four real triangles snap as TRIANGLES with three vertices (Phase 2)', () => {
  for (const label of ['triangle-1', 'triangle-2', 'triangle-3', 'triangle-4']) {
    const d = run(byLabel(label));
    assert.equal(d.result?.type, 'triangle', `${label}: ${JSON.stringify(d.reasons)}`);
    assert.equal(d.result.vertices.length, 3);
    assert.ok(d.metrics.triMean < 0.046, `${label} fits with real margin (mean ${d.metrics.triMean})`);
  }
});
check('the real zig-zag scribble and the stray vertical line-with-tail stay ink', () => {
  assert.equal(run(byLabel('zigzag-scribble')).result, null);
  assert.equal(run(byLabel('vertical-line-with-tail')).result, null);
});
check('the rejection reasons are explained (used by the Dev capture log)', () => {
  for (const t of traces) { const d = run(t); if (!d.result) assert.ok(d.reasons.length > 0, t.label); }
});
console.log('\nshape-snap-real-traces: all checks passed');
