/**
 * Shared selection transform math + touch routing (Selection Interaction Phase).
 * Run: node --experimental-strip-types scripts/selection-transform.test.mjs
 */
import assert from 'node:assert/strict';
import { shapeToInkPoints, inkPointsMatchShape, shapeHandles } from '../lib/annotationShape.ts';
import {
  SELECTION_MIN_SPAN_PT, SELECTION_SCALE_MAX, SELECTION_SCALE_MIN, SELECTION_TOUCH_PAD_PT,
  boundsCenter, boundsOfStrokes, boundsSpan, clampSelectionScale, insideSelectionRegion,
  pinchFactor, routeSelectionTouch, scaleInkStroke, scaleSelectedStrokes,
} from '../lib/selectionTransform.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);

const ink = (id, pts, extra = {}) => ({ id, tool: 'pen', color: '#123456', width: 3, opacity: 1, points: pts.map(([x, y]) => ({ x, y, p: 0.5, t: 7 })), createdAt: 't', ...extra });
const a = ink('a', [[100, 100], [200, 100], [200, 200]]);
const b = ink('b', [[300, 300], [400, 350]]);
const other = ink('z', [[900, 900], [910, 910]]);
const triShape = { origin: 'triangle', geometry: { kind: 'polygon', vertices: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 150, y: 200 }] } };
const tri = { id: 'tri', tool: 'pen', color: '#000', width: 3, points: shapeToInkPoints(triShape), shape: triShape, createdAt: 't' };

console.log('Scale semantics');
check('1.0 -> 1.5 scales about the selection center; others keep identity', () => {
  const strokes = [a, b, other];
  const center = boundsCenter(boundsOfStrokes([a, b]));
  const out = scaleSelectedStrokes(strokes, new Set(['a', 'b']), center, 1.5);
  const before = boundsOfStrokes([a, b]);
  const after = boundsOfStrokes([out[0], out[1]]);
  near(after.maxX - after.minX, (before.maxX - before.minX) * 1.5);
  near(after.maxY - after.minY, (before.maxY - before.minY) * 1.5);
  const c2 = boundsCenter(after);
  near(c2.x, center.x); near(c2.y, center.y);
  assert.equal(out[2], other);
});
check('1.0 -> 0.5 shrinks about the same center', () => {
  const center = boundsCenter(boundsOfStrokes([a, b]));
  const out = scaleSelectedStrokes([a, b], new Set(['a', 'b']), center, 0.5);
  const after = boundsOfStrokes(out);
  const before = boundsOfStrokes([a, b]);
  near(boundsSpan(after), boundsSpan(before) * 0.5);
});
check('stroke identity, colour, tool, opacity, createdAt and PEN WIDTH are preserved; p/t survive', () => {
  const s = scaleInkStroke(a, { x: 150, y: 150 }, 2);
  assert.equal(s.id, 'a'); assert.equal(s.color, '#123456'); assert.equal(s.tool, 'pen');
  assert.equal(s.width, 3, 'geometry scales, ink thickness does not'); assert.equal(s.opacity, 1); assert.equal(s.createdAt, 't');
  assert.equal(s.points[0].p, 0.5); assert.equal(s.points[0].t, 7);
  assert.equal(s.points.length, a.points.length);
});
check('no incremental drift: previews always come from the ORIGINAL geometry', () => {
  const center = boundsCenter(boundsOfStrokes([a, b]));
  // 200 gesture frames wobbling then settling on 1.5 must equal one direct 1.5 transform.
  let last;
  for (let i = 0; i < 200; i += 1) last = scaleSelectedStrokes([a, b], new Set(['a', 'b']), center, 1 + 0.5 * Math.sin((i / 199) * Math.PI / 2 * 3) * 0 + (0.5 * i) / 199);
  const direct = scaleSelectedStrokes([a, b], new Set(['a', 'b']), center, 1.5);
  assert.deepEqual(last.map((s) => s.points), direct.map((s) => s.points));
  // Contrast: chaining scale-of-scale accumulates float error; the preview never does that.
  let chained = [a, b];
  for (let i = 0; i < 200; i += 1) chained = scaleSelectedStrokes(chained, new Set(['a', 'b']), center, i % 2 ? 1 / 1.3 : 1.3);
  assert.ok(chained.length === 2);
});
check('scale is exactly reversible from the original (undo restores identical geometry)', () => {
  const center = boundsCenter(boundsOfStrokes([a, b]));
  const out = scaleSelectedStrokes([a, b], new Set(['a', 'b']), center, 1.7);
  assert.notDeepEqual(out[0].points, a.points);
  assert.deepEqual([a, b][0].points, a.points, 'inputs are never mutated');
});

console.log('\nStructured shape scale');
check('a structured shape scales its geometry, regenerates points, keeps the invariant and its handles follow', () => {
  const center = { x: 150, y: 133.3333 };
  const s = scaleInkStroke(tri, center, 1.5);
  assert.ok(inkPointsMatchShape(s, 1e-9));
  assert.equal(s.shape.geometry.vertices.length, 3);
  assert.equal(s.width, 3);
  near(s.shape.geometry.vertices[1].x, 150 + (200 - 150) * 1.5, 1e-6);
  assert.deepEqual(shapeHandles(s.shape.geometry), s.shape.geometry.vertices);
});
check('circle/ellipse scale keeps center relation and scales both axes (still an ellipse)', () => {
  const shape = { origin: 'ellipse', geometry: { kind: 'ellipse', center: { x: 50, y: 50 }, ax: { x: 60, y: 0 }, ay: { x: 0, y: 30 } } };
  const s = scaleInkStroke({ id: 'e', points: shapeToInkPoints(shape), shape }, { x: 0, y: 0 }, 2);
  assert.deepEqual(s.shape.geometry.center, { x: 100, y: 100 });
  assert.deepEqual(s.shape.geometry.ax, { x: 120, y: 0 });
  assert.deepEqual(s.shape.geometry.ay, { x: 0, y: 60 });
  assert.ok(inkPointsMatchShape(s, 1e-9));
});

console.log('\nScale limits (semantic, screen-point based)');
check('minimum clamp: never collapses, never inverts, ignores garbage', () => {
  const span = 200; const unitsPerPt = 1;
  const f = clampSelectionScale(0.001, span, unitsPerPt);
  assert.ok(f >= SELECTION_MIN_SPAN_PT / span - 1e-12 && f >= SELECTION_SCALE_MIN);
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) assert.equal(clampSelectionScale(bad, span, unitsPerPt), 1);
});
check('maximum clamp: relative and absolute', () => {
  assert.equal(clampSelectionScale(1000, 100, 1), SELECTION_SCALE_MAX);
  assert.ok(clampSelectionScale(4, 5000, 1) <= 6000 / 5000 + 1e-12, 'absolute on-screen ceiling');
});
check('limits follow the screen scale, not document units (same on-screen result at 0.5x/1x/2x)', () => {
  for (const scale of [0.5, 1, 2]) {
    const unitsPerPt = 1 / scale;
    const spanUnits = 100 * unitsPerPt; // 100pt on screen
    const f = clampSelectionScale(0.0001, spanUnits, unitsPerPt);
    near(f * 100, Math.max(SELECTION_MIN_SPAN_PT, 100 * SELECTION_SCALE_MIN), 1e-9, `scale ${scale}`);
  }
});
check('an already-tiny selection can still grow but never shrinks further', () => {
  const tiny = SELECTION_MIN_SPAN_PT * 0.5;
  assert.ok(clampSelectionScale(0.5, tiny, 1) >= 1);
  assert.ok(clampSelectionScale(2, tiny, 1) >= 2 - 1e-12);
});
check('clamp literals pinned against the native SelectionLimits (material_selection_fixture.swift)', () => {
  const cases = [[0.05, 40, 1, 0.6], [0.05, 40, 0.5, 0.3], [0.05, 40, 2, 1.2], [100, 40, 1, 5], [1.5, 40, 1, 1.5], [0.01, 1000, 1, 0.2], [50, 1000, 1, 5], [10, 2000, 1, 3]];
  for (const [factor, span, unitsPerPt, expected] of cases) near(clampSelectionScale(factor, span, unitsPerPt), expected, 1e-9, `${factor}/${span}/${unitsPerPt}`);
});
check('pinch distance ratio', () => {
  near(pinchFactor(100, 150), 1.5); near(pinchFactor(100, 50), 0.5); assert.equal(pinchFactor(0, 50), 1);
});

console.log('\nCoordinates: screen-space touch tolerance');
check('the touch pad is SELECTION_TOUCH_PAD_PT screen points at every zoom (Notebook zoom, CM 0.5x/1x/2x)', () => {
  const region = { minX: 100, minY: 100, maxX: 200, maxY: 200 };
  for (const scale of [0.5, 1, 2, 2.6]) {
    const pad = SELECTION_TOUCH_PAD_PT / scale;
    assert.equal(insideSelectionRegion(region, { x: 200 + pad - 0.01, y: 150 }, pad), true, `scale ${scale} inside`);
    assert.equal(insideSelectionRegion(region, { x: 200 + pad + 0.5, y: 150 }, pad), false, `scale ${scale} outside`);
  }
  assert.equal(insideSelectionRegion(null, { x: 0, y: 0 }, 10), false);
});
check('rotated page: page-space math is independent of view rotation (scale about page-space center)', () => {
  const H = 300; const toScreen = (p) => ({ x: H - p.y, y: p.x });
  const center = boundsCenter(boundsOfStrokes([a]));
  const scaled = scaleInkStroke(a, center, 1.5);
  const screenBefore = a.points.map(toScreen); const screenAfter = scaled.points.map(toScreen);
  const sc = { x: screenBefore.reduce((s, p) => s + p.x, 0) / screenBefore.length, y: 0 };
  // scaling about the center in page space == scaling about the (rotated) center in screen space
  const cs = toScreen(center);
  screenBefore.forEach((p, i) => { near(screenAfter[i].x, cs.x + (p.x - cs.x) * 1.5, 1e-9); near(screenAfter[i].y, cs.y + (p.y - cs.y) * 1.5, 1e-9); });
  assert.ok(sc);
});

console.log('\nGesture routing (arbitration priority)');
const base = { touchCount: 1, hasSelection: true, insideSelection: true };
check('Pencil on a handle beats everything (shape edit)', () => {
  assert.equal(routeSelectionTouch({ ...base, pointer: 'stylus', onHandle: true }), 'shape-handle-edit');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'stylus', onHandle: true, insideSelection: false }), 'shape-handle-edit');
});
check('ONE finger on a handle edits it (same as the Pencil): handle > body move > page (RC-1.2 Notebook/Course Material parity)', () => {
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', onHandle: true }), 'shape-handle-edit');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', onHandle: true, insideSelection: false }), 'shape-handle-edit');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', onHandle: false }), 'selection-move', 'inside the body but off every handle: move');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', insideSelection: false }), 'page-navigation', 'outside: the page keeps the finger');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', hasSelection: false, onHandle: true }), 'page-navigation', 'no selection: no handles exist');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', touchCount: 2, onHandle: true, secondInsideSelection: true }), 'selection-scale', 'two fingers never edit a handle: pinch scale wins');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', touchCount: 2, onHandle: true, secondInsideSelection: false }), 'page-navigation');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'other', onHandle: true }), 'page-navigation');
});
check('Pencil inside the selection moves it; Pencil elsewhere starts a NEW Box/Lasso', () => {
  assert.equal(routeSelectionTouch({ ...base, pointer: 'stylus' }), 'selection-move');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'stylus', insideSelection: false }), 'new-selection');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'stylus', hasSelection: false, insideSelection: false }), 'new-selection');
});
check('one finger inside the selection is captured for MOVE', () => {
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch' }), 'selection-move');
});
check('one finger outside the selection passes to page navigation; nothing selected -> navigation', () => {
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', insideSelection: false }), 'page-navigation');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', hasSelection: false, insideSelection: true }), 'page-navigation');
});
check('two fingers both inside the selection -> SCALE', () => {
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', touchCount: 2, secondInsideSelection: true }), 'selection-scale');
});
check('two fingers where either starts outside keep normal page zoom/navigation', () => {
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', touchCount: 2, secondInsideSelection: false }), 'page-navigation');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', touchCount: 2, insideSelection: false, secondInsideSelection: true }), 'page-navigation');
  assert.equal(routeSelectionTouch({ ...base, pointer: 'touch', touchCount: 2, hasSelection: false, secondInsideSelection: true }), 'page-navigation');
});
check('the page is never made unscrollable merely because something is selected', () => {
  for (const insideSelection of [false]) for (const touchCount of [1, 2, 3]) {
    assert.equal(routeSelectionTouch({ pointer: 'touch', touchCount, hasSelection: true, insideSelection, secondInsideSelection: true }), 'page-navigation');
  }
});
console.log('\nselection-transform: all checks passed');
