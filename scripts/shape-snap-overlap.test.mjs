/**
 * Shape Snap Phase 1B: REAL hand-drawn loops overshoot / overlap their start and flick on
 * pen-lift. Phase 1 rejected essentially all of them (closure gap + hook-inflated fit /
 * turning gates); the loop-extraction rework must keep them snapping while the
 * false-positive suites keep handwriting as ink.
 * Run: node --experimental-strip-types scripts/shape-snap-overlap.test.mjs
 */
import assert from 'node:assert/strict';
import { recognizeShape } from '../lib/shapeSnap.ts';

const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rot = (p, c, a) => ({ x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a), y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a) });

// Realistic closed loops: overlap past the start (real people overshoot), a lift hook at the end, and a start hook.
function ellipseLoop(seed, rx, ry, angle, overlap, hook) {
  const r = rng(seed); const c = { x: 300, y: 300 }; const pts = []; const n = 110;
  const span = 2 * Math.PI * (1 + overlap);
  const t0 = r() * 2 * Math.PI;
  for (let i = 0; i <= n; i++) {
    const t = t0 + (i / n) * span;
    const k = 1 + 0.035 * Math.sin(t * 2 + seed) + 0.02 * Math.sin(3 * t) + (r() - 0.5) * 0.01 + 0.02 * (i / n); // slight spiral drift
    pts.push(rot({ x: 300 + rx * k * Math.cos(t), y: 300 + ry * k * Math.sin(t) }, c, angle));
  }
  if (hook) { // small flick at the end, like a pen-lift
    const last = pts.at(-1), prev = pts.at(-4);
    const dx = last.x - prev.x, dy = last.y - prev.y;
    for (let k = 1; k <= 3; k++) pts.push({ x: last.x + dx * 0.25 * k + dy * 0.2 * k, y: last.y + dy * 0.25 * k - dx * 0.2 * k });
  }
  return pts;
}
function rectLoop(seed, w, h, angle, overlap, hook) {
  const r = rng(seed); const c = { x: 300, y: 300 };
  const wob = () => (r() - 0.5) * 0.10 * Math.min(w, h);
  const cs = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: 300 + x + wob(), y: 300 + y + wob() }));
  // rounded corners + bowed sides
  const pts = []; const sides = [...cs, cs[0]];
  const startSide = Math.floor(r() * 4); const ring = [];
  for (let i = 0; i < 4; i++) ring.push([cs[(startSide + i) % 4], cs[(startSide + i + 1) % 4]]);
  const total = 4 + overlap * 4; // sides to traverse (overshoot continues around)
  for (let sIdx = 0; sIdx < Math.ceil(total); sIdx++) {
    const [a, b] = ring[sIdx % 4]; const frac = Math.min(1, total - sIdx);
    const len = Math.hypot(b.x - a.x, b.y - a.y); const steps = Math.ceil((len * frac) / 3);
    for (let k = 0; k < steps; k++) {
      const t = (k / steps) * frac; const bow = Math.sin(t * Math.PI) * 0.03 * len * (sIdx % 2 ? 1 : -1);
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      pts.push({ x: a.x + (b.x - a.x) * t + nx * bow + (r() - 0.5) * 1.6, y: a.y + (b.y - a.y) * t + ny * bow + (r() - 0.5) * 1.6 });
    }
  }
  // round the corners a little by moving-average smoothing
  const sm = pts.map((p, i) => { let x = 0, y = 0, n = 0; for (let k = -4; k <= 4; k++) { const q = pts[Math.min(pts.length - 1, Math.max(0, i + k))]; x += q.x; y += q.y; n++; } return { x: x / n, y: y / n }; });
  if (hook) { const last = sm.at(-1), prev = sm.at(-5); const dx = last.x - prev.x, dy = last.y - prev.y; for (let k = 1; k <= 3; k++) sm.push({ x: last.x + dx * 0.25 * k - dy * 0.2 * k, y: last.y + dy * 0.25 * k + dx * 0.2 * k }); }
  return sm.map((p) => rot(p, c, angle));
}

const N = 100;
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const share = (gen, ...types) => { let n = 0; for (let s = 1; s <= N; s += 1) { const r = recognizeShape(gen(s), { minSize: 24 }); if (r && types.includes(r.type)) n += 1; } return n / N; };

for (const overlap of [0, 0.1, 0.2, 0.3]) {
  check(`circles with ${overlap * 100}% overlap and a pen-lift hook snap (>= 96%)`, () => assert.ok(share((s) => ellipseLoop(s, 90, 90, 0, overlap, true), 'circle') >= 0.96));
  check(`ellipses with ${overlap * 100}% overlap and a pen-lift hook snap (>= 96%)`, () => assert.ok(share((s) => ellipseLoop(s, 130, 70, (rng(s)() - 0.5) * 2, overlap, true), 'ellipse') >= 0.96));
}
for (const overlap of [0, 0.15, 0.3]) {
  check(`rectangles with ${overlap * 100}% overshoot and a hook snap (>= 96%)`, () => assert.ok(share((s) => rectLoop(s, 220, 130, (rng(s + 3)() - 0.5) * 0.4, overlap, true), 'rectangle') >= 0.96));
  check(`squares with ${overlap * 100}% overshoot and a hook snap as square or rectangle (>= 96%), mostly square`, () => {
    assert.ok(share((s) => rectLoop(s, 150, 150, (rng(s + 9)() - 0.5) * 0.4, overlap, true), 'square', 'rectangle') >= 0.96);
    assert.ok(share((s) => rectLoop(s, 150, 150, (rng(s + 9)() - 0.5) * 0.4, overlap, true), 'square') >= 0.8);
  });
}
console.log('\nshape-snap-overlap: all checks passed');
