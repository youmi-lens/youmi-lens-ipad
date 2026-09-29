/**
 * Shared Shape Snap — deterministic geometry + hold fixtures.
 * Seeded synthetic "hand-drawn" strokes (jitter, uneven speed, overshoot,
 * rotation); no randomness escapes the seed.
 * Run: node --experimental-strip-types scripts/shape-snap.test.mjs
 */
import assert from 'node:assert/strict';

import { recognizeShape } from '../lib/shapeSnap.ts';
import { shapeToPoints } from '../lib/annotationShape.ts';
import {
  ShapeHoldTracker, SHAPE_SNAP_HOLD_MS, SHAPE_SNAP_HOLD_TOLERANCE_PT,
} from '../lib/shapeSnapHold.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rot = (p, c, a) => ({ x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a), y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a) });

/** Uneven-speed samples along a polyline, plus jitter. */
function along(vertices, { step = 3, jitter = 0.6, seed = 1, overshoot = 0 } = {}) {
  const r = rng(seed);
  const pts = [];
  const verts = [...vertices];
  for (let i = 1; i < verts.length; i += 1) {
    const a = verts[i - 1];
    const b = verts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = 0;
    while (d < len) {
      const t = d / len;
      pts.push({ x: a.x + (b.x - a.x) * t + (r() - 0.5) * 2 * jitter, y: a.y + (b.y - a.y) * t + (r() - 0.5) * 2 * jitter });
      d += step * (0.4 + r() * 1.4); // uneven drawing speed
    }
  }
  const last = verts[verts.length - 1];
  pts.push({ x: last.x + (r() - 0.5) * jitter, y: last.y + (r() - 0.5) * jitter });
  if (overshoot) {
    const a = verts[0];
    const b = verts[1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (let k = 1; k <= 4; k += 1) pts.push({ x: a.x + ((b.x - a.x) / len) * overshoot * (k / 4), y: a.y + ((b.y - a.y) / len) * overshoot * (k / 4) });
  }
  return pts;
}

function rectPath(cx, cy, w, h, angle, opts) {
  const c = { x: cx, y: cy };
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]]
    .map(([x, y]) => rot({ x: cx + x, y: cy + y }, c, angle));
  return along(corners, opts);
}

function ellipsePath(cx, cy, rx, ry, angle, { n = 90, jitter = 0.01, wobble = 0, seed = 3, span = 1.04 } = {}) {
  const r = rng(seed);
  const c = { x: cx, y: cy };
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const t = ((i / n) * 2 * Math.PI * span) + (r() - 0.5) * 0.05;
    const k = 1 + wobble * Math.sin(3 * t) + (r() - 0.5) * 2 * jitter;
    pts.push(rot({ x: cx + rx * k * Math.cos(t), y: cy + ry * k * Math.sin(t) }, c, angle));
  }
  return pts;
}

console.log('LINE');
check('clean line snaps, anchored at the drawn start and end', () => {
  const pts = along([{ x: 20, y: 30 }, { x: 320, y: 90 }], { jitter: 0 });
  const s = recognizeShape(pts);
  assert.equal(s?.type, 'line');
  assert.deepEqual(s.a, pts[0]);
  assert.deepEqual(s.b, pts[pts.length - 1]);
  assert.deepEqual(shapeToPoints(s, pts), [pts[0], pts[pts.length - 1]]);
});
check('crooked but acceptable line (bow + jitter) snaps', () => {
  const pts = along([{ x: 20, y: 30 }, { x: 320, y: 30 }], { jitter: 1.5, seed: 7 })
    .map((p, i, all) => ({ x: p.x, y: p.y + 6 * Math.sin((i / all.length) * Math.PI) }));
  assert.equal(recognizeShape(pts)?.type, 'line');
});
check('handwriting-like strokes are rejected (cursive loops, zig-zag, wave, tiny stroke)', () => {
  const cursive = [];
  for (let i = 0; i <= 160; i += 1) { const t = i / 160; cursive.push({ x: 20 + t * 240 + 18 * Math.cos(t * 2 * Math.PI * 5), y: 60 + 18 * Math.sin(t * 2 * Math.PI * 5) }); }
  assert.equal(recognizeShape(cursive), null);
  assert.equal(recognizeShape(along([{ x: 0, y: 0 }, { x: 40, y: 50 }, { x: 80, y: 0 }, { x: 120, y: 50 }, { x: 160, y: 0 }], { jitter: 1 })), null);
  const wave = Array.from({ length: 80 }, (_, i) => ({ x: 10 + i * 4, y: 50 + 35 * Math.sin(i / 5) }));
  assert.equal(recognizeShape(wave), null);
  assert.equal(recognizeShape(along([{ x: 0, y: 0 }, { x: 12, y: 3 }], { step: 1, jitter: 0 })), null, 'too small to be intentional');
});
check('an out-and-back scribble on one line is not a line', () => {
  assert.equal(recognizeShape(along([{ x: 0, y: 0 }, { x: 200, y: 4 }, { x: 60, y: 2 }], { jitter: 0.4 })), null);
});

console.log('\nRECTANGLE');
check('clean rectangle', () => {
  const s = recognizeShape(rectPath(300, 200, 220, 120, 0, { jitter: 0 }));
  assert.equal(s?.type, 'rectangle');
  assert.ok(Math.abs(s.width - 220) < 3 && Math.abs(s.height - 120) < 3);
});
check('crooked hand-drawn rectangle with overshoot', () => {
  const s = recognizeShape(rectPath(300, 200, 220, 120, 0.05, { jitter: 2.2, seed: 11, overshoot: 14 }));
  assert.equal(s?.type, 'rectangle');
});
check('rotated rectangle keeps its orientation', () => {
  const s = recognizeShape(rectPath(300, 200, 240, 110, Math.PI / 6, { jitter: 1.2, seed: 5 }));
  assert.equal(s?.type, 'rectangle');
  const a = ((s.angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  assert.ok(Math.abs(a - Math.PI / 6) < 0.12 || Math.abs(a - (Math.PI / 2 - Math.PI / 6)) < 0.12, `angle ${s.angle}`);
});
check('near-axis rectangles are tidied to exactly axis-aligned', () => {
  const s = recognizeShape(rectPath(300, 200, 220, 120, 0.06, { jitter: 0.8, seed: 2 }));
  assert.equal(s?.type, 'rectangle');
  assert.equal(s.angle % (Math.PI / 2), 0);
});
check('open shape / not-closed-enough is rejected ("U", "C", three sides)', () => {
  const three = along([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 0, y: 120 }], { jitter: 1 });
  assert.equal(recognizeShape(three), null);
  const nearly = along([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 0, y: 120 }, { x: 0, y: 80 }], { jitter: 1 });
  assert.equal(recognizeShape(nearly), null, 'a loop stopped a third of a side short must not close');
});
check('a triangle is recognized as a triangle — never a rectangle or an ellipse', () => {
  const r = recognizeShape(along([{ x: 0, y: 200 }, { x: 110, y: 0 }, { x: 220, y: 200 }, { x: 0, y: 200 }], { jitter: 1 }));
  assert.equal(r?.type, 'triangle');
  assert.equal(r.vertices.length, 3);
});

console.log('\nSQUARE');
check('clean square', () => {
  const s = recognizeShape(rectPath(200, 200, 150, 150, 0, { jitter: 0 }));
  assert.equal(s?.type, 'square');
  assert.equal(s.width, s.height);
});
check('slightly uneven square is still a square', () => {
  assert.equal(recognizeShape(rectPath(200, 200, 150, 160, 0, { jitter: 1.4, seed: 9 }))?.type, 'square');
});
check('a rectangle with a clearly different aspect ratio does NOT become a square', () => {
  assert.equal(recognizeShape(rectPath(200, 200, 150, 105, 0, { jitter: 1.2, seed: 4 }))?.type, 'rectangle');
  assert.equal(recognizeShape(rectPath(200, 200, 150, 125, 0, { jitter: 0.6, seed: 4 }))?.type, 'rectangle');
});

console.log('\nCIRCLE');
check('clean circle', () => {
  const s = recognizeShape(ellipsePath(300, 300, 90, 90, 0, { jitter: 0 }));
  assert.equal(s?.type, 'circle');
  assert.ok(Math.abs(s.radius - 90) < 2);
});
check('imperfect hand-drawn circle (wobble, jitter, overlapped closure)', () => {
  assert.equal(recognizeShape(ellipsePath(300, 300, 90, 88, 0, { jitter: 0.02, wobble: 0.025, seed: 21, span: 1.06 }))?.type, 'circle');
});
check('handwriting loops are rejected (tiny loop, tall skinny loop, two-loop spiral, figure-eight)', () => {
  assert.equal(recognizeShape(ellipsePath(50, 50, 9, 9, 0, { jitter: 0 })), null, 'small letter-sized "o"');
  assert.equal(recognizeShape(ellipsePath(50, 90, 12, 70, 0, { jitter: 0.01 })), null, 'tall skinny cursive "l" loop');
  const spiral = Array.from({ length: 200 }, (_, i) => { const t = (i / 200) * 4 * Math.PI; const r = 40 + t * 4; return { x: 200 + r * Math.cos(t), y: 200 + r * Math.sin(t) }; });
  assert.equal(recognizeShape(spiral), null);
  const eight = Array.from({ length: 160 }, (_, i) => { const t = (i / 160) * 2 * Math.PI; return { x: 200 + 90 * Math.sin(t), y: 200 + 60 * Math.sin(2 * t) }; });
  assert.equal(recognizeShape(eight), null);
});

console.log('\nELLIPSE');
check('horizontal ellipse', () => {
  const s = recognizeShape(ellipsePath(300, 300, 130, 65, 0, { jitter: 0.005 }));
  assert.equal(s?.type, 'ellipse');
  assert.ok(Math.abs(s.rx - 130) < 6 && Math.abs(s.ry - 65) < 6);
});
check('rotated ellipse keeps its orientation', () => {
  const s = recognizeShape(ellipsePath(300, 300, 130, 60, Math.PI / 5, { jitter: 0.01, seed: 8 }));
  assert.equal(s?.type, 'ellipse');
  const a = ((s.angle % Math.PI) + Math.PI) % Math.PI;
  assert.ok(Math.abs(a - Math.PI / 5) < 0.12, `angle ${a}`);
});
check('imperfect ellipse', () => {
  assert.equal(recognizeShape(ellipsePath(300, 300, 120, 70, 0, { jitter: 0.02, wobble: 0.02, seed: 13, span: 1.05 }))?.type, 'ellipse');
});
check('non-elliptical closed blobs are rejected (D, egg-with-corner, flat sliver)', () => {
  assert.equal(recognizeShape(along([{ x: 0, y: 0 }, { x: 120, y: 30 }, { x: 240, y: 90 }, { x: 120, y: 150 }, { x: 0, y: 130 }, { x: 0, y: 0 }], { jitter: 1 })), null);
  assert.equal(recognizeShape(ellipsePath(300, 300, 160, 14, 0, { jitter: 0 })), null, 'flat sliver is a line-ish scribble, not an ellipse');
});

console.log('\nUNITS + OUTPUT GEOMETRY');
check('recognition is unit-agnostic (PDF page units vs canvas px): same shape at 0.25x scale with a scaled minSize', () => {
  const big = rectPath(300, 200, 220, 120, 0, { jitter: 1.5, seed: 6 });
  const small = big.map((p) => ({ x: p.x * 0.25, y: p.y * 0.25 }));
  assert.equal(recognizeShape(big)?.type, recognizeShape(small, { minSize: 6 })?.type);
});
check('snapped shapes are ordinary ink points that lie exactly on the clean geometry', () => {
  const rect = rectPath(300, 200, 220, 120, 0, { jitter: 1.5, seed: 6 });
  const s = recognizeShape(rect);
  const pts = shapeToPoints(s, rect);
  assert.ok(pts.length > 100 && pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.deepEqual(pts[0], pts[pts.length - 1], 'closed shapes return to their start');
  for (let i = 1; i < pts.length; i += 1) assert.ok(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) <= 4.01, 'dense enough that midpoint smoothing cannot round corners');
  for (const p of pts) {
    const onV = Math.abs(Math.abs(p.x - s.center.x) - s.width / 2) < 1e-6;
    const onH = Math.abs(Math.abs(p.y - s.center.y) - s.height / 2) < 1e-6;
    assert.ok(onV || onH);
  }
  const start = rect[0];
  assert.ok(Math.hypot(pts[0].x - start.x, pts[0].y - start.y) < 30, 'starts at the corner nearest where the stroke began');
});
check('closed shapes run in the same direction the user drew them', () => {
  const ccw = ellipsePath(300, 300, 90, 90, 0, { jitter: 0 });
  const cw = [...ccw].reverse();
  const area = (pts) => pts.reduce((sum, p, i) => sum + (p.x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * p.y), 0);
  for (const drawn of [ccw, cw]) {
    const s = recognizeShape(drawn);
    assert.equal(Math.sign(area(shapeToPoints(s, drawn))), Math.sign(area(drawn)));
  }
});
check('circle/ellipse output stays on the fitted curve', () => {
  const drawn = ellipsePath(300, 300, 130, 65, 0, { jitter: 0.005 });
  const s = recognizeShape(drawn);
  for (const p of shapeToPoints(s, drawn)) {
    const v = ((p.x - s.center.x) / s.rx) ** 2 + ((p.y - s.center.y) / s.ry) ** 2;
    assert.ok(Math.abs(v - 1) < 1e-9);
  }
});

console.log('\nHOLD DETECTION');
const P = (x, y) => ({ x, y });
function run(events, { holdMs = SHAPE_SNAP_HOLD_MS, unitsPerPt = 1 } = {}) {
  const t = new ShapeHoldTracker();
  t.begin(0, 0, 0);
  let now = 0;
  const tol = SHAPE_SNAP_HOLD_TOLERANCE_PT * unitsPerPt;
  for (const [dt, x, y] of events) { now += dt; t.sample(x, y, now, tol, unitsPerPt); }
  return { t, now };
}
const drawing = Array.from({ length: 20 }, (_, i) => [8, (i + 1) * 5, 0]);
check('no hold: continuous drawing is never eligible', () => {
  const { t, now } = run(drawing);
  assert.equal(t.shouldRecognize(now), false);
  assert.ok(t.remaining(now) > 0);
});
check('short pause does not snap', () => {
  const { t, now } = run(drawing);
  assert.equal(t.shouldRecognize(now + 300), false);
});
check('threshold reached snaps (once)', () => {
  const { t, now } = run(drawing);
  assert.equal(t.shouldRecognize(now + SHAPE_SNAP_HOLD_MS + 1), true);
  t.markFired();
  assert.equal(t.shouldRecognize(now + SHAPE_SNAP_HOLD_MS + 500), false, 'a hold reports once per anchor');
});
check('jitter within tolerance keeps the hold running', () => {
  const { t, now } = run([...drawing, [30, 100.5, 1.2], [30, 99.8, -1.0], [30, 100.9, 0.5]]);
  assert.equal(t.shouldRecognize(now + SHAPE_SNAP_HOLD_MS), true);
});
check('movement during the hold cancels it (timer restarts from the new anchor)', () => {
  const { t, now } = run([...drawing, [400, 100, 0], [400, 100, 0], [100, 130, 0]]);
  assert.equal(t.shouldRecognize(now + 300), false);
  assert.ok(t.remaining(now) > 600);
  assert.equal(t.shouldRecognize(now + SHAPE_SNAP_HOLD_MS + 1), true);
});
check('a fired hold re-arms after real movement', () => {
  const { t, now } = run(drawing);
  t.markFired();
  t.sample(200, 0, now + 900, SHAPE_SNAP_HOLD_TOLERANCE_PT, 1);
  assert.equal(t.fired, false);
});
check('pencil lift before the threshold leaves the original stroke (tracker ended, never eligible)', () => {
  const { t, now } = run(drawing);
  assert.equal(t.shouldRecognize(now + 300), false);
  t.end();
  assert.equal(t.shouldRecognize(now + 5000), false);
});
check('tolerance is zoom-aware: the same on-screen jitter holds at any workspace scale', () => {
  const jitter = [[30, 0.5, 0], [30, 0.6, 0.2]];
  const scaled = (k) => run(Array.from({ length: 20 }, (_, i) => [8, (i + 1) * 5 * k, 0]).concat(jitter.map(([dt, x, y]) => [dt, 100 * k + x * k, y * k])), { unitsPerPt: k });
  for (const k of [0.25, 1, 4]) {
    const { t, now } = scaled(k);
    assert.equal(t.shouldRecognize(now + SHAPE_SNAP_HOLD_MS), true, `scale ${k}`);
  }
});
check('too little stroke (dot or tiny tick) is never eligible', () => {
  const { t, now } = run([[10, 1, 0], [10, 2, 0]]);
  assert.equal(t.shouldRecognize(now + 2000), false);
});

console.log('\nshape-snap: all checks passed');
