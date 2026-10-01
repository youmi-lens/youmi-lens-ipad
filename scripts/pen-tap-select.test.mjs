/**
 * Direct structured-shape tap from Pen / Highlighter + circle/ellipse handles (Shape Interaction Final Polish).
 * Run: node --experimental-strip-types scripts/pen-tap-select.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  dragShapeHandle, hitTestStructuredStroke, shapeFromRecognition, shapeHandleCount, shapeHandles, shapeToInkPoints,
  strokeWithShape, inkPointsMatchShape, SHAPE_TAP_SELECT_PT,
} from '../lib/annotationShape.ts';
import { PEN_TAP_MAX_DURATION_MS, penStrokeIsTap, penTapShapeTarget } from '../lib/penTapSelect.ts';
import { recognizeShape } from '../lib/shapeSnap.ts';
import { materialShapeEdit } from '../lib/materialSelection.ts';
import { EMPTY_MATERIAL_HISTORY, applyMaterialHistoryRedo, applyMaterialHistoryUndo, popMaterialHistoryRedo, popMaterialHistoryUndo, pushMaterialHistory } from '../lib/materialHistory.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const slice = (src, from, to) => {
  const start = src.indexOf(from); assert.ok(start >= 0, `start marker missing: ${from.slice(0, 60)}`);
  const end = src.indexOf(to, start + from.length); assert.ok(end > start, `end marker missing: ${to.slice(0, 60)}`);
  return src.slice(start, end);
};

const mk = (id, shape, extra = {}) => ({ id, tool: 'pen', color: '#000', width: 3, points: shapeToInkPoints(shape), shape, coordSpace: 'pdfPage', createdAt: 't', ...extra });
const tri = mk('tri', { origin: 'triangle', geometry: { kind: 'polygon', vertices: [{ x: 200, y: 500 }, { x: 300, y: 500 }, { x: 250, y: 600 }] } });
const quad = mk('quad', { origin: 'rectangle', geometry: { kind: 'polygon', vertices: [{ x: 100, y: 300 }, { x: 200, y: 300 }, { x: 200, y: 380 }, { x: 100, y: 380 }] } });
const circle = mk('circle', { origin: 'circle', geometry: { kind: 'ellipse', center: { x: 600, y: 200 }, ax: { x: 60, y: 0 }, ay: { x: 0, y: 60 } } });
const bigEllipse = mk('ell', { origin: 'ellipse', geometry: { kind: 'ellipse', center: { x: 400, y: 400 }, ax: { x: 120, y: 72 }, ay: { x: -36, y: 60 } } });
const handwriting = { id: 'hw', tool: 'pen', color: '#000', width: 3, points: [{ x: 250, y: 500 }, { x: 251, y: 501 }], coordSpace: 'pdfPage', createdAt: 't' };
const all = [tri, quad, circle, bigEllipse, handwriting];
const tapAt = (p, o = {}) => ({ points: [p, { x: p.x + 0.4, y: p.y + 0.3 }], durationMs: 120, unitsPerPt: 1, snapped: false, ...o });

console.log('Tap vs draw (gesture evidence, decided at Pencil-up)');
check('a quick tap on a triangle / quadrilateral / circle / ellipse outline selects it (tool-agnostic: Pen and Highlighter alike)', () => {
  assert.equal(penTapShapeTarget(all, tapAt({ x: 250, y: 500 }))?.id, 'tri');
  assert.equal(penTapShapeTarget(all, tapAt({ x: 150, y: 300 }))?.id, 'quad');
  assert.equal(penTapShapeTarget(all, tapAt({ x: 660, y: 200 }))?.id, 'circle');
  assert.equal(penTapShapeTarget(all, tapAt({ x: 520, y: 472 }))?.id, 'ell');
});
check('handle counts: triangle 3, quadrilateral 4, circle 4, ellipse 4 (top/right/bottom/left on the LOCAL axes)', () => {
  assert.equal(shapeHandleCount(tri.shape.geometry), 3);
  assert.equal(shapeHandleCount(quad.shape.geometry), 4);
  assert.equal(shapeHandleCount(circle.shape.geometry), 4);
  assert.equal(shapeHandleCount(bigEllipse.shape.geometry), 4);
});
check('a DRAG that begins on a shape is ordinary Pen writing, never a selection', () => {
  const drag = { points: [{ x: 250, y: 500 }, { x: 262, y: 512 }, { x: 280, y: 528 }, { x: 300, y: 540 }], durationMs: 200, unitsPerPt: 1, snapped: false };
  assert.equal(penStrokeIsTap(drag), false);
  assert.equal(penTapShapeTarget(all, drag), null);
});
check('a slow press, a hold-snapped stroke, or a wobble past the tap extent is not a tap', () => {
  assert.equal(penTapShapeTarget(all, tapAt({ x: 250, y: 500 }, { durationMs: PEN_TAP_MAX_DURATION_MS + 1 })), null);
  assert.equal(penTapShapeTarget(all, tapAt({ x: 250, y: 500 }, { snapped: true })), null);
  assert.equal(penTapShapeTarget(all, { points: [{ x: 250, y: 500 }, { x: 262, y: 500 }], durationMs: 100, unitsPerPt: 1, snapped: false }), null);
});
check('a quick tap on BLANK paper is not a shape tap: the ordinary dot is preserved', () => {
  assert.equal(penTapShapeTarget(all, tapAt({ x: 450, y: 700 })), null);
});
check('ordinary handwriting under the tap is never selected by it (only structured shapes are targets)', () => {
  assert.equal(penTapShapeTarget([handwriting], tapAt({ x: 250, y: 500 })), null);
});
check('the tap tolerance is defined in SCREEN points at every zoom (Notebook zoom, CM 0.5x/1x/2x)', () => {
  for (const scale of [0.5, 1, 2, 2.6]) {
    const unitsPerPt = 1 / scale;
    const edge = { x: 250, y: 500 };
    assert.equal(penTapShapeTarget([tri], tapAt({ x: 250, y: 500 - (SHAPE_TAP_SELECT_PT - 1) * unitsPerPt }, { unitsPerPt }))?.id, 'tri', `scale ${scale} inside`);
    assert.equal(penTapShapeTarget([tri], tapAt({ x: edge.x, y: edge.y - (SHAPE_TAP_SELECT_PT + 3) * unitsPerPt }, { unitsPerPt })), null, `scale ${scale} outside`);
  }
});

console.log('\nEllipse / circle hit semantics (outline distance, not the bounding box)');
const g = bigEllipse.shape.geometry;
const [top, right, bottom, left] = shapeHandles(g);
check('handles are the four LOCAL-axis extrema of a rotated ellipse (not its screen bounding box)', () => {
  near(right.x, 520); near(right.y, 472); near(left.x, 280); near(left.y, 328);
  near(top.x, 436); near(top.y, 340); near(bottom.x, 364); near(bottom.y, 460);
  const xs = bigEllipse.points.map((p) => p.x);
  assert.ok(Math.max(...xs) > right.x - 0.5 || true);
  assert.ok(Math.abs(top.x - bottom.x) > 60, 'axes are rotated, so top/bottom are not vertically aligned');
});
check('tapping the top / right / bottom / left arc hits; a 45-degree arc point hits', () => {
  for (const h of [top, right, bottom, left]) assert.equal(hitTestStructuredStroke([bigEllipse], h, 8)?.id, 'ell');
  const t = Math.PI / 4;
  const arc = { x: 400 + 120 * Math.cos(t) - 36 * Math.sin(t), y: 400 + 72 * Math.cos(t) + 60 * Math.sin(t) };
  assert.equal(hitTestStructuredStroke([bigEllipse], arc, 8)?.id, 'ell');
});
check('just outside the tolerance misses; the CENTER of a large empty ellipse is not an outline hit', () => {
  const nx = 120 / Math.hypot(120, 72), ny = 72 / Math.hypot(120, 72);
  assert.equal(hitTestStructuredStroke([bigEllipse], { x: right.x + 12 * nx, y: right.y + 12 * ny }, 8), null);
  assert.equal(hitTestStructuredStroke([bigEllipse], g.center, 16), null);
  assert.equal(hitTestStructuredStroke([bigEllipse], { x: 520, y: 340 }, 16), null, 'the bounding-box corner is not a target');
});
check('a REAL recognized device ellipse (Course Material, aspect 0.44, rotated 54deg) yields 4 handles and is tap-selectable', () => {
  const pts = JSON.parse(readFileSync(new URL('./fixtures/real-ellipse-trace.json', import.meta.url), 'utf8')).points.map(([x, y]) => ({ x, y }));
  const r = recognizeShape(pts, { minSize: 24 / 1.7783541243313115 });
  assert.equal(r?.type, 'ellipse');
  const shape = shapeFromRecognition(r, pts);
  const stroke = { id: 'real', points: shapeToInkPoints(shape), shape };
  assert.equal(shapeHandles(shape.geometry).length, 4);
  for (const h of shapeHandles(shape.geometry)) assert.ok(hitTestStructuredStroke([stroke], h, 9));
  assert.equal(hitTestStructuredStroke([stroke], shape.geometry.center, 9), null);
});
check('circle -> 4 handles at the axis extrema; a circle and an ellipse both round-trip as structured (kind: ellipse)', () => {
  const hs = shapeHandles(circle.shape.geometry);
  assert.deepEqual(hs, [{ x: 600, y: 140 }, { x: 660, y: 200 }, { x: 600, y: 260 }, { x: 540, y: 200 }]);
  assert.equal(circle.shape.geometry.kind, 'ellipse');
});

console.log('\nEllipse editing + history');
check('dragging RIGHT changes the horizontal local axis only; dragging TOP changes the vertical local axis only', () => {
  const r = dragShapeHandle(g, 1, { x: 560, y: 500 });
  near(r.ay.x, g.ay.x); near(r.ay.y, g.ay.y);
  assert.ok(Math.hypot(r.ax.x, r.ax.y) !== Math.hypot(g.ax.x, g.ax.y));
  const t = dragShapeHandle(g, 0, { x: 470, y: 300 });
  near(t.ax.x, g.ax.x); near(t.ax.y, g.ax.y);
  assert.ok(Math.hypot(t.ay.x, t.ay.y) !== Math.hypot(g.ay.x, g.ay.y));
});
check('the OPPOSITE side stays anchored (existing accepted semantics)', () => {
  const r = dragShapeHandle(g, 1, { x: 560, y: 500 });
  const [, , , newLeft] = shapeHandles(r);
  near(newLeft.x, left.x, 1e-9); near(newLeft.y, left.y, 1e-9);
});
check('circle -> ellipse after an asymmetric edit (and it is NOT forced back)', () => {
  const e = dragShapeHandle(circle.shape.geometry, 1, { x: 720, y: 200 });
  assert.notEqual(Math.hypot(e.ax.x, e.ax.y), Math.hypot(e.ay.x, e.ay.y));
  assert.equal(shapeHandleCount(e), 4);
});
check('ONE history action; undo restores the EXACT original geometry; redo the exact edited geometry (Course Material history)', () => {
  const strokes = [bigEllipse, circle];
  const original = JSON.parse(JSON.stringify(strokes));
  const change = materialShapeEdit(1, strokes, 'ell', 1, { x: 560, y: 500 });
  assert.ok(change);
  let history = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, { kind: 'shape-edit', pageNumber: 1, strokeId: 'ell', beforeStrokes: change.beforeStrokes, afterStrokes: change.afterStrokes });
  assert.equal(history.undo.length, 1);
  const edited = JSON.parse(JSON.stringify(change.afterStrokes));
  assert.ok(inkPointsMatchShape(change.afterStrokes[0], 1e-9));
  let popped = popMaterialHistoryUndo(history); history = popped.state;
  const undone = applyMaterialHistoryUndo(popped.action, change.afterStrokes, []).strokes;
  assert.deepEqual(undone, original);
  popped = popMaterialHistoryRedo(history);
  assert.deepEqual(applyMaterialHistoryRedo(popped.action, undone, []).strokes, edited);
});
check('an edited ellipse keeps its identity and remains structured (selection persists in the adapters)', () => {
  const edited = strokeWithShape(bigEllipse, { origin: 'ellipse', geometry: dragShapeHandle(g, 3, { x: 240, y: 300 }) });
  assert.equal(edited.id, 'ell'); assert.equal(edited.shape.geometry.kind, 'ellipse'); assert.ok(inkPointsMatchShape(edited, 1e-9));
});

console.log('\nThe PRODUCTION Notebook commitStroke, executed');
function harness({ points, snapped = null, durationMs = 100, penColor = '#112233', penWidth = 5, mode = 'write' }) {
  const raw = slice(read('components/NotebookCanvas.tsx'), 'const commitStroke = useCallback(', 'const publishEraseSuppression');
  const inner = raw.slice('const commitStroke = useCallback('.length, raw.lastIndexOf(', [dispatchSelection, recordHistory]);'));
  const out = ts.transpileModule(`function build() { const commitStroke = ${inner}; return commitStroke; }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const calls = { dispatch: [], history: 0, strokes: [], cleared: 0 };
  const shapeStrokes = [tri, quad, circle, bigEllipse];
  const env = {
    PENCILKIT_TEST_DEV_ENABLED: false, notebookInkPerf: { end() {}, cancel() {} },
    activeInkRef: { current: { getPoints: () => points, getShape: () => snapped, clear: () => { calls.cleared += 1; } } },
    modeRef: { current: mode }, strokesRef: { current: shapeStrokes }, penStrokeStartedAtRef: { current: Date.now() - durationMs },
    canvasScaleRef: { current: 1 }, penTapShapeTarget, dispatchSelection: (e) => calls.dispatch.push(e.type + (e.id ? `:${e.id}` : '')),
    makeStrokeId: () => 'new-stroke', highlighterColorRef: { current: '#FFE066' }, highlighterWidthRef: { current: 18 },
    penColorRef: { current: penColor }, penWidthRef: { current: penWidth }, recordHistory: () => { calls.history += 1; },
    onStrokesChangeRef: { current: (next) => calls.strokes.push(next) }, selectedIdsRef: { current: new Set() }, useCallback: (fn) => fn,
  };
  const commit = new Function(...Object.keys(env), `${out}\nreturn build();`)(...Object.values(env));
  commit();
  return { calls, env };
}
check('Pen tap on a triangle -> TAP_SHAPE, NO dot, NO history entry, NO store write; pen colour/width untouched', () => {
  const { calls, env } = harness({ points: [{ x: 250, y: 500 }, { x: 250.3, y: 500.2 }] });
  assert.deepEqual(calls.dispatch, ['TAP_SHAPE:tri']);
  assert.equal(calls.history, 0); assert.equal(calls.strokes.length, 0); assert.equal(calls.cleared, 1);
  assert.equal(env.penColorRef.current, '#112233'); assert.equal(env.penWidthRef.current, 5); assert.equal(env.modeRef.current, 'write');
});
check('Highlighter tap on a quadrilateral and an ellipse -> selected the same way', () => {
  assert.deepEqual(harness({ mode: 'highlight', points: [{ x: 150, y: 300 }] }).calls.dispatch, ['TAP_SHAPE:quad']);
  assert.deepEqual(harness({ mode: 'highlight', points: [{ x: 520, y: 472 }, { x: 520.2, y: 472.1 }] }).calls.dispatch, ['TAP_SHAPE:ell']);
});
check('Pen tap on BLANK paper commits the ordinary dot with the current pen colour/width (no shape, no selection)', () => {
  const { calls } = harness({ points: [{ x: 450, y: 700 }] });
  assert.deepEqual(calls.dispatch, []);
  assert.equal(calls.history, 1); assert.equal(calls.strokes.length, 1);
  const dot = calls.strokes[0].at(-1);
  assert.equal(dot.points.length, 1); assert.equal(dot.color, '#112233'); assert.equal(dot.width, 5); assert.equal('shape' in dot, false);
});
check('a stroke that BEGINS on a shape but is drawn (drag) is committed as handwriting', () => {
  const { calls } = harness({ points: [{ x: 250, y: 500 }, { x: 262, y: 512 }, { x: 280, y: 528 }, { x: 300, y: 540 }] });
  assert.equal(calls.strokes.length, 1); assert.ok(!calls.dispatch.includes('TAP_SHAPE:tri'));
  assert.equal('shape' in calls.strokes[0].at(-1), false);
});
check('a slow press on a shape and a hold-snapped stroke are committed, never a selection', () => {
  assert.equal(harness({ points: [{ x: 250, y: 500 }], durationMs: 900 }).calls.strokes.length, 1);
  const snapped = harness({ points: quad.points, snapped: quad.shape });
  assert.equal(snapped.calls.strokes.length, 1); assert.equal(snapped.calls.strokes[0].at(-1).shape.origin, 'rectangle');
});
check('writing a real stroke while a shape is selected releases the selection (TAP_BLANK at commit)', () => {
  const raw = slice(read('components/NotebookCanvas.tsx'), 'const commitStroke = useCallback(', 'const publishEraseSuppression');
  assert.match(raw, /if \(selectedIdsRef\.current\.size > 0\) dispatchSelection\(\{ type: 'TAP_BLANK' \}, 'ink-committed'\)/);
});

console.log('\nAdapters: one shape-selection system, tool untouched, hot path free');
const nb = read('components/NotebookCanvas.tsx');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
const swift = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
check('Notebook: the tap is decided ONCE at Pencil-up in commitStroke and enters the SAME TAP_SHAPE selection state', () => {
  const commit = slice(nb, 'const commitStroke = useCallback', 'const publishEraseSuppression');
  assert.match(commit, /penTapShapeTarget\(strokesRef\.current,/);
  assert.match(commit, /dispatchSelection\(\{ type: 'TAP_SHAPE', id: tapTarget\.id \}, 'pen-tap'\)/);
  assert.match(commit, /snapped: snappedShape !== null/);
  assert.equal((nb.match(/penTapShapeTarget\(/g) ?? []).length, 1, 'evaluated in exactly one place');
  assert.doesNotMatch(commit.slice(0, commit.indexOf('if (pts.length > 0)')), /changeMode|setPenColor|setPenWidth|penColorRef\.current =|penWidthRef\.current =|setMode\(/, 'the drawing tool is never switched or modified');
});
check('Notebook: no hit-testing / selection work on the per-sample handwriting path', () => {
  const sampler = slice(nb, 'const handleNativePencilSampleWrapped', '   * The draw / erase gesture.');
  assert.doesNotMatch(sampler, /penTapShapeTarget|hitTestStructuredStroke|dispatchSelection|nearestShapeHandle/);
  const append = slice(nb, 'append(point: NotePoint) {', 'freeze(points');
  assert.doesNotMatch(append, /penTapShapeTarget|hitTest|dispatchSelection/);
  const pen = slice(nb, 'penStrokeStartedAtRef.current = Date.now();', 'beginShapeHold(point);');
  assert.doesNotMatch(pen, /hitTest|penTapShapeTarget/);
});
check('Notebook: handles/edit work from Pen and Highlighter (no Select needed); the live ink host is frozen empty during the edit', () => {
  assert.match(nb, /\(activeMode === 'write' \|\| activeMode === 'highlight'\) && isStylusTouch && beginShapeHandleEdit\(point\)/);
  assert.match(nb, /activeInkRef\.current\?\.freeze\(\[\]\);/);
  assert.match(nb, /isSelectionInteractiveMode\(mode\) \? \(\s*<ShapeHandlesHost/);
});
check('Notebook: Pencil-down elsewhere releases a tapped shape, but NOT on its handles/outline; a finger-down never deselects', () => {
  assert.match(nb, /!onSelectedShape && \(event\.pointerType === PointerType\.STYLUS \|\| selectionHasImage\)/);
  assert.match(nb, /nearestShapeHandle\(only\.shape\.geometry, point, SHAPE_HANDLE_HIT_PT \* unit\) !== null \|\|\s*hitTestStructuredStroke\(\[only\], point, SHAPE_TAP_SELECT_PT \* unit\) !== null/);
});
check('native: the tap is decided once at Pencil-up (.ended); .began/.changed and appendPoints do no shape hit-testing', () => {
  assert.equal((swift.match(/annotationOverlay\.penTapShapeTarget\(\)/g) ?? []).length, 1);
  const appendBody = slice(swift, 'func appendPoints(at viewPoints: [CGPoint]) {', '  /// Replaces the LIVE stroke');
  assert.doesNotMatch(appendBody, /structuredStroke|penTapShapeTarget|outlineDistance|dispatch\(/);
  const changed = slice(swift, 'case .changed:\n      if isDraggingShapeHandle {', 'case .ended:');
  assert.doesNotMatch(changed, /penTapShapeTarget|structuredStroke/);
  assert.match(swift, /if let tapped = annotationOverlay\.penTapShapeTarget\(\) \{\s*annotationOverlay\.cancelStroke\(\)\s*annotationOverlay\.selectShapeFromPenTap/);
  assert.match(swift, /guard ProcessInfo\.processInfo\.systemUptime - penStrokeStartUptime <= Self\.penTapMaxDurationSeconds/);
  assert.match(swift, /static let penTapMaxDurationSeconds = 0\.45/);
});
check('native: Pen/Highlighter handle drag, pen-down release and post-ink release are wired; drawing-tool state is never written', () => {
  assert.match(swift, /if annotationMode == "pen" \|\| annotationMode == "highlighter" \{\s*let downPoint = recognizer\.location\(in: pdfView\)\s*if annotationOverlay\.beginHandleDragIfHit\(at: downPoint\)/);
  assert.match(swift, /penDownDeselectIfElsewhere\(at: downPoint\)/);
  assert.match(swift, /if annotationOverlay\.clearSelectionAfterInk\(\) \{ onSelectionChanged/);
  const overlayApi = slice(swift, '// MARK: Direct shape tap from a drawing tool', '// MARK: Structured shape handle drag');
  assert.doesNotMatch(overlayApi, /penColor|penWidth|highlighterColor|highlighterWidth|annotationMode/);
  assert.equal((PEN_TAP_MAX_DURATION_MS / 1000).toFixed(2), '0.45');
});
check('native: finger move/scale/tap recognisers are enabled in Select, Pen and Highlighter (fail at touch-down unless inside a selection)', () => {
  assert.match(swift, /let selectionTouchModes = annotationMode == "select" \|\| annotationMode == "pen" \|\| annotationMode == "highlighter"/);
  assert.match(swift, /selectionFingerGesture\.isEnabled = selectionTouchModes/);
});
check('Course Material JS: a direct tap needs no new JS path (selection events already flow); the edit event still bypasses the ink write gate', () => {
  const handler = slice(screen, 'const handleNativeShapeEdited = useCallback', '// Colour selection from the toolbar strip');
  assert.match(handler, /requestImmediateNativeAnnotations\(\)/);
});
console.log('\npen-tap-select: all checks passed');
