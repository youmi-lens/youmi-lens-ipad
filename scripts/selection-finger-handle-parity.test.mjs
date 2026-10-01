/**
 * RC-1.2 — ONE-FINGER structured-shape handle editing must behave the same in Notebook and Course Material.
 *
 * Root cause (proven by the native fixture's ROOT-CAUSE GUARD + the source contracts below): the shared router
 * (lib/selectionTransform.routeSelectionTouch) only knew `shape-handle-edit` for the Pencil. Notebook compensated
 * locally (beginShapeHandleEdit runs BEFORE the body move); Course Material's native finger recogniser went
 * scale -> beginMoveIfHit, and a handle sits on the outline INSIDE the padded body bounds, so the body move swallowed
 * the touch and the handle drag was never reachable with a finger.
 *
 * Run: node --experimental-strip-types scripts/selection-finger-handle-parity.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  inkPointsMatchShape, nearestShapeHandle, shapeHandles, shapeToInkPoints, SHAPE_HANDLE_HIT_PT,
} from '../lib/annotationShape.ts';
import { materialShapeEdit } from '../lib/materialSelection.ts';
import { insideSelectionRegion, boundsOfPoints, routeSelectionTouch, SELECTION_TOUCH_PAD_PT } from '../lib/selectionTransform.ts';
import { selectionReduce, IDLE_SELECTION } from '../lib/selectionMachine.ts';
import {
  EMPTY_MATERIAL_HISTORY, pushMaterialHistory, popMaterialHistoryUndo, popMaterialHistoryRedo,
  applyMaterialHistoryUndo, applyMaterialHistoryRedo,
} from '../lib/materialHistory.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const slice = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = to ? text.indexOf(to, start + from.length) : text.length;
  assert.ok(end > start, `missing end: ${to}`);
  return text.slice(start, end);
};
const clone = (v) => JSON.parse(JSON.stringify(v));

const SHAPES = {
  quad: { origin: 'rectangle', geometry: { kind: 'polygon', vertices: [{ x: 330, y: 380 }, { x: 430, y: 380 }, { x: 430, y: 480 }, { x: 330, y: 480 }] } },
  triangle: { origin: 'triangle', geometry: { kind: 'polygon', vertices: [{ x: 200, y: 500 }, { x: 300, y: 500 }, { x: 250, y: 600 }] } },
  line: { origin: 'line', geometry: { kind: 'line', a: { x: 100, y: 150 }, b: { x: 220, y: 190 } } },
  ellipse: { origin: 'circle', geometry: { kind: 'ellipse', center: { x: 400, y: 300 }, ax: { x: 40, y: 0 }, ay: { x: 0, y: 40 } } },
};
const EXPECTED_HANDLES = { quad: 4, triangle: 3, line: 2, ellipse: 4 };
const mk = (id, shape) => ({ id, tool: 'pen', color: '#061B34', width: 3, points: shapeToInkPoints(shape), shape: clone(shape), coordSpace: 'pdfPage', createdAt: 't' });
const hand = { id: 'hand', tool: 'pen', color: '#061B34', width: 3, points: [{ x: 500, y: 100 }, { x: 520, y: 110 }], coordSpace: 'pdfPage', createdAt: 't' };
const pageOf = () => [...Object.entries(SHAPES).map(([id, shape]) => mk(id, shape)), hand];
const ZOOMS = [0.5, 1, 2];

/**
 * The route a FINGER touch-down gets. Screen points -> page units via the zoom, exactly like Notebook
 * (canvasScaleRef) and the native overlay (pdfView.scaleFactor): tolerances are SCREEN points.
 */
function fingerRoute(stroke, downPagePoint, zoom, touchCount = 1) {
  const units = 1 / zoom;
  const region = boundsOfPoints(stroke.points);
  return routeSelectionTouch({
    pointer: 'touch',
    touchCount,
    hasSelection: true,
    insideSelection: insideSelectionRegion(region, downPagePoint, SELECTION_TOUCH_PAD_PT * units),
    onHandle: nearestShapeHandle(stroke.shape.geometry, downPagePoint, SHAPE_HANDLE_HIT_PT * units) !== null,
  });
}

console.log('Finger routing on a selected structured shape (handle > body > page) at 0.5x / 1x / 2x');
for (const [name, shape] of Object.entries(SHAPES)) {
  check(`${name}: ${EXPECTED_HANDLES[name]} handles; a finger within the 24pt hit radius of EACH handle edits it, at every zoom`, () => {
    const stroke = mk(name, shape);
    const handles = shapeHandles(shape.geometry);
    assert.equal(handles.length, EXPECTED_HANDLES[name]);
    const centroid = { x: handles.reduce((sum, h) => sum + h.x, 0) / handles.length, y: handles.reduce((sum, h) => sum + h.y, 0) / handles.length };
    for (const zoom of ZOOMS) {
      handles.forEach((handle, index) => {
        // The finger lands OUTWARD of the handle (away from the shape's centre), like a real thumb on a corner.
        const len = Math.hypot(handle.x - centroid.x, handle.y - centroid.y) || 1;
        const out = { x: (handle.x - centroid.x) / len, y: (handle.y - centroid.y) / len };
        for (const offsetPt of [0, 10, 20]) {
          const down = { x: handle.x + (out.x * offsetPt) / zoom, y: handle.y + (out.y * offsetPt) / zoom };
          assert.equal(nearestShapeHandle(shape.geometry, down, SHAPE_HANDLE_HIT_PT / zoom), index, `${name}[${index}] @${zoom}x +${offsetPt}pt`);
          assert.equal(fingerRoute(stroke, down, zoom), 'shape-handle-edit', `${name}[${index}] @${zoom}x +${offsetPt}pt routes to the handle, never the body`);
        }
      });
    }
  });
}
check('the hit target is screen-consistent: 20 screen-pt off a handle hits at every zoom, 40 screen-pt off does not', () => {
  const g = SHAPES.quad.geometry;
  const handle = shapeHandles(g)[1];
  for (const zoom of ZOOMS) {
    assert.equal(nearestShapeHandle(g, { x: handle.x + 20 / zoom, y: handle.y }, SHAPE_HANDLE_HIT_PT / zoom), 1);
    assert.equal(nearestShapeHandle(g, { x: handle.x + 40 / zoom, y: handle.y }, SHAPE_HANDLE_HIT_PT / zoom), null);
  }
});
check('finger inside the body but off every handle MOVES (does not edit a handle); far outside stays with the page', () => {
  const quad = mk('quad', SHAPES.quad);
  for (const zoom of ZOOMS) {
    assert.equal(fingerRoute(quad, { x: 380, y: 430 }, zoom), 'selection-move', `body @${zoom}x`);
    assert.equal(fingerRoute(quad, { x: 40, y: 700 }, zoom), 'page-navigation', `outside @${zoom}x`);
  }
});
check('two fingers inside still pinch-scale; a handle under the first finger does not turn a pinch into an edit', () => {
  const quad = mk('quad', SHAPES.quad);
  for (const zoom of ZOOMS) {
    const units = 1 / zoom;
    const region = boundsOfPoints(quad.points);
    const route = routeSelectionTouch({
      pointer: 'touch', touchCount: 2, hasSelection: true,
      insideSelection: insideSelectionRegion(region, { x: 430, y: 380 }, SELECTION_TOUCH_PAD_PT * units),
      onHandle: true,
      secondInsideSelection: insideSelectionRegion(region, { x: 380, y: 430 }, SELECTION_TOUCH_PAD_PT * units),
    });
    assert.equal(route, 'selection-scale');
  }
});

console.log('\nFinger handle drag -> geometry (shared edit semantics, page space, no drift under zoom)');
/** One finger drag: down at handle+offset, move by `pagePath`, release. Screen positions are page*zoom, as on device. */
function fingerDrag(stroke, handleIndex, zoom, releasePage, downOffsetPt = 12) {
  const handle = shapeHandles(stroke.shape.geometry)[handleIndex];
  const downScreen = { x: handle.x * zoom + downOffsetPt, y: handle.y * zoom };
  const down = { x: downScreen.x / zoom, y: downScreen.y / zoom };
  assert.equal(nearestShapeHandle(stroke.shape.geometry, down, SHAPE_HANDLE_HIT_PT / zoom), handleIndex);
  const grabOffset = { x: handle.x - down.x, y: handle.y - down.y };
  const releaseScreen = { x: (releasePage.x) * zoom + downOffsetPt, y: releasePage.y * zoom };
  const upPage = { x: releaseScreen.x / zoom, y: releaseScreen.y / zoom };
  return { x: upPage.x + grabOffset.x, y: upPage.y + grabOffset.y };
}
check('QUAD: the dragged corner follows the finger; the other three are untouched; it is NOT forced back to a rectangle; result identical at every zoom', () => {
  const results = ZOOMS.map((zoom) => {
    const strokes = pageOf();
    const quad = strokes.find((s) => s.id === 'quad');
    const target = fingerDrag(quad, 1, zoom, { x: 470, y: 350 });
    assert.ok(Math.abs(target.x - 470) < 1e-9 && Math.abs(target.y - 350) < 1e-9, `target has no zoom drift @${zoom}x: ${JSON.stringify(target)}`);
    const change = materialShapeEdit(1, strokes, 'quad', 1, target);
    const after = change.afterStrokes.find((s) => s.id === 'quad');
    const v = after.shape.geometry.vertices;
    assert.deepEqual([v[0], v[2], v[3]], [{ x: 330, y: 380 }, { x: 430, y: 480 }, { x: 330, y: 480 }], 'other corners unchanged');
    assert.ok(Math.abs(v[1].x - 470) < 1e-9 && Math.abs(v[1].y - 350) < 1e-9, 'dragged corner at the finger');
    assert.notEqual(v[1].x, v[2].x, 'no forced rectangle: the edited quad is a general quadrilateral');
    assert.ok(inkPointsMatchShape(after, 1e-9), 'ink points regenerated from the edited geometry');
    for (const other of change.afterStrokes) if (other.id !== 'quad') assert.equal(other, strokes.find((s) => s.id === other.id), `${other.id} keeps identity`);
    return v;
  });
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
});
check('TRIANGLE / LINE: the touched vertex/endpoint follows the finger and nothing else moves', () => {
  for (const zoom of ZOOMS) {
    const strokes = pageOf();
    const tri = strokes.find((s) => s.id === 'triangle');
    const triTarget = fingerDrag(tri, 1, zoom, { x: 330, y: 520 });
    const triAfter = materialShapeEdit(1, strokes, 'triangle', 1, triTarget).afterStrokes.find((s) => s.id === 'triangle');
    assert.deepEqual(triAfter.shape.geometry.vertices, [{ x: 200, y: 500 }, { x: 330, y: 520 }, { x: 250, y: 600 }], `triangle @${zoom}x`);
    const line = strokes.find((s) => s.id === 'line');
    const lineTarget = fingerDrag(line, 1, zoom, { x: 260, y: 230 });
    const lineAfter = materialShapeEdit(1, strokes, 'line', 1, lineTarget).afterStrokes.find((s) => s.id === 'line');
    assert.deepEqual(lineAfter.shape.geometry, { kind: 'line', a: { x: 100, y: 150 }, b: { x: 260, y: 230 } }, `line @${zoom}x`);
  }
});
check('ELLIPSE (4 handles): right handle resizes along its axis with the LEFT side anchored (circle -> ellipse); top handle edits the other axis', () => {
  for (const zoom of ZOOMS) {
    const strokes = pageOf();
    const ell = strokes.find((s) => s.id === 'ellipse');
    const before = shapeHandles(ell.shape.geometry);
    const right = fingerDrag(ell, 1, zoom, { x: 480, y: 300 });
    const afterRight = materialShapeEdit(1, strokes, 'ellipse', 1, right).afterStrokes.find((s) => s.id === 'ellipse').shape.geometry;
    const handles = shapeHandles(afterRight);
    assert.deepEqual(handles[3], before[3], `opposite (left) side stays exactly anchored @${zoom}x`);
    assert.ok(Math.abs(handles[1].x - 480) < 1e-9 && Math.abs(handles[1].y - 300) < 1e-9, 'dragged handle at the finger');
    assert.equal(afterRight.kind, 'ellipse');
    const top = fingerDrag(ell, 0, zoom, { x: 400, y: 250 });
    const afterTop = shapeHandles(materialShapeEdit(1, strokes, 'ellipse', 0, top).afterStrokes.find((s) => s.id === 'ellipse').shape.geometry);
    assert.deepEqual(afterTop[2], before[2], `bottom stays anchored when the top handle moves @${zoom}x`);
  }
});

console.log('\nSelection persistence + history (ONE action per finger drag)');
check('state machine: BEGIN_HANDLE -> END_HANDLE returns to the SAME selected shape (handles stay); cancel does not deselect', () => {
  let state = selectionReduce(IDLE_SELECTION, { type: 'TAP_SHAPE', id: 'quad' }).state;
  assert.equal(state.kind, 'SELECTED_SHAPE');
  state = selectionReduce(state, { type: 'BEGIN_HANDLE' }).state;
  assert.equal(state.kind, 'EDITING_SHAPE_HANDLE');
  assert.equal(selectionReduce(state, { type: 'END_HANDLE' }).state.kind, 'SELECTED_SHAPE');
  const cancelled = selectionReduce(state, { type: 'MANIPULATION_CANCELLED' });
  assert.equal(cancelled.state.kind, 'SELECTED_SHAPE');
  assert.equal(cancelled.cleared, null);
  // A second finger cannot upgrade a handle edit into a scale.
  assert.equal(selectionReduce(state, { type: 'BEGIN_SCALE' }).state.kind, 'EDITING_SHAPE_HANDLE');
});
check('history: one finger handle drag = ONE entry; Undo restores the exact previous geometry; Redo the exact edit (quad/triangle/line/ellipse)', () => {
  for (const [id, handleIndex, releasePage] of [['quad', 1, { x: 470, y: 350 }], ['triangle', 2, { x: 260, y: 640 }], ['line', 0, { x: 90, y: 120 }], ['ellipse', 1, { x: 480, y: 300 }]]) {
    let strokes = pageOf();
    const original = clone(strokes);
    let history = EMPTY_MATERIAL_HISTORY;
    const target = fingerDrag(strokes.find((s) => s.id === id), handleIndex, 1, releasePage);
    const edit = materialShapeEdit(1, strokes, id, handleIndex, target);
    history = pushMaterialHistory(history, { kind: 'shape-edit', pageNumber: 1, strokeId: id, beforeStrokes: edit.beforeStrokes, afterStrokes: edit.afterStrokes });
    strokes = edit.afterStrokes;
    const edited = clone(strokes);
    assert.equal(history.undo.length, 1, `${id}: one history entry for the whole drag`);
    let popped = popMaterialHistoryUndo(history); history = popped.state;
    strokes = applyMaterialHistoryUndo(popped.action, strokes, []).strokes;
    assert.deepEqual(strokes, original, `${id}: Undo restores the exact geometry before the drag`);
    popped = popMaterialHistoryRedo(history); history = popped.state;
    strokes = applyMaterialHistoryRedo(popped.action, strokes, []).strokes;
    assert.deepEqual(strokes, edited, `${id}: Redo reapplies the exact edited geometry`);
  }
});

console.log('\nSource contracts: Course Material native routing == the shared router; Notebook consumes it; Pencil paths unchanged');
const swift = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const notebook = read('components/NotebookCanvas.tsx');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
const router = read('lib/selectionTransform.ts');

check('shared router: a one-finger touch on a handle is `shape-handle-edit`, decided before the body/inside test', () => {
  const touch = slice(router, "if (input.pointer === 'touch') {", "return 'page-navigation';\n}");
  assert.ok(touch.indexOf('input.onHandle') >= 0 && touch.indexOf('input.onHandle') < touch.indexOf('input.insideSelection'));
  assert.match(touch, /input\.touchCount < 2 && input\.onHandle\) return 'shape-handle-edit'/);
});
check('native: beginFingerManipulation orders scale -> HANDLE -> move (the body move must never run before the handle test)', () => {
  const fn = slice(swift, 'func beginFingerManipulation(at points: [CGPoint]) -> FingerManipulation {', '// MARK: Structured shape handle drag');
  const scale = fn.indexOf('beginScale(at:');
  const handle = fn.indexOf('beginHandleDragIfHit(at:');
  const move = fn.indexOf('beginMoveIfHit(at:');
  assert.ok(scale >= 0 && handle > scale && move > handle, `order scale(${scale}) < handle(${handle}) < move(${move})`);
  assert.match(fn, /points\.count >= 2, beginScale/);
  assert.match(fn, /padPt: SelectionLimits\.touchPadPt/, 'body move keeps the looser finger pad');
});
check('native: the finger recogniser goes THROUGH beginFingerManipulation and handles .handle in began/changed/ended/cancelled', () => {
  const handler = slice(swift, '@objc private func handleSelectionFingerGesture(', '@objc private func handleSelectionTap(');
  assert.match(handler, /fingerSelectionMode = annotationOverlay\.beginFingerManipulation\(at: points\)/);
  assert.doesNotMatch(slice(handler, 'case .began:', 'case .changed:'), /beginMoveIfHit|beginScale/, 'no direct body-move test before the handle test');
  assert.match(handler, /case \.handle: if let first = points\.first \{ annotationOverlay\.updateHandleDrag\(at: first\) \}/);
  assert.match(handler, /case \.handle:\s*if let end = points\.first, let edit = annotationOverlay\.finishHandleDrag\(at: end\)/);
  assert.match(handler, /case \.handle: annotationOverlay\.cancelHandleDrag\(\)/);
  assert.match(handler, /onShapeEdited\(\["pageNumber": edit\.pageNumber, "strokeId": edit\.strokeId, "handleIndex": edit\.handleIndex/);
});
check('native perf contract: the finger drag is a local live preview; JS hears ONE event on release (no per-sample event/prop/history)', () => {
  const handler = slice(swift, '@objc private func handleSelectionFingerGesture(', '@objc private func handleSelectionTap(');
  const changed = slice(handler, 'case .changed:', 'case .ended:');
  assert.doesNotMatch(changed, /onShapeEdited|onSelection|onPencil|JSON|history/i);
  assert.equal((handler.match(/onShapeEdited\(/g) ?? []).length, 1, 'exactly one shape-edit emit site in the finger handler');
});
check('native: selection CREATION and the Pencil arbitration are unchanged (Pencil-only recogniser; handle before move)', () => {
  assert.match(swift, /selectionGesture: PageSelectionGestureRecognizer = \{[\s\S]*?allowedTouchTypes = \[NSNumber\(value: UITouch\.TouchType\.pencil\.rawValue\)\]/);
  const pencil = slice(swift, '@objc private func handleSelectionGesture(', '// MARK: - Pencil gesture callback');
  assert.ok(pencil.indexOf('beginHandleDragIfHit(at: start)') >= 0 && pencil.indexOf('beginHandleDragIfHit(at: start)') < pencil.indexOf('beginMoveIfHit(at: start)'));
  assert.match(swift, /gesture\.beginsInside = \{ \[weak self\] point in self\?\.annotationOverlay\.fingerHitsSelection\(at: point\) \?\? false \}/);
});
check('Notebook consumes the shared decision (onHandle) and still lets the finger through only for move or handle', () => {
  const down = slice(notebook, "const route = routeSelectionTouch({", "fingerSelectionMove = true;");
  assert.match(down, /pointer: 'touch',\s*touchCount: 1,/);
  assert.match(down, /onHandle: point !== null && selectedNow\.length === 1 && isStructuredStroke\(selectedNow\[0\]\)/);
  assert.match(down, /SHAPE_HANDLE_HIT_PT \/ \(canvasScaleRef\.current \|\| 1\)/);
  assert.match(down, /route !== 'selection-move' && route !== 'shape-handle-edit'/);
  // the local handle begin (accepted behaviour) still runs before the body move
  const begin = notebook.indexOf('if (beginShapeHandleEdit(point)) return;');
  assert.ok(begin > 0 && begin < notebook.indexOf('let inBounds = false;', begin));
});
check('Course Material JS: the shape-edit handler is pointer-agnostic and records ONE history action per event', () => {
  const handler = slice(screen, 'const handleNativeShapeEdited = useCallback(', 'const handleSelectColor');
  assert.doesNotMatch(handler, /pointer|pencil|stylus|finger|touch/i);
  assert.equal((handler.match(/pushMaterialHistory\(/g) ?? []).length, 1);
  assert.match(handler, /kind: 'shape-edit'/);
});

console.log('\nselection-finger-handle-parity: routing, edit semantics at 0.5x/1x/2x, persistence, history, source contracts PASS');
