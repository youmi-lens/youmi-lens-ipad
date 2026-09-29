/**
 * Selection Interaction Phase: adapters and contracts.
 *  - one authoritative selection state machine per workspace (no ad-hoc clear sites)
 *  - finger move / two-finger scale routing, one history action, outline attachment
 *  - Course Material JS scale / history / undo-redo persistence
 *  - performance gate: local previews only, one commit at gesture end
 * Run: node --experimental-strip-types scripts/selection-interaction-integration.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { IDLE_SELECTION, selectedIdsOf, selectionReduce } from '../lib/selectionMachine.ts';
import { shapeToInkPoints, inkPointsMatchShape } from '../lib/annotationShape.ts';
import { materialSelectionMove, materialSelectionScale } from '../lib/materialSelection.ts';
import {
  EMPTY_MATERIAL_HISTORY, applyMaterialHistoryRedo, applyMaterialHistoryUndo,
  popMaterialHistoryRedo, popMaterialHistoryUndo, pushMaterialHistory,
} from '../lib/materialHistory.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const slice = (src, from, to) => {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `slice start marker missing: ${from.slice(0, 70)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `slice end marker missing: ${to.slice(0, 70)}`);
  return src.slice(start, end);
};
const nb = read('components/NotebookCanvas.tsx');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
const swift = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');

console.log('One authoritative selection state per workspace');
check('Notebook: selection state is written ONLY by the dispatcher (no ad-hoc clear sites anywhere else)', () => {
  assert.equal((nb.match(/setSelectedIds\(/g) ?? []).length, 1, 'setSelectedIds is called from exactly one place');
  const dispatcher = slice(nb, 'const dispatchSelection = useCallback', 'const selectionShapeRef');
  assert.match(dispatcher, /selectionReduce\(before, event\)/);
  assert.match(dispatcher, /setSelectedIds\(next\)/);
  const outside = nb.replace(dispatcher, '');
  assert.doesNotMatch(outside, /selectedIdsRef\.current = new Set/, 'no other site writes the selection ref');
  assert.equal((nb.match(/selectedIdsRef\.current = selectedIds;/g) ?? []).length, 1, 'the ref mirrors state once per render');
});
check('Notebook: every dispatch uses a documented event; only explicit events can clear', () => {
  const types = [...nb.matchAll(/dispatchSelection\(\{ type: '([A-Z_]+)'/g)].map((m) => m[1]);
  const allowed = new Set(['TOOL_CHANGE', 'CONTENT_CHANGED', 'DELETE', 'TAP_BLANK', 'REGION_CANCELLED', 'REGION_DRAGGED', 'REGION_COMPLETE', 'BEGIN_REGION',
    'SELECT_INK', 'TAP_SHAPE', 'BEGIN_MOVE', 'END_MOVE', 'BEGIN_SCALE', 'END_SCALE', 'BEGIN_HANDLE', 'END_HANDLE', 'MANIPULATION_CANCELLED']);
  assert.ok(types.length > 15);
  for (const t of types) assert.ok(allowed.has(t), `unexpected selection event ${t}`);
  assert.doesNotMatch(nb, /type: 'CANCEL'/, 'Notebook has no implicit cancel-all');
});
check('Notebook: gesture end / cancel / finalize never clear the selection (only manipulation events)', () => {
  const endStroke = slice(nb, 'const endStroke = useCallback', 'const abortStroke = useCallback');
  assert.doesNotMatch(endStroke, /TAP_BLANK|TOOL_CHANGE|DELETE|'CANCEL'/);
  const abort = slice(nb, 'const abortStroke = useCallback', 'const touchToCanvasPoint = useCallback');
  assert.match(abort, /REGION_CANCELLED/);
  assert.match(abort, /MANIPULATION_CANCELLED/);
  assert.doesNotMatch(abort, /TAP_BLANK|TOOL_CHANGE|DELETE/);
});
check('Notebook: a new Box/Lasso does NOT clear at Pencil-down; only after the drag proves it is a region, or a blank tap', () => {
  const down = slice(nb, "dispatchSelection({ type: 'BEGIN_REGION'", 'return;');
  assert.ok(down.length > 0);
  const commit = slice(nb, 'const commitLasso = useCallback', 'const commitRectSelection = useCallback');
  assert.match(commit, /REGION_CANCELLED[\s\S]*TAP_BLANK/, 'a tap on blank paper is the explicit deselect');
  assert.match(commit, /REGION_DRAGGED[\s\S]*REGION_COMPLETE/);
  assert.match(nb, /dispatchSelection\(\{ type: 'REGION_DRAGGED' \}, 'lasso-move'\)/);
});
check('Notebook: undo/redo (applySnapshot) keeps every selected object that still exists', () => {
  const apply = slice(nb, 'const applySnapshot = useCallback', 'erasedIdsRef.current.clear();');
  assert.match(apply, /type: 'CONTENT_CHANGED', existingIds/);
  assert.doesNotMatch(apply, /new Set\(\)/);
});
check('Notebook: handle completion / body move / pinch end each dispatch the END event (back to the same selection)', () => {
  const end = slice(nb, 'const endStroke = useCallback', 'const abortStroke = useCallback');
  assert.match(end, /commitMove\(\); dispatchSelection\(\{ type: 'END_MOVE' \}/);
  assert.match(end, /commitScale\(\); dispatchSelection\(\{ type: 'END_SCALE' \}/);
  assert.match(end, /commitShapeEdit\(\);\s*dispatchSelection\(\{ type: 'END_HANDLE' \}/);
});

console.log('\nThe PRODUCTION Notebook dispatcher, executed');
check('replay: tap shape -> ambient events -> handle edit -> move -> pinch -> blank tap; setState only on real changes', () => {
  const raw = slice(nb, 'const dispatchSelection = useCallback(', 'const selectionShapeRef');
  const inner = raw.slice('const dispatchSelection = useCallback('.length, raw.lastIndexOf(', []);'));
  const transpiled = ts.transpileModule(`function build() { const dispatchSelection = ${inner}; return dispatchSelection; }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const ref = { current: new Set() };
  const setCalls = [];
  const env = {
    selectionMachineRef: { current: IDLE_SELECTION }, selectionReduce, selectedIdsOf, selectedIdsRef: ref,
    setSelectedIds: (next) => setCalls.push([...next]), SELECTION_TRACE_ENABLED: false, traceSelection: () => {},
    useCallback: (fn) => fn,
  };
  const dispatch = new Function(...Object.keys(env), `${transpiled}\nreturn build();`)(...Object.values(env));
  const step = (event) => dispatch(event);
  step({ type: 'TAP_SHAPE', id: 'tri' });
  assert.deepEqual([...ref.current], ['tri']);
  const afterTap = setCalls.length;
  for (const cause of ['gesture-ended', 'gesture-cancelled', 'store-echo', 'annotation-reload', 'pencil-lift', 'finger-touch-inside', 'rerender', 'handle-drag-complete']) step({ type: 'NOOP', cause });
  assert.equal(setCalls.length, afterTap, 'ambient events cause NO state write (no rerender, no clear)');
  step({ type: 'BEGIN_HANDLE' }); step({ type: 'END_HANDLE' });
  assert.deepEqual([...ref.current], ['tri'], 'handle edit completion: still selected');
  step({ type: 'BEGIN_MOVE' }); step({ type: 'END_MOVE' });
  step({ type: 'BEGIN_SCALE' }); step({ type: 'END_SCALE' });
  assert.deepEqual([...ref.current], ['tri'], 'move and pinch completion: still selected');
  assert.equal(setCalls.length, afterTap, 'manipulations never rewrite an unchanged selection');
  step({ type: 'CONTENT_CHANGED', existingIds: ['tri', 'other'] });
  assert.deepEqual([...ref.current], ['tri'], 'undo/redo with the object present: still selected');
  const blank = step({ type: 'TAP_BLANK' });
  assert.equal(blank.cleared, 'blank-tap');
  assert.deepEqual([...ref.current], [], 'blank tap deselects');
  step({ type: 'SELECT_INK', ids: ['a', 'b'] });
  const removed = step({ type: 'CONTENT_CHANGED', existingIds: ['z'] });
  assert.equal(removed.cleared, 'object-removed');
});

console.log('\nCourse Material: authoritative native state machine');
check('native: every selection change goes through dispatch(); ids are a projection of the machine', () => {
  const dispatch = slice(swift, 'private func dispatch(_ event: SelectionEvent) -> String? {', 'private func dropSelectionVisuals()');
  assert.match(dispatch, /SelectionMachine\.reduce\(machine, event\)/);
  assert.match(dispatch, /selectedStrokeIds = Set\(SelectionMachine\.selectedIds\(next\)\)/);
  assert.equal((swift.match(/selectedStrokeIds = /g) ?? []).length, 1, 'selectedStrokeIds is assigned in exactly one place');
  assert.equal((swift.match(/selectionPageNumber = nil/g) ?? []).length, 1, 'the selection page is dropped in exactly one place (dropSelectionVisuals)');
});
check('native: cancelled / failed recognisers abandon the manipulation and NEVER clear the selection', () => {
  for (const marker of ['case .cancelled, .failed:\n      // A cancelled/failed gesture is NOT a deselection', 'case .cancelled, .failed:\n      // Abandons the manipulation only']) {
    const from = swift.indexOf(marker);
    assert.ok(from > 0, marker.slice(0, 50));
    const body = swift.slice(from, from + 900);
    assert.doesNotMatch(body.split('default:')[0], /clearSelection\(\)/);
  }
});
check('native: leaving Select is the explicit tool-change deselect; the Box/Lasso toggle is not a deselect', () => {
  assert.match(swift, /if annotationMode != "select" \{ selectionToolChanged\(\) \}/);
  assert.match(swift, /didSet \{ if selectionShape != oldValue \{ annotationOverlay\.cancelRegion\(\) \} \}/);
});
check('native: reload/undo/redo reconcile (kept while objects exist; in-flight copies protected)', () => {
  assert.match(swift, /reconcileSelectionAfterLoad\(\)\n    refreshSelectionChrome\(\)/);
  assert.match(swift, /dispatch\(\.contentChanged\(Array\(present\.union\(unseenSelectedIds\)\)\)\)/);
});
check('JS: Course Material undo/redo no longer clears the selection; a delete still does', () => {
  const undo = slice(screen, 'const undoNativeCurrentPage = useCallback', 'const clearNativeCurrentPage = useCallback');
  assert.doesNotMatch(undo, /clearSelection\(\)|setNativeSelection\(\{ pageNumber: 0/);
  const change = slice(screen, 'const changeNativeSelection = useCallback', 'const hasNativeSelection');
  assert.match(change, /pdfRef\.current\?\.clearSelection\(\)/);
});

console.log('\nOne-finger move + two-finger scale routing');
check('Notebook: finger routing is routeSelectionTouch; a finger outside the region fails so the ScrollView navigates', () => {
  const down = slice(nb, '.onTouchesDown((event, manager) => {', '.onTouchesMove((event) => {');
  assert.match(down, /if \(!isStylusTouch && isSelectionInteractiveMode\(activeMode\) && \(activeMode === 'select' \|\| selectedIdsRef\.current\.size > 0\)\)/);
  assert.match(down, /pointer: 'touch',\s*touchCount: 1,/);
  assert.match(down, /if \(route !== 'selection-move' && route !== 'shape-handle-edit'\) \{\s*manager\.fail\(\);\s*return;/);
  assert.match(down, /fingerSelectionMove = true;/);
  assert.match(down, /SELECTION_TOUCH_PAD_PT : SELECTION_PENCIL_PAD_PT/, 'screen-point tolerance, finger looser than Pencil');
  assert.match(down, /fingerManipulationRef\.current = fingerSelectionMove;\s*beginStylusScrollLock\(\);/, 'the page scroll is locked ONLY once a finger owns a selection move');
});
check('Notebook: a finger move reuses the move preview + ONE commit (no history per sample)', () => {
  const move = slice(nb, "selectActionRef.current === 'move') {\n              const start = selectionMoveStartRef.current;", "            }\n            return;");
  assert.doesNotMatch(move, /recordHistory|onStrokesChange|onImagesChange/);
  const commit = slice(nb, 'const commitMove = useCallback', 'const commitStroke = useCallback');
  assert.equal((commit.match(/recordHistory\(\)/g) ?? []).length, 1);
});
check('Notebook: a second finger inside upgrades to a scale; two fingers outside stay page zoom (blocked only by our own scroll lock)', () => {
  const helper = slice(nb, 'const beginFingerScaleIfEligible = useCallback', 'const drawGesture = useMemo(');
  assert.match(helper, /routeSelectionTouch\(\{[\s\S]*touchCount: 2,[\s\S]*secondInsideSelection/);
  assert.match(helper, /if \(route !== 'selection-scale'\) return;/);
  assert.match(helper, /selectActionRef\.current !== 'move'/);
  assert.match(helper, /selectionMoveOffsetRef\.current = \{ x: 0, y: 0 \};/, 'the move preview is discarded: scale starts from the ORIGINAL geometry');
  assert.match(nb, /if \(event\.numberOfTouches > 1\) \{\s*beginFingerScaleIfEligible\(event, manager\);\s*return;\s*\}/);
  const pinch = slice(nb, 'const pinchGesture = useMemo', 'const selectionTapGesture = useMemo');
  assert.match(pinch, /if \(zoomBlocked\.value\) return;/, 'page pinch is blocked only while a selection manipulation owns the touches');
});
check('Notebook: pinch = local preview only (SelectionScaleHost), always ORIGINAL x factor, ONE history action at the end', () => {
  const move = slice(nb, "} else if (selectActionRef.current === 'scale') {\n              const session", "} else if (selectActionRef.current === 'handle') {");
  assert.match(move, /clampSelectionScale\(pinchFactor\(session\.startDistance/);
  assert.match(move, /scaleHostRef\.current\?\.update\(factor\)/);
  assert.doesNotMatch(move, /onStrokesChange|recordHistory|setSelectedIds|dispatchSelection|setScalingActive/);
  const host = slice(nb, 'const SelectionScaleHost = memo', 'type ShapeHandlesHandle = {');
  assert.match(host, /begin: \(strokes, center\) => setSession\(\{ strokes, center, factor: 1 \}\)/, 'snapshot at begin: immune to store echoes');
  assert.match(host, /scaleInkStroke\(stroke, session\.center, session\.factor\)/);
  assert.match(host, /width: stroke\.width \+ 5/, 'the halo only; pen width itself is never scaled');
  const commit = slice(nb, 'const commitScale = useCallback', 'const commitShapeEdit');
  assert.equal((commit.match(/recordHistory\(\)/g) ?? []).length, 1);
  assert.match(commit, /scaleSelectedStrokes\(strokesRef\.current, session\.ids, session\.center, session\.factor\)/);
  assert.match(commit, /scaleAwaitingRef\.current = session\.originals/);
});
check('Notebook: the outline/handles come from the SCALED preview and the originals are hidden only between begin and the store echo', () => {
  assert.match(nb, /showSelectionBounds=\{mode === 'select' && !singleSelectedShape && !scalingActive\}/);
  assert.match(nb, /stroke=\{scalingActive \? null : singleSelectedShape\}/);
  assert.equal((nb.match(/setScalingActive\(/g) ?? []).length, 2, 'set at begin and at finish only — never per sample');
});
check('Notebook: finger tap selects a shape / deselects on blank paper, but never on an image, the action bar, the selection or the Pencil', () => {
  const tap = slice(nb, 'const selectionTapGesture = useMemo', 'const notebookGestures = useMemo');
  assert.match(tap, /if \(event\.pointerType === PointerType\.STYLUS\) return;/);
  assert.match(tap, /if \(findImageAtPoint\(point\)\) return;/);
  assert.match(tap, /IMAGE_ACTION_BAR_WIDTH/);
  assert.match(tap, /insideSelectionRegion\(region, point/);
  assert.match(tap, /TAP_BLANK/);
});
check('native: the finger recogniser begins ONLY inside the selection and fails elsewhere so PDFView keeps panning/zooming', () => {
  const recogniser = slice(swift, 'final class SelectionFingerGestureRecognizer', '/// Pencil-only gesture recognizer.');
  assert.match(recogniser, /guard beginsInside\?\(touch\.location\(in: view\)\) == true else \{\s*if tracked\.isEmpty \{ state = \.failed; return \}/);
  assert.match(recogniser, /tracked\.count < 2/);
  const handler = slice(swift, '@objc private func handleSelectionFingerGesture', '@objc private func handleSelectionTap');
  assert.match(handler, /setNonPencilGesturesEnabled\(false\)/);
  assert.equal((handler.match(/setNonPencilGesturesEnabled\(true\)/g) ?? []).length, 2, 'PDFView gestures are restored on end AND cancel');
  assert.match(swift, /gesture\.beginsInside = \{ \[weak self\] point in self\?\.annotationOverlay\.fingerHitsSelection\(at: point\) \?\? false \}/);
  assert.match(swift, /selectionFingerGesture\.isEnabled = selectionTouchModes/, 'only while Select/Pen/Highlighter is active; navigation elsewhere is untouched');
  assert.doesNotMatch(swift, /scrollView\.isScrollEnabled = false/, 'the PDF scroll view is never globally disabled');
});

console.log('\nCourse Material scale: logic, history, coordinates');
const ink = (id, pts, extra = {}) => ({ id, tool: 'pen', color: '#123456', width: 3, points: pts.map(([x, y]) => ({ x, y })), coordSpace: 'pdfPage', createdAt: 't', ...extra });
const a = ink('a', [[100, 100], [200, 100], [200, 200]]);
const b = ink('b', [[300, 300], [400, 350]]);
const z = ink('z', [[900, 900], [910, 910]]);
const triShape = { origin: 'triangle', geometry: { kind: 'polygon', vertices: [{ x: 200, y: 500 }, { x: 300, y: 500 }, { x: 250, y: 600 }] } };
const tri = { id: 'tri', tool: 'pen', color: '#000', width: 3, points: shapeToInkPoints(triShape), shape: triShape, coordSpace: 'pdfPage', createdAt: 't' };
const sel = (...ids) => ({ pageNumber: 1, strokeIds: ids });
check('scale about the captured center: geometry x factor, others keep identity, width/style/id preserved', () => {
  const change = materialSelectionScale(sel('a', 'b'), [a, b, z], 1.5, { x: 250, y: 200 });
  const [sa] = change.afterStrokes;
  assert.deepEqual(sa.points[0], { x: 250 + (100 - 250) * 1.5, y: 200 + (100 - 200) * 1.5 });
  assert.equal(sa.width, 3); assert.equal(sa.color, '#123456'); assert.equal(sa.id, 'a');
  assert.equal(change.afterStrokes[2], z);
});
check('structured shape scale regenerates points from the scaled geometry (invariant holds)', () => {
  const change = materialSelectionScale(sel('tri'), [tri], 1.5, { x: 250, y: 550 });
  const scaled = change.afterStrokes[0];
  assert.deepEqual(scaled.shape.geometry.vertices[0], { x: 175, y: 475 });
  assert.ok(inkPointsMatchShape(scaled, 1e-9));
});
check('refused: factor 1, NaN, negative, legacy viewport ink, empty selection', () => {
  assert.equal(materialSelectionScale(sel('a'), [a], 1, { x: 0, y: 0 }), null);
  assert.equal(materialSelectionScale(sel('a'), [a], NaN, { x: 0, y: 0 }), null);
  assert.equal(materialSelectionScale(sel('a'), [a], -2, { x: 0, y: 0 }), null);
  assert.equal(materialSelectionScale(sel('a'), [{ ...a, coordSpace: 'viewport' }], 2, { x: 0, y: 0 }), null);
  assert.equal(materialSelectionScale(sel(), [a], 2, { x: 0, y: 0 }), null);
});
check('ONE history action per pinch / move; undo restores EXACT geometry, redo the exact result (move + scale mixed)', () => {
  let strokes = [a, b, z];
  const original = JSON.parse(JSON.stringify(strokes));
  let history = EMPTY_MATERIAL_HISTORY;
  const move = materialSelectionMove(sel('a', 'b'), strokes, 20, -10);
  history = pushMaterialHistory(history, { kind: 'selection-move', pageNumber: 1, strokeIds: ['a', 'b'], ...move });
  strokes = move.afterStrokes;
  const afterMove = JSON.parse(JSON.stringify(strokes));
  const scale = materialSelectionScale(sel('a', 'b'), strokes, 1.5, { x: 270, y: 190 });
  history = pushMaterialHistory(history, { kind: 'selection-scale', pageNumber: 1, strokeIds: ['a', 'b'], ...scale });
  strokes = scale.afterStrokes;
  const afterScale = JSON.parse(JSON.stringify(strokes));
  assert.equal(history.undo.length, 2);
  let popped = popMaterialHistoryUndo(history); history = popped.state;
  strokes = applyMaterialHistoryUndo(popped.action, strokes, []).strokes;
  assert.deepEqual(strokes, afterMove, 'undo of the pinch restores the moved geometry exactly');
  popped = popMaterialHistoryUndo(history); history = popped.state;
  strokes = applyMaterialHistoryUndo(popped.action, strokes, []).strokes;
  assert.deepEqual(strokes, original, 'undo of the move restores the original');
  popped = popMaterialHistoryRedo(history); history = popped.state;
  strokes = applyMaterialHistoryRedo(popped.action, strokes, []).strokes;
  popped = popMaterialHistoryRedo(history); history = popped.state;
  strokes = applyMaterialHistoryRedo(popped.action, strokes, []).strokes;
  assert.deepEqual(strokes, afterScale, 'redo restores the exact final geometry');
});
check('the screen persists a pinch as ONE action from the native center, and never delivers props per frame', () => {
  const handler = slice(screen, 'const handleNativeSelectionScaled = useCallback', 'const handleNativeShapeEdited = useCallback');
  assert.equal((handler.match(/pushMaterialHistory\(/g) ?? []).length, 1);
  assert.match(handler, /materialSelectionScale\(/);
  assert.match(handler, /\{ x: event\.centerX, y: event\.centerY \}/);
  assert.equal((swift.match(/onSelectionScaled\(\[/g) ?? []).length, 1, 'ONE native event per completed pinch');
});

console.log('\nPerformance gate (Course Material stays PK4-C3-safe)');
check('native move / scale / handle previews never emit, deliver props, serialize or touch files per sample', () => {
  const forbidden = /onSelectionMoved|onSelectionScaled|onShapeEdited|onAnnotationsChanged|loadAnnotations|serializeStroke|FileHandle|write\(to|Data\(contentsOf|setNeedsDisplay|annotationsByPage/;
  for (const [from, to] of [
    ['func updateMove(at viewPoint: CGPoint) {', '  private func applyMoveTransforms'],
    ['func updateScale(at v1: CGPoint, and v2: CGPoint) {', '  private func drawScalePreview'],
    ['private func drawScalePreview(_ session: ScaleSession) {', '  private func tearDownScalePreview'],
    ['func updateHandleDrag(at viewPoint: CGPoint) {', '  /// Ends the drag.'],
  ]) assert.doesNotMatch(slice(swift, from, to), forbidden, from);
});
check('scale preview keeps ONE CAShapeLayer per selected stroke (no chunk churn) and hides — not rebuilds — the stored layers', () => {
  const preview = slice(swift, 'private func drawScalePreview(_ session: ScaleSession) {', 'private func tearDownScalePreview()');
  assert.match(preview, /scalePreviewLayers\[original\.id\] \?\? CAShapeLayer\(\)/);
  assert.match(preview, /savedInkLayers\[original\.id\]\?\.isHidden = true/);
  assert.doesNotMatch(preview, /PageInkStrokeLayer\(/);
  assert.match(preview, /layer\.lineWidth = CGFloat\(original\.width\)/, 'pen width unchanged in the preview');
});
check('ordinary handwriting hot paths are untouched by this phase (no selection code in append/begin/end of a stroke)', () => {
  for (const [from, to] of [
    ['func appendPoints(_ points: [CGPoint])', '  func applyShapeSnap'],
  ]) {
    if (swift.indexOf(from) < 0) continue;
    assert.doesNotMatch(slice(swift, from, to), /dispatch\(|SelectionMachine|scaleSession|fingerHitsSelection/);
  }
  const sampler = slice(nb, 'const handleNativePencilSampleWrapped', '   * The draw / erase gesture.');
  assert.doesNotMatch(sampler, /dispatchSelection|scaleSession|fingerManipulation|selectionMachine/);
});
console.log('\nselection-interaction-integration: all checks passed');
