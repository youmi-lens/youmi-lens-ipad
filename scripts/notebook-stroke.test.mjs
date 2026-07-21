/**
 * Focused pure tests for notebook stroke helpers + structural render-cost model.
 * Run: node --experimental-strip-types scripts/notebook-stroke.test.mjs
 */
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NOTEBOOK_MIN_POINT_DISTANCE,
  appendStrokePoint,
  pathBuildsPerActivePoint,
  reduceLiveInkAction,
  shouldAcceptStrokePoint,
  snapshotLiveInkPoints,
  strokeToPath,
  synthesizeStrokePoints,
} from '../lib/notebookStroke.ts';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

check('empty stroke path', () => {
  assert.equal(strokeToPath([]), '');
});

check('single-point stroke path is a tiny segment (dot fallback)', () => {
  const d = strokeToPath([{ x: 10, y: 20 }]);
  assert.equal(d, 'M 10 20 L 10.1 20');
});

check('multi-point path uses quadratic midpoints', () => {
  const d = strokeToPath([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ]);
  assert.match(d, /^M 0 0/);
  assert.match(d, /Q 10 0 15 0/);
  assert.match(d, /L 20 0$/);
});

check('point filter rejects near-duplicates', () => {
  assert.equal(shouldAcceptStrokePoint({ x: 0, y: 0 }, { x: 0.5, y: 0 }), false);
  assert.equal(shouldAcceptStrokePoint({ x: 0, y: 0 }, { x: 3, y: 0 }), true);
  assert.equal(NOTEBOOK_MIN_POINT_DISTANCE, 1.8);
});

check('appendStrokePoint mutates in place and skips near points', () => {
  const points = [{ x: 0, y: 0 }];
  assert.equal(appendStrokePoint(points, { x: 0.2, y: 0 }), false);
  assert.equal(points.length, 1);
  assert.equal(appendStrokePoint(points, { x: 5, y: 0 }), true);
  assert.equal(points.length, 2);
  assert.deepEqual(points[1], { x: 5, y: 0 });
});

check('malformed / empty append still starts from first point', () => {
  const points = [];
  assert.equal(appendStrokePoint(points, { x: 1, y: 2 }), true);
  assert.deepEqual(points, [{ x: 1, y: 2 }]);
});

check('structural cost: without memoization path builds scale with page density', () => {
  assert.equal(
    pathBuildsPerActivePoint({ completedStrokeCount: 100, completedStrokesMemoized: false }),
    101,
  );
  assert.equal(
    pathBuildsPerActivePoint({ completedStrokeCount: 500, completedStrokesMemoized: false }),
    501,
  );
});

check('structural cost: with memoized completed layer only active path rebuilds', () => {
  assert.equal(
    pathBuildsPerActivePoint({ completedStrokeCount: 100, completedStrokesMemoized: true }),
    1,
  );
  assert.equal(
    pathBuildsPerActivePoint({ completedStrokeCount: 500, completedStrokesMemoized: true }),
    1,
  );
});

check('T1 long stroke: path generation stays finite and non-empty', () => {
  const points = synthesizeStrokePoints(2000);
  const d = strokeToPath(points);
  assert.ok(d.length > 100);
  assert.ok(d.startsWith('M '));
});

check('T2/T4 rapid short strokes: filter keeps distinct samples', () => {
  const points = [];
  const samples = [
    { x: 0, y: 0 },
    { x: 0.1, y: 0 },
    { x: 4, y: 0 },
    { x: 4.2, y: 0 },
    { x: 8, y: 1 },
  ];
  for (const sample of samples) appendStrokePoint(points, sample);
  assert.equal(points.length, 3);
});

check('history immutability helper: commit copies points', () => {
  const live = synthesizeStrokePoints(5);
  const committed = live.map((p) => ({ ...p }));
  live.push({ x: 999, y: 999 });
  assert.equal(committed.length, 5);
  assert.equal(committed.some((p) => p.x === 999), false);
});

check('snapshotLiveInkPoints returns a new array reference', () => {
  const source = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  const snap = snapshotLiveInkPoints(source);
  assert.notEqual(snap, source);
  assert.deepEqual(snap, source);
  source[0].x = 99;
  assert.equal(snap[0].x, 1);
});

check('Pencil down creates live stroke; move grows it before up', () => {
  let state = { live: [], committed: [] };
  state = reduceLiveInkAction(state, { type: 'down', point: { x: 0, y: 0 } });
  assert.equal(state.live.length, 1);
  assert.equal(state.committed.length, 0);

  state = reduceLiveInkAction(state, { type: 'move', point: { x: 5, y: 0 } });
  assert.equal(state.live.length, 2);
  assert.equal(state.committed.length, 0);

  state = reduceLiveInkAction(state, { type: 'move', point: { x: 10, y: 0 } });
  assert.equal(state.live.length, 3);
  // Continuous visibility: live points are in the "render set" before Pencil up.
  assert.ok(state.live.length > 0);
  assert.equal(state.committed.length, 0);

  state = reduceLiveInkAction(state, { type: 'up' });
  assert.equal(state.live.length, 0);
  assert.equal(state.committed.length, 1);
  assert.equal(state.committed[0].length, 3);
});

check('finger down/move never create or extend live ink', () => {
  let state = { live: [], committed: [] };
  state = reduceLiveInkAction(state, { type: 'finger-down', point: { x: 0, y: 0 } });
  assert.equal(state.live.length, 0);
  state = reduceLiveInkAction(state, { type: 'finger-move', point: { x: 20, y: 0 } });
  assert.equal(state.live.length, 0);
  assert.equal(state.committed.length, 0);

  state = reduceLiveInkAction(state, { type: 'down', point: { x: 0, y: 0 } });
  state = reduceLiveInkAction(state, { type: 'finger-move', point: { x: 40, y: 0 } });
  assert.equal(state.live.length, 1);
});

check('ActiveInkHost drives render from livePoints state (not void revision)', () => {
  const canvasPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'components',
    'NotebookCanvas.tsx',
  );
  const source = fs.readFileSync(canvasPath, 'utf8');
  assert.match(source, /const \[livePoints, setLivePoints\] = useState/);
  assert.match(source, /setLivePoints\(pointsRef\.current\.slice\(\)\)/);
  assert.equal(source.includes('void revision'), false);
  assert.equal(/const \[revision, setRevision\] = useState/.test(source), false);
  assert.match(source, /PointerType\.STYLUS/);
  assert.match(source, /\.manualActivation\(true\)/);
});

// T3 density cost table (synthetic — not physical Pencil timing)
const densityRows = [0, 100, 500].map((n) => ({
  completed: n,
  before: pathBuildsPerActivePoint({ completedStrokeCount: n, completedStrokesMemoized: false }),
  after: pathBuildsPerActivePoint({ completedStrokeCount: n, completedStrokesMemoized: true }),
}));
console.log('density path-build model:', JSON.stringify(densityRows));

console.log(`\nnotebook-stroke: ${passed} checks passed`);
