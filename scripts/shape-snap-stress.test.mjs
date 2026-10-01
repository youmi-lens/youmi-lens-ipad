/**
 * Shape Snap statistical guard: seeded "human-like" strokes (vertex wobble,
 * jitter, over/undershoot, rotation) — recall must stay high and handwriting-
 * like scribbles must NEVER snap (false negatives are fine, false positives are not).
 * Run: node --experimental-strip-types scripts/shape-snap-stress.test.mjs
 */
import assert from 'node:assert/strict';
import { recognizeShape } from '../lib/shapeSnap.ts';

const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rot = (p, c, a) => ({ x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a), y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a) });

function along(vs, r, jitter, step) {
  const pts = [];
  for (let i = 1; i < vs.length; i++) {
    const a = vs[i - 1], b = vs[i]; const len = Math.hypot(b.x - a.x, b.y - a.y); let d = 0;
    while (d < len) { const t = d / len; pts.push({ x: a.x + (b.x - a.x) * t + (r() - 0.5) * 2 * jitter, y: a.y + (b.y - a.y) * t + (r() - 0.5) * 2 * jitter }); d += step * (0.5 + r()); }
  }
  pts.push({ ...vs[vs.length - 1] });
  return pts;
}
// human-like: low-frequency wobble of each vertex + jitter
function humanRect(seed, w, h, angle) {
  const r = rng(seed); const c = { x: 300, y: 300 }; const wob = () => (r() - 0.5) * 0.10 * Math.min(w, h);
  const cs = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => rot({ x: 300 + x + wob(), y: 300 + y + wob() }, c, angle));
  const overshoot = (r() - 0.3) * 0.12 * w; // may undershoot (gap) or overshoot
  const closed = [...cs, { x: cs[0].x + (cs[1].x - cs[0].x) * (overshoot / w), y: cs[0].y + (cs[1].y - cs[0].y) * (overshoot / w) }];
  return along(closed, r, 1.0, 3);
}
function humanCircle(seed, rx, ry, angle) {
  const r = rng(seed); const c = { x: 300, y: 300 }; const pts = []; const n = 100;
  const a1 = (r() - 0.5) * 0.25, a2 = (r() - 0.5) * 0.25; const span = 2 * Math.PI * (1 + (r() - 0.35) * 0.12);
  for (let i = 0; i <= n; i++) { const t = (i / n) * span; const k = 1 + 0.04 * Math.sin(t + a1 * 6) + 0.03 * Math.sin(2 * t + a2 * 6) + (r() - 0.5) * 0.02;
    pts.push(rot({ x: 300 + rx * k * Math.cos(t), y: 300 + ry * k * Math.sin(t) }, c, angle)); }
  return pts;
}
function humanLine(seed, len, angle) {
  const r = rng(seed); const bow = (r() - 0.5) * 0.08 * len; const pts = []; const n = 60;
  for (let i = 0; i <= n; i++) { const t = i / n; const u = t * len; const v = bow * Math.sin(t * Math.PI) + (r() - 0.5) * 2;
    pts.push(rot({ x: 100 + u, y: 300 + v }, { x: 100, y: 300 }, angle)); }
  return pts;
}
function scribble(seed) { // handwriting-like: smoothed random walk with loops
  const r = rng(seed); const pts = []; let x = 50, y = 100, a = 0; const n = 120 + Math.floor(r() * 120);
  for (let i = 0; i < n; i++) { a += (r() - 0.5) * 1.6; x += Math.cos(a) * 4; y += Math.sin(a) * 4; pts.push({ x, y }); }
  return pts;
}

const N = 200;
const count = (gen) => { const got = {}; for (let s = 1; s <= N; s += 1) { const r = recognizeShape(gen(s)); const k = r ? r.type : 'none'; got[k] = (got[k] || 0) + 1; } return got; };
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };

check('handwriting-like scribbles NEVER snap (0 false positives)', () => {
  assert.deepEqual(count(scribble), { none: N });
});
check('hand-drawn rectangles: >= 92% recognized, never as a circle/ellipse/line', () => {
  const got = count((s) => humanRect(s, 220, 120, (((s + 999) % 7) / 7 - 0.5) * 0.6));
  assert.ok((got.rectangle ?? 0) / N >= 0.92, JSON.stringify(got));
  assert.equal((got.circle ?? 0) + (got.ellipse ?? 0) + (got.line ?? 0), 0, JSON.stringify(got));
});
check('hand-drawn squares: >= 88% recognized as square, none as circle/ellipse/line', () => {
  const got = count((s) => humanRect(s, 150, 150, (((s + 5) % 7) / 7 - 0.5) * 0.6));
  assert.ok((got.square ?? 0) / N >= 0.88, JSON.stringify(got));
  assert.equal((got.circle ?? 0) + (got.ellipse ?? 0) + (got.line ?? 0), 0, JSON.stringify(got));
});
check('hand-drawn circles: >= 95% recognized as circle, never a rectangle', () => {
  const got = count((s) => humanCircle(s, 90, 90, 0));
  assert.ok((got.circle ?? 0) / N >= 0.95, JSON.stringify(got));
  assert.equal((got.rectangle ?? 0) + (got.square ?? 0), 0, JSON.stringify(got));
});
check('hand-drawn ellipses: >= 92% recognized as ellipse, never a rectangle', () => {
  const got = count((s) => humanCircle(s, 130, 65, (((s + 7) % 11) / 11 - 0.5) * 3));
  assert.ok((got.ellipse ?? 0) / N >= 0.92, JSON.stringify(got));
  assert.equal((got.rectangle ?? 0) + (got.square ?? 0), 0, JSON.stringify(got));
});
check('hand-drawn lines: >= 95% recognized as line', () => {
  const got = count((s) => humanLine(s, 300, (((s + 3) % 13) / 13 - 0.5) * 6));
  assert.ok((got.line ?? 0) / N >= 0.95, JSON.stringify(got));
});
console.log('\nshape-snap-stress: all checks passed');
