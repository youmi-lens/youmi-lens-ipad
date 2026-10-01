/**
 * Triangle recognition (Shape System Phase 2): any clear three-sided polygon — scalene,
 * rotated, rounded corners, overshoot, small closure gap, pen-lift hook — while
 * rectangles, circles, ellipses and handwriting are NOT triangles.
 * Run: node --experimental-strip-types scripts/shape-snap-triangle.test.mjs
 */
import assert from 'node:assert/strict';
import { recognizeShape } from '../lib/shapeSnap.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const seg = (a, b, r, step, jit) => { const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step)); return Array.from({ length: n }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n + (r() - 0.5) * jit, y: a.y + ((b.y - a.y) * i) / n + (r() - 0.5) * jit })); };
const rot = (p, c, a) => ({ x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a), y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a) });
const smooth = (pts, k) => pts.map((p, i) => { let x = 0, y = 0, n = 0; for (let d = -k; d <= k; d++) { const q = pts[Math.min(pts.length - 1, Math.max(0, i + d))]; x += q.x; y += q.y; n++; } return { x: x / n, y: y / n }; });

/** A hand-drawn triangle: wobbly vertices, jitter, rounded corners, optional overshoot / gap / hook. */
function triangle(seed, { size = 140, wobble = 0.06, round = 3, overshoot = 0, gap = 0, hook = false, scalene = true, angle = null } = {}) {
  const r = rng(seed);
  const a0 = angle ?? r() * 6.28;
  const v = [0, 1, 2].map((i) => {
    const rad = size * (scalene ? 0.7 + r() * 0.5 : 1);
    return rot({ x: 300 + rad, y: 300 }, { x: 300, y: 300 }, a0 + (i * 2 * Math.PI) / 3 + (scalene ? (r() - 0.5) * 0.7 : 0));
  }).map((p) => ({ x: p.x + (r() - 0.5) * wobble * size, y: p.y + (r() - 0.5) * wobble * size }));
  const sides = [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]];
  let pts = sides.flatMap(([a, b]) => seg(a, b, r, 3, 1.4));
  if (overshoot) pts = pts.concat(seg(v[0], v[1], r, 3, 1.0).slice(0, Math.ceil(overshoot * 40)));
  if (gap) pts = pts.slice(0, pts.length - Math.ceil(gap * pts.length));
  pts = smooth(pts, round);
  if (hook) { const last = pts.at(-1), prev = pts.at(-5); const dx = last.x - prev.x, dy = last.y - prev.y; for (let k = 1; k <= 3; k += 1) pts.push({ x: last.x + dx * 0.25 * k - dy * 0.2 * k, y: last.y + dy * 0.25 * k + dx * 0.2 * k }); }
  return pts;
}
const share = (gen, type, n = 100) => { let c = 0; for (let s = 1; s <= n; s += 1) if (recognizeShape(gen(s), { minSize: 24 })?.type === type) c += 1; return c / n; };

check('clean triangle', () => { const r = recognizeShape(triangle(1, { wobble: 0, round: 0, scalene: false })); assert.equal(r?.type, 'triangle'); assert.equal(r.vertices.length, 3); });
check('rough triangles (wobble, jitter, rounded corners) snap (>= 95%)', () => assert.ok(share((s) => triangle(s), 'triangle') >= 0.95));
check('scalene, obtuse and right-ish triangles all qualify — no equilateral/isosceles requirement (>= 95%)', () => assert.ok(share((s) => triangle(s + 500, { scalene: true, wobble: 0.04 }), 'triangle') >= 0.95));
check('rotated triangles at every orientation (>= 95%)', () => { let c = 0; const n = 72; for (let i = 0; i < n; i += 1) if (recognizeShape(triangle(i + 1, { angle: (i / n) * 6.283, wobble: 0.03 }))?.type === 'triangle') c += 1; assert.ok(c / n >= 0.95, `${c}/${n}`); });
check('overshoot past the start corner still snaps (>= 95%)', () => assert.ok(share((s) => triangle(s + 900, { overshoot: 0.5, wobble: 0.04 }), 'triangle') >= 0.95));
check('a slight closure gap still snaps (>= 90%)', () => assert.ok(share((s) => triangle(s + 300, { gap: 0.04, wobble: 0.04 }), 'triangle') >= 0.9));
check('a pen-lift hook still snaps (>= 95%)', () => assert.ok(share((s) => triangle(s + 700, { hook: true, wobble: 0.04 }), 'triangle') >= 0.95));
check('the snapped vertices sit close to the drawn corners (within 12% of the size)', () => {
  const pts = triangle(4, { wobble: 0, round: 0, scalene: false, angle: 0.3 });
  const r = recognizeShape(pts);
  const drawnCorners = [0, 1, 2].map((i) => ({ x: pts[Math.floor((pts.length * i) / 3)].x, y: pts[Math.floor((pts.length * i) / 3)].y }));
  for (const c of drawnCorners) assert.ok(Math.min(...r.vertices.map((v) => Math.hypot(v.x - c.x, v.y - c.y))) < 140 * 0.12);
});

console.log('\nNot triangles');
const rectPath = (seed, w, h) => { const r = rng(seed); const c = [[0, 0], [w, 0], [w, h], [0, h], [0, 0]].map(([x, y]) => ({ x: 100 + x, y: 100 + y })); return smooth(c.slice(1).flatMap((p, i) => seg(c[i], p, r, 3, 1.4)), 2); };
const ellipsePath = (seed, rx, ry) => { const r = rng(seed); return Array.from({ length: 100 }, (_, i) => { const t = (i / 99) * 2 * Math.PI * 1.03; const k = 1 + (r() - 0.5) * 0.04 + 0.03 * Math.sin(3 * t + seed); return { x: 300 + rx * k * Math.cos(t), y: 300 + ry * k * Math.sin(t) }; }); };
check('rectangles and squares are never triangles (and still snap as rectangles/squares)', () => {
  for (let s = 1; s <= 80; s += 1) { const r = recognizeShape(rectPath(s, 200, 130), { minSize: 24 }); assert.notEqual(r?.type, 'triangle'); const q = recognizeShape(rectPath(s, 150, 150), { minSize: 24 }); assert.notEqual(q?.type, 'triangle'); }
  assert.ok(share((s) => rectPath(s, 200, 130), 'rectangle') >= 0.9);
});
check('circles and ellipses are never triangles (and still snap as circles/ellipses)', () => {
  for (let s = 1; s <= 80; s += 1) { assert.notEqual(recognizeShape(ellipsePath(s, 90, 90), { minSize: 24 })?.type, 'triangle'); assert.notEqual(recognizeShape(ellipsePath(s, 130, 70), { minSize: 24 })?.type, 'triangle'); }
  assert.ok(share((s) => ellipsePath(s, 90, 90), 'circle') >= 0.9);
  assert.ok(share((s) => ellipsePath(s, 130, 70), 'ellipse') >= 0.9);
});
check('handwriting-like loops and scribbles are not triangles', () => {
  const scribble = (seed) => { const r = rng(seed); const pts = []; let x = 100, y = 100, a = 0; for (let i = 0; i < 160; i++) { a += (r() - 0.5) * 1.8; x += Math.cos(a) * 8; y += Math.sin(a) * 8; pts.push({ x, y }); } return pts; };
  for (let s = 1; s <= 80; s += 1) assert.equal(recognizeShape(scribble(s), { minSize: 24 }), null);
  const blob = (seed) => { const r = rng(seed); const ph = [r() * 6, r() * 6, r() * 6]; return Array.from({ length: 100 }, (_, i) => { const t = (i / 99) * 2 * Math.PI; const k = 1 + 0.32 * Math.sin(2 * t + ph[0]) + 0.28 * Math.sin(3 * t + ph[1]) + 0.2 * Math.sin(5 * t + ph[2]); return { x: 200 + 80 * k * Math.cos(t), y: 200 + 80 * k * Math.sin(t) }; }); };
  for (let s = 1; s <= 80; s += 1) assert.equal(recognizeShape(blob(s), { minSize: 24 }), null, `blob ${s}`);
});
check('a sliver "triangle" (needle) and an open V are rejected', () => {
  assert.equal(recognizeShape(triangle(1, { size: 140, wobble: 0 , scalene: false }).map((p) => ({ x: 300 + (p.x - 300) * 0.05, y: p.y })), { minSize: 24 }), null);
  assert.equal(recognizeShape([...seg({ x: 0, y: 0 }, { x: 100, y: 200 }, rng(1), 3, 1), ...seg({ x: 100, y: 200 }, { x: 200, y: 0 }, rng(2), 3, 1)], { minSize: 24 })?.type === 'triangle', false);
});
console.log('\nshape-snap-triangle: all checks passed');
