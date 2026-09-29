/**
 * Shape Snap false-positive guard (Phase 1B): handwriting, doodles and
 * non-Phase-1 shapes + hold must NOT commonly become a shape. Prefer no snap.
 * Sizes are chosen at real handwriting scale AND at deliberately large scale.
 * Run: node --experimental-strip-types scripts/shape-snap-false-positives.test.mjs
 */
import assert from 'node:assert/strict';
import { recognizeShape } from '../lib/shapeSnap.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const jitter = (pts, r, amp) => pts.map((p) => ({ x: p.x + (r() - 0.5) * amp, y: p.y + (r() - 0.5) * amp }));
const arc = (cx, cy, rx, ry, t0, t1, n = 40) => Array.from({ length: n + 1 }, (_, i) => { const t = t0 + ((t1 - t0) * i) / n; return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) }; });
const seg = (a, b, n = 12) => Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
const poly = (vs, n = 14) => vs.slice(1).flatMap((v, i) => seg(vs[i], v, n));

// Letters (y down). `s` = x-height in units. Real handwriting is ~20-40 screen pt.
const letterO = (s, r) => jitter(arc(50, 50, s * 0.5, s * 0.6, 0, 2 * Math.PI * 1.04), r, s * 0.04);
const letterA = (s, r) => jitter([...arc(50, 50, s * 0.5, s * 0.5, -0.4, -0.4 - 2 * Math.PI), ...seg({ x: 50 + s * 0.45, y: 50 - s * 0.3 }, { x: 50 + s * 0.5, y: 50 + s * 1.05 })], r, s * 0.04);
const letterE = (s, r) => jitter([...seg({ x: 50 - s * 0.5, y: 50 }, { x: 50 + s * 0.5, y: 50 }), ...arc(50, 50, s * 0.5, s * 0.5, 0, -Math.PI * 1.75, 30)], r, s * 0.04);
const letterG = (s, r) => jitter([...arc(50, 50, s * 0.5, s * 0.5, -0.4, -0.4 - 2 * Math.PI), ...seg({ x: 50 + s * 0.5, y: 50 - s * 0.4 }, { x: 50 + s * 0.5, y: 50 + s * 1.3 }), ...arc(50, 50 + s * 1.3, s * 0.5, s * 0.5, 0, Math.PI, 15)], r, s * 0.04);
const digit8 = (s, r) => jitter([...arc(50, 50 - s * 0.5, s * 0.42, s * 0.5, Math.PI / 2, Math.PI / 2 + 2 * Math.PI, 30), ...arc(50, 50 + s * 0.55, s * 0.5, s * 0.55, -Math.PI / 2, -Math.PI / 2 - 2 * Math.PI, 36)], r, s * 0.04);
const cursiveL = (s, r) => jitter([...seg({ x: 40, y: 50 + s }, { x: 50, y: 50 - s * 1.5 }), ...arc(56, 50 - s * 1.5, s * 0.3, s * 0.5, Math.PI, -Math.PI * 1.1, 24), ...seg({ x: 50, y: 50 - s }, { x: 62, y: 50 + s })], r, s * 0.04);
const cursiveWord = (s, r) => { const pts = []; for (let k = 0; k < 4; k++) pts.push(...arc(40 + k * s * 0.9, 50, s * 0.35, s * 0.45, Math.PI, -Math.PI * 1.9, 18)); return jitter(pts, r, s * 0.05); };
const scribble = (seed, size) => { const r = rng(seed); const pts = []; let x = 100, y = 100, a = 0; for (let i = 0; i < 160; i++) { a += (r() - 0.5) * 1.8; x += Math.cos(a) * size / 25; y += Math.sin(a) * size / 25; pts.push({ x, y }); } return pts; };
const blob = (seed, size) => { const r = rng(seed); const ph = [r() * 6, r() * 6, r() * 6]; return Array.from({ length: 100 }, (_, i) => { const t = (i / 99) * 2 * Math.PI; const k = 1 + 0.32 * Math.sin(2 * t + ph[0]) + 0.28 * Math.sin(3 * t + ph[1]) + 0.2 * Math.sin(5 * t + ph[2]); return { x: 200 + size * k * Math.cos(t), y: 200 + size * k * Math.sin(t) }; }); };
const triangle = (seed, size) => { const r = rng(seed); const v = [0, 1, 2].map((i) => ({ x: 200 + size * (Math.cos(i * 2.09 + r()) * (0.8 + 0.4 * r())), y: 200 + size * (Math.sin(i * 2.09 + r()) * (0.8 + 0.4 * r())) })); return jitter(poly([...v, v[0]], 16), r, 1.2); };
const star = (size) => { const v = [0, 2, 4, 1, 3, 0].map((k) => ({ x: 200 + size * Math.cos(-Math.PI / 2 + (k * 2 * Math.PI) / 5), y: 200 + size * Math.sin(-Math.PI / 2 + (k * 2 * Math.PI) / 5) })); return poly(v, 14); };
const heart = (size) => Array.from({ length: 120 }, (_, i) => { const t = (i / 119) * 2 * Math.PI; return { x: 200 + size * 0.06 * 16 * Math.sin(t) ** 3, y: 200 - size * 0.06 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) }; });
const partialBox = (seed, w, h, drawnOfLastSide) => { const r = rng(seed); const path = poly([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: h * (1 - drawnOfLastSide) }], 16); return jitter(path.map((p) => ({ x: p.x + 100, y: p.y + 100 })), r, 1.6); };
const spiral = (turns, size) => Array.from({ length: 200 }, (_, i) => { const t = (i / 199) * 2 * Math.PI * turns; const rad = size * (0.3 + 0.7 * (i / 199)); return { x: 200 + rad * Math.cos(t), y: 200 + rad * Math.sin(t) }; });
const zigzag = (size) => poly([0, 1, 2, 3, 4, 5].map((i) => ({ x: 100 + i * size / 4, y: 100 + (i % 2) * size / 2 })), 10);
const sCurve = (size) => [...arc(100, 100, size / 4, size / 4, -Math.PI / 2, Math.PI / 2, 24), ...arc(100, 100 + size / 2, size / 4, size / 4, -Math.PI / 2, -Math.PI * 1.5, 24)];

function rate(gen, seeds = 60) {
  let snapped = 0;
  const types = {};
  for (let s = 1; s <= seeds; s += 1) { const r = recognizeShape(gen(s), { minSize: 24 }); if (r) { snapped += 1; types[r.type] = (types[r.type] || 0) + 1; } }
  return { snapped, types };
}
const expectNone = (label, gen, seeds = 60) => { const { snapped, types } = rate(gen, seeds); assert.equal(snapped, 0, `${label}: ${snapped}/${seeds} snapped ${JSON.stringify(types)}`); };

console.log('Handwriting at real scale (x-height 16-34): never snaps');
for (const [name, fn] of [['o', letterO], ['a', letterA], ['e', letterE], ['g', letterG], ['8', digit8], ['cursive l', cursiveL], ['cursive word', cursiveWord]]) {
  check(`"${name}" at x-height 16..34`, () => { for (const s of [16, 22, 28, 34]) expectNone(`${name}@${s}`, (seed) => fn(s, rng(seed)), 25); });
}
console.log('\nLarge / non-Phase-1 doodles: never snap');
check('e, g, 8 and cursive strokes even when written LARGE (x-height 90)', () => {
  for (const fn of [letterE, letterG, digit8, cursiveL, cursiveWord]) expectNone(fn.name, (seed) => fn(90, rng(seed)), 25);
});
check('the letter "a" (circle + stem) is not a circle even when large', () => expectNone('a large', (seed) => letterA(90, rng(seed)), 25));
check('scribbles and random walks', () => { expectNone('scribble', (s) => scribble(s, 300)); expectNone('scribble small', (s) => scribble(s, 120)); });
check('random closed blobs', () => expectNone('blob', (s) => blob(s, 80)));
check('triangles are now a supported shape: they snap as TRIANGLES and never as a rectangle/circle/ellipse', () => {
  for (const size of [90, 160]) for (let seed = 1; seed <= 40; seed += 1) {
    const r = recognizeShape(triangle(seed, size), { minSize: 24 });
    assert.ok(!r || r.type === 'triangle', `triangle seed ${seed} became ${r?.type}`);
  }
});
check('stars, hearts, spirals, S-curves, zig-zags', () => {
  expectNone('star', () => star(90), 1);
  expectNone('heart', () => heart(80), 1);
  expectNone('spiral 2', () => spiral(2, 90), 1);
  expectNone('spiral 3', () => spiral(3, 90), 1);
  expectNone('S', () => sCurve(160), 1);
  expectNone('zigzag', () => zigzag(200), 1);
});
check('partial boxes (the last side only 40-60% drawn, i.e. >=8% of the perimeter open) never close', () => { expectNone('drawn 0.4', (s) => partialBox(s, 200, 120, 0.4)); expectNone('drawn 0.6', (s) => partialBox(s, 200, 120, 0.6)); });
check('an underline IS a line (intended) — and a wavy underline is not', () => {
  assert.equal(recognizeShape(poly([{ x: 0, y: 0 }, { x: 260, y: 3 }], 40), { minSize: 24 })?.type, 'line');
  assert.equal(recognizeShape(Array.from({ length: 80 }, (_, i) => ({ x: i * 4, y: 22 * Math.sin(i / 4) })), { minSize: 24 }), null);
});
console.log('\nshape-snap-false-positives: all checks passed');
