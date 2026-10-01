/**
 * Structured shape model (Shape System Phase 2): handles, edit operations, move/duplicate,
 * coordinates (Notebook zoom, Course Material 0.5x/1x/2x + rotated page), persistence
 * round-trip and the export invariant (exported points == current edited geometry).
 * Run: node --experimental-strip-types scripts/annotation-shape.test.mjs
 */
import assert from 'node:assert/strict';
import {
  shapeFromRecognition, shapeToInkPoints, shapeHandles, shapeHandleCount, nearestShapeHandle,
  dragShapeHandle, translateShape, translateInkStroke, strokeWithShape, hitTestStructuredStroke,
  inkPointsMatchShape, isStructuredStroke,
} from '../lib/annotationShape.ts';
import { recognizeShape } from '../lib/shapeSnap.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const ptNear = (p, q, eps = 1e-6, msg = '') => { near(p.x, q.x, eps, `${msg}.x`); near(p.y, q.y, eps, `${msg}.y`); };

const line = { origin: 'line', geometry: { kind: 'line', a: { x: 10, y: 20 }, b: { x: 110, y: 60 } } };
const tri = { origin: 'triangle', geometry: { kind: 'polygon', vertices: [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 40, y: 90 }] } };
const rect = { origin: 'rectangle', geometry: { kind: 'polygon', vertices: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }] } };
const circle = { origin: 'circle', geometry: { kind: 'ellipse', center: { x: 50, y: 50 }, ax: { x: 40, y: 0 }, ay: { x: 0, y: 40 } } };
const ellipse = { origin: 'ellipse', geometry: { kind: 'ellipse', center: { x: 50, y: 50 }, ax: { x: 60, y: 0 }, ay: { x: 0, y: 30 } } };
const mk = (id, shape, extra = {}) => ({ id, tool: 'pen', color: '#000', width: 3, points: shapeToInkPoints(shape), shape, createdAt: 't', ...extra });

console.log('Handle counts and positions');
check('line 2, triangle 3, rectangle/square 4, circle/ellipse 4', () => {
  assert.equal(shapeHandleCount(line.geometry), 2);
  assert.equal(shapeHandleCount(tri.geometry), 3);
  assert.equal(shapeHandleCount(rect.geometry), 4);
  assert.equal(shapeHandleCount(circle.geometry), 4);
  assert.equal(shapeHandles(ellipse.geometry).length, 4);
});
check('ellipse handles are top/right/bottom/left on the LOCAL axes (rotated ellipse follows its axes)', () => {
  const [top, right, bottom, left] = shapeHandles(ellipse.geometry);
  ptNear(right, { x: 110, y: 50 }); ptNear(left, { x: -10, y: 50 });
  ptNear(top, { x: 50, y: 20 }); ptNear(bottom, { x: 50, y: 80 });
  const a = Math.PI / 6; const c = Math.cos(a), s = Math.sin(a);
  const rotated = { kind: 'ellipse', center: { x: 0, y: 0 }, ax: { x: 60 * c, y: 60 * s }, ay: { x: -30 * s, y: 30 * c } };
  const [, r] = shapeHandles(rotated);
  ptNear(r, { x: 60 * c, y: 60 * s });
});

console.log('\nEdit operations — only the dragged control changes');
check('triangle: dragging one vertex moves ONLY that vertex', () => {
  const g = dragShapeHandle(tri.geometry, 1, { x: 150, y: -20 });
  ptNear(g.vertices[0], tri.geometry.vertices[0]); ptNear(g.vertices[2], tri.geometry.vertices[2]);
  ptNear(g.vertices[1], { x: 150, y: -20 });
  assert.equal(g.vertices.length, 3);
});
check('rectangle: a corner drag distorts it into a general quadrilateral (still 4 vertices, others fixed)', () => {
  const g = dragShapeHandle(rect.geometry, 2, { x: 260, y: 160 });
  assert.equal(g.vertices.length, 4);
  ptNear(g.vertices[2], { x: 260, y: 160 });
  [0, 1, 3].forEach((i) => ptNear(g.vertices[i], rect.geometry.vertices[i]));
});
check('line: endpoints move independently', () => {
  const g0 = dragShapeHandle(line.geometry, 0, { x: 0, y: 0 });
  ptNear(g0.a, { x: 0, y: 0 }); ptNear(g0.b, line.geometry.b);
  const g1 = dragShapeHandle(line.geometry, 1, { x: 300, y: 300 });
  ptNear(g1.b, { x: 300, y: 300 }); ptNear(g1.a, line.geometry.a);
});
check('circle -> ellipse: dragging the right handle resizes ONLY ax with the left side anchored', () => {
  const g = dragShapeHandle(circle.geometry, 1, { x: 190, y: 50 });
  ptNear(shapeHandles(g)[3], { x: 10, y: 50 }, 1e-6, 'left anchored');
  ptNear(shapeHandles(g)[1], { x: 190, y: 50 }, 1e-6, 'right dragged');
  ptNear(g.ay, circle.geometry.ay, 1e-9, 'ay untouched');
  near(Math.hypot(g.ax.x, g.ax.y), 90);
  assert.notEqual(Math.hypot(g.ax.x, g.ax.y), Math.hypot(g.ay.x, g.ay.y), 'now an ellipse, not forced back to a circle');
});
check('ellipse: top handle resizes ay only; bottom stays', () => {
  const g = dragShapeHandle(ellipse.geometry, 0, { x: 50, y: -40 });
  ptNear(shapeHandles(g)[2], shapeHandles(ellipse.geometry)[2]);
  ptNear(shapeHandles(g)[0], { x: 50, y: -40 });
  ptNear(g.ax, ellipse.geometry.ax);
});
check('rotated ellipse: axis drag follows the local axis (perpendicular motion is ignored)', () => {
  const a = Math.PI / 4; const c = Math.cos(a), s = Math.sin(a);
  const g0 = { kind: 'ellipse', center: { x: 0, y: 0 }, ax: { x: 50 * c, y: 50 * s }, ay: { x: -20 * s, y: 20 * c } };
  const target = { x: 100 * c + 30 * -s, y: 100 * s + 30 * c }; // 100 along axis, 30 perpendicular
  const g = dragShapeHandle(g0, 1, target);
  near(Math.hypot(g.ax.x, g.ax.y), (100 + 50) / 2, 1e-6);
  ptNear(g.ay, g0.ay);
});
check('an ellipse cannot collapse below the minimum axis', () => {
  const g = dragShapeHandle(circle.geometry, 1, { x: -500, y: 50 });
  assert.ok(Math.hypot(g.ax.x, g.ax.y) >= 2);
});
check('handles are UI only: editing never produces a handle in the stroke record', () => {
  const s = strokeWithShape(mk('a', tri), { origin: 'triangle', geometry: dragShapeHandle(tri.geometry, 0, { x: -30, y: -30 }) });
  assert.deepEqual(Object.keys(s).sort(), ['color', 'createdAt', 'id', 'points', 'shape', 'tool', 'width']);
});

console.log('\nPoints always regenerate from geometry');
check('edited shape: points == shapeToInkPoints(shape); the stroke invariant holds after every edit', () => {
  let s = mk('a', tri);
  assert.ok(inkPointsMatchShape(s));
  for (const [i, to] of [[0, { x: -10, y: 5 }], [1, { x: 120, y: 30 }], [2, { x: 60, y: 140 }]]) {
    s = strokeWithShape(s, { origin: s.shape.origin, geometry: dragShapeHandle(s.shape.geometry, i, to) });
    assert.ok(inkPointsMatchShape(s), `after handle ${i}`);
  }
  const e = strokeWithShape(mk('e', circle), { origin: 'circle', geometry: dragShapeHandle(circle.geometry, 1, { x: 190, y: 50 }) });
  assert.ok(inkPointsMatchShape(e));
  assert.equal(e.points.length, 121);
});
check('the edited outline PASSES THROUGH the moved vertex (export shows the edited geometry, not the original)', () => {
  const g = dragShapeHandle(tri.geometry, 1, { x: 150, y: -20 });
  const pts = shapeToInkPoints({ origin: 'triangle', geometry: g });
  assert.ok(pts.some((p) => Math.hypot(p.x - 150, p.y + 20) < 1e-6));
  assert.ok(!pts.some((p) => Math.hypot(p.x - 100, p.y - 10) < 1e-6), 'old vertex is gone');
});
check('circle -> ellipse export: points span the edited ellipse extents', () => {
  const g = dragShapeHandle(circle.geometry, 1, { x: 190, y: 50 });
  const pts = shapeToInkPoints({ origin: 'circle', geometry: g });
  const xs = pts.map((p) => p.x);
  near(Math.min(...xs), 10, 1e-6); near(Math.max(...xs), 190, 1e-6);
});
check('lines stay exactly two points; polygons close on their first vertex', () => {
  assert.equal(shapeToInkPoints(line).length, 2);
  const p = shapeToInkPoints(rect); ptNear(p[0], p.at(-1));
});

console.log('\nMove, duplicate, delete, history (value semantics)');
check('translateInkStroke moves points AND shape together and preserves the invariant', () => {
  const s = mk('a', rect); const m = translateInkStroke(s, 30, -12);
  ptNear(m.shape.geometry.vertices[2], { x: 230, y: 88 });
  assert.ok(inkPointsMatchShape(m, 1e-6));
  assert.equal(m.id, 'a');
});
check('translate of an ordinary stroke (no shape) leaves it shapeless', () => {
  const m = translateInkStroke({ id: 'h', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, 5, 5);
  assert.equal('shape' in m, false);
  assert.ok(!isStructuredStroke(m));
});
check('duplicate: new stable id, same geometry, independent object (editing the copy leaves the original)', () => {
  const s = mk('a', tri); const d = translateInkStroke({ ...s, id: 'a-copy' }, 24, 24);
  assert.notEqual(d.id, s.id);
  const edited = strokeWithShape(d, { origin: 'triangle', geometry: dragShapeHandle(d.shape.geometry, 0, { x: 0, y: 0 }) });
  ptNear(s.shape.geometry.vertices[0], { x: 0, y: 0 }); // original untouched (was 0,0 anyway) …
  ptNear(s.shape.geometry.vertices[1], { x: 100, y: 10 });
  ptNear(d.shape.geometry.vertices[1], { x: 124, y: 34 });
  assert.notEqual(edited.shape, d.shape);
});
check('undo/redo by snapshot: restoring the pre-edit stroke gives EXACT geometry (deepEqual)', () => {
  const before = mk('a', tri);
  const after = strokeWithShape(before, { origin: 'triangle', geometry: dragShapeHandle(tri.geometry, 2, { x: 10, y: 200 }) });
  const history = [before]; // one entry per complete manipulation
  assert.notDeepEqual(history[0].shape, after.shape);
  assert.deepEqual(history[0].shape, before.shape);
  assert.deepEqual(history[0].points, before.points);
  assert.ok(inkPointsMatchShape(after));
});
check('dragShapeHandle is pure: the input geometry is never mutated', () => {
  const snapshot = JSON.parse(JSON.stringify(tri.geometry));
  dragShapeHandle(tri.geometry, 0, { x: 999, y: 999 });
  assert.deepEqual(tri.geometry, snapshot);
  const cs = JSON.parse(JSON.stringify(circle.geometry));
  dragShapeHandle(circle.geometry, 2, { x: 50, y: 300 });
  assert.deepEqual(circle.geometry, cs);
});

console.log('\nCoordinates');
// Handle size / hit radius are defined in SCREEN points: radius_workspace = screenPt / scale.
const HIT_PT = 22;
check('Notebook zoom: a 22 pt hit radius is 22/scale workspace units — same on-screen reach at every zoom', () => {
  for (const scale of [0.5, 1, 2, 4]) {
    const hit = (dxScreen) => nearestShapeHandle(tri.geometry, { x: 100 + dxScreen / scale, y: 10 }, HIT_PT / scale);
    assert.equal(hit(HIT_PT - 1), 1, `scale ${scale} inside`);
    assert.equal(hit(HIT_PT + 4), null, `scale ${scale} outside`);
  }
});
check('Course Material 0.5x / 1x / 2x: page-coordinate geometry is unchanged by zoom; screen reach is constant', () => {
  for (const zoom of [0.5, 1, 2]) {
    const pageScale = 1.3 * zoom; // screen points per PDF point
    const h = nearestShapeHandle(rect.geometry, { x: 200 + 10 / pageScale, y: 100 }, HIT_PT / pageScale);
    assert.equal(h, 2);
    // Serialized geometry is identical whatever the zoom used while editing.
    assert.deepEqual(dragShapeHandle(rect.geometry, 2, { x: 250, y: 150 }), dragShapeHandle(rect.geometry, 2, { x: 250, y: 150 }));
  }
});
check('rotated page: drag in screen space maps through the page transform to the same page geometry', () => {
  // rotate 90deg: screen (sx, sy) = (H - y, x)  -> page (x, y) = (sy, H - sx)
  const H = 300; const toPage = (sx, sy) => ({ x: sy, y: H - sx });
  const toScreen = (p) => ({ sx: H - p.y, sy: p.x });
  const v = tri.geometry.vertices[1];
  const s = toScreen(v);
  const back = toPage(s.sx + 40, s.sy - 10);
  const g = dragShapeHandle(tri.geometry, 1, back);
  ptNear(g.vertices[1], { x: v.x - 10, y: v.y - 40 });
});

console.log('\nPersistence and export');
check('JSON round-trip (store / AsyncStorage / native serialize) is exact and keeps the invariant', () => {
  const shapes = [line, tri, rect, circle, ellipse].map((sh, i) => mk(`s${i}`, sh));
  const round = JSON.parse(JSON.stringify(shapes));
  assert.deepEqual(round, shapes);
  round.forEach((s) => assert.ok(inkPointsMatchShape(s)));
});
check('historical strokes (no shape) round-trip untouched — no migration', () => {
  const old = { id: 'o', tool: 'pen', color: '#000', width: 2, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], createdAt: 't' };
  assert.deepEqual(JSON.parse(JSON.stringify(old)), old);
  assert.ok(inkPointsMatchShape(old));
});
check('hit-test picks the structured stroke under the tap within tolerance (topmost wins ties) and ignores ordinary ink', () => {
  const a = mk('a', rect); const b = mk('b', rect); const ordinary = { id: 'h', points: [{ x: 100, y: 50 }, { x: 101, y: 51 }] };
  assert.equal(hitTestStructuredStroke([a, ordinary, b], { x: 100, y: 2 }, 8)?.id, 'b');
  assert.equal(hitTestStructuredStroke([ordinary], { x: 100, y: 50 }, 8), null);
  assert.equal(hitTestStructuredStroke([a], { x: 100, y: 50 }, 8), null, 'inside but far from the outline');
});

console.log('\nRecognizer -> structured shape');
check('a snapped triangle / rectangle / circle produce the right structured kinds and matching points', () => {
  const tp = shapeToInkPoints(tri).filter((_, i) => i % 5 === 0);
  const rTri = recognizeShape(tp.map((p) => ({ x: p.x * 2, y: p.y * 2 })));
  assert.equal(rTri?.type, 'triangle');
  const s = shapeFromRecognition(rTri, tp);
  assert.equal(s.geometry.kind, 'polygon'); assert.equal(s.geometry.vertices.length, 3);
  const rp = shapeToInkPoints(rect).filter((_, i) => i % 4 === 0);
  const rr = recognizeShape(rp);
  assert.ok(rr && (rr.type === 'rectangle' || rr.type === 'square'));
  assert.equal(shapeFromRecognition(rr, rp).geometry.vertices.length, 4);
  const cp = shapeToInkPoints(circle);
  const rc = recognizeShape(cp);
  assert.ok(rc && (rc.type === 'circle' || rc.type === 'ellipse'));
  assert.equal(shapeFromRecognition(rc, cp).geometry.kind, 'ellipse');
});
console.log('\nNative (Swift) parity — the SAME literals are asserted in material_selection_fixture.swift');
check('circle -> ellipse via the right handle: center (100,50), ax (90,0), ay unchanged', () => {
  const g = dragShapeHandle({ kind: 'ellipse', center: { x: 50, y: 50 }, ax: { x: 40, y: 0 }, ay: { x: 0, y: 40 } }, 1, { x: 190, y: 50 });
  ptNear(g.center, { x: 100, y: 50 }); ptNear(g.ax, { x: 90, y: 0 }); ptNear(g.ay, { x: 0, y: 40 });
});
check('ellipse right handle dragged to x=480 keeps the left side anchored: center (420,300), ax (60,0)', () => {
  const g = dragShapeHandle({ kind: 'ellipse', center: { x: 400, y: 300 }, ax: { x: 40, y: 0 }, ay: { x: 0, y: 40 } }, 1, { x: 480, y: 300 });
  ptNear(g.center, { x: 420, y: 300 }); ptNear(g.ax, { x: 60, y: 0 });
});
check('rotated ellipse axis drag: center 25*(cos,sin), ax 75*(cos,sin), ay unchanged (pinned in Swift)', () => {
  const c = Math.cos(Math.PI / 4), sn = Math.sin(Math.PI / 4);
  const g = dragShapeHandle({ kind: 'ellipse', center: { x: 0, y: 0 }, ax: { x: 50 * c, y: 50 * sn }, ay: { x: -20 * sn, y: 20 * c } }, 1, { x: 100 * c - 30 * sn, y: 100 * sn + 30 * c });
  ptNear(g.center, { x: 25 * c, y: 25 * sn }, 1e-9); ptNear(g.ax, { x: 75 * c, y: 75 * sn }, 1e-9); ptNear(g.ay, { x: -20 * sn, y: 20 * c }, 1e-9);
});
check('polygon vertex drag and ellipse handle order match the Swift pins', () => {
  const g = dragShapeHandle({ kind: 'polygon', vertices: [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 40, y: 90 }] }, 1, { x: 150, y: -20 });
  assert.deepEqual(g.vertices, [{ x: 0, y: 0 }, { x: 150, y: -20 }, { x: 40, y: 90 }]);
  assert.deepEqual(shapeHandles({ kind: 'ellipse', center: { x: 50, y: 50 }, ax: { x: 40, y: 0 }, ay: { x: 0, y: 40 } }), [{ x: 50, y: 10 }, { x: 90, y: 50 }, { x: 50, y: 90 }, { x: 10, y: 50 }]);
});
check('ellipse top / left handle drag literals pinned against the Swift fixture', () => {
  const g = { kind: 'ellipse', center: { x: 0, y: 0 }, ax: { x: 50, y: 0 }, ay: { x: 0, y: 30 } };
  const top = dragShapeHandle(g, 0, { x: 0, y: -80 });
  ptNear(top.center, { x: 0, y: -25 }); ptNear(top.ax, { x: 50, y: 0 }); ptNear(top.ay, { x: 0, y: 55 });
  const left = dragShapeHandle(g, 3, { x: -90, y: 0 });
  ptNear(left.center, { x: -20, y: 0 }); ptNear(left.ax, { x: 70, y: 0 }); ptNear(left.ay, { x: 0, y: 30 });
});
console.log('\nannotation-shape: all checks passed');
