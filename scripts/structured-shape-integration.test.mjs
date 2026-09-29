/**
 * Structured shapes across both workspaces (Shape System Phase 2): Course Material page-space
 * logic (move / duplicate / delete / handle edit / history undo-redo / persistence / export),
 * plus source-level contracts for the adapters and the performance gate.
 * Run: node --experimental-strip-types scripts/structured-shape-integration.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shapeToInkPoints, inkPointsMatchShape, shapeHandles } from '../lib/annotationShape.ts';
import { materialSelectionChange, materialSelectionMove, materialShapeEdit } from '../lib/materialSelection.ts';
import {
  EMPTY_MATERIAL_HISTORY, pushMaterialHistory, popMaterialHistoryUndo, popMaterialHistoryRedo,
  applyMaterialHistoryUndo, applyMaterialHistoryRedo,
} from '../lib/materialHistory.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const triShape = { origin: 'triangle', geometry: { kind: 'polygon', vertices: [{ x: 200, y: 500 }, { x: 300, y: 500 }, { x: 250, y: 600 }] } };
const circShape = { origin: 'circle', geometry: { kind: 'ellipse', center: { x: 400, y: 300 }, ax: { x: 40, y: 0 }, ay: { x: 0, y: 40 } } };
const mk = (id, shape) => ({ id, tool: 'pen', color: '#061B34', width: 3, points: shapeToInkPoints(shape), shape, coordSpace: 'pdfPage', createdAt: 't' });
const hand = { id: 'hand', tool: 'pen', color: '#061B34', width: 3, points: [{ x: 500, y: 100 }, { x: 520, y: 110 }], coordSpace: 'pdfPage', createdAt: 't' };
const page = () => [mk('tri', triShape), mk('circ', circShape), hand];
const sel = (...ids) => ({ pageNumber: 1, strokeIds: ids });

console.log('Course Material: move / duplicate / delete');
check('move translates points AND geometry together for a structured shape; handwriting untouched', () => {
  const change = materialSelectionMove(sel('tri', 'hand'), page(), 20, -10);
  const tri = change.afterStrokes.find((s) => s.id === 'tri');
  assert.deepEqual(tri.shape.geometry.vertices[1], { x: 320, y: 490 });
  assert.ok(inkPointsMatchShape(tri, 1e-6));
  assert.equal('shape' in change.afterStrokes.find((s) => s.id === 'hand'), false);
  assert.equal(change.afterStrokes.find((s) => s.id === 'circ'), change.beforeStrokes.find((s) => s.id === 'circ'), 'unselected keeps identity');
});
check('duplicate: NEW stable id, shifted geometry (+18,-18) with matching points; the original is unchanged', () => {
  const change = materialSelectionChange(sel('tri'), page(), 'duplicate', () => 'tri-copy', 'now');
  const copy = change.afterStrokes.find((s) => s.id === 'tri-copy');
  assert.ok(copy && copy.id !== 'tri');
  assert.deepEqual(copy.shape.geometry.vertices[0], { x: 218, y: 482 });
  assert.ok(inkPointsMatchShape(copy, 1e-6));
  assert.deepEqual(change.afterStrokes.find((s) => s.id === 'tri').shape, triShape);
});
check('delete removes the structured shape and nothing else', () => {
  const change = materialSelectionChange(sel('circ'), page(), 'delete', () => 'x', 'now');
  assert.deepEqual(change.afterStrokes.map((s) => s.id), ['tri', 'hand']);
});

console.log('\nCourse Material: handle edit + history (ONE action per manipulation)');
check('a handle drag edits only that vertex, regenerates points, and leaves other strokes identical', () => {
  const strokes = page();
  const change = materialShapeEdit(1, strokes, 'tri', 1, { x: 330, y: 520 });
  const tri = change.afterStrokes.find((s) => s.id === 'tri');
  assert.deepEqual(tri.shape.geometry.vertices, [{ x: 200, y: 500 }, { x: 330, y: 520 }, { x: 250, y: 600 }]);
  assert.ok(inkPointsMatchShape(tri, 1e-9));
  assert.notDeepEqual(tri.points, strokes[0].points);
  assert.equal(change.afterStrokes[1], strokes[1]);
  assert.equal(change.afterStrokes[2], strokes[2]);
});
check('circle -> ellipse edit keeps the anchored side and regenerates the outline', () => {
  const change = materialShapeEdit(1, page(), 'circ', 1, { x: 480, y: 300 });
  const circ = change.afterStrokes.find((s) => s.id === 'circ');
  assert.deepEqual(shapeHandles(circ.shape.geometry)[3], { x: 360, y: 300 });
  assert.deepEqual(shapeHandles(circ.shape.geometry)[1], { x: 480, y: 300 });
  const xs = circ.points.map((p) => p.x);
  assert.ok(Math.abs(Math.min(...xs) - 360) < 1e-9 && Math.abs(Math.max(...xs) - 480) < 1e-9, 'export outline spans the EDITED ellipse');
});
check('bad input is refused: missing stroke, ordinary ink, legacy viewport stroke, NaN target', () => {
  assert.equal(materialShapeEdit(1, page(), 'nope', 0, { x: 1, y: 1 }), null);
  assert.equal(materialShapeEdit(1, page(), 'hand', 0, { x: 1, y: 1 }), null);
  assert.equal(materialShapeEdit(1, [{ ...mk('v', triShape), coordSpace: 'viewport' }], 'v', 0, { x: 1, y: 1 }), null);
  assert.equal(materialShapeEdit(1, page(), 'tri', 0, { x: NaN, y: 1 }), null);
});
check('history: edit -> undo restores EXACT geometry; redo restores the edit; edit + move + undo x2 + redo x2', () => {
  let strokes = page();
  const original = JSON.parse(JSON.stringify(strokes));
  let history = EMPTY_MATERIAL_HISTORY;
  const edit = materialShapeEdit(1, strokes, 'tri', 2, { x: 260, y: 640 });
  history = pushMaterialHistory(history, { kind: 'shape-edit', pageNumber: 1, strokeId: 'tri', beforeStrokes: edit.beforeStrokes, afterStrokes: edit.afterStrokes });
  strokes = edit.afterStrokes;
  const afterEdit = JSON.parse(JSON.stringify(strokes));
  const move = materialSelectionMove(sel('tri'), strokes, 15, 15);
  history = pushMaterialHistory(history, { kind: 'selection-move', pageNumber: 1, strokeIds: ['tri'], beforeStrokes: move.beforeStrokes, afterStrokes: move.afterStrokes });
  strokes = move.afterStrokes;
  const afterMove = JSON.parse(JSON.stringify(strokes));
  assert.equal(history.undo.length, 2, 'one entry per manipulation, no per-sample entries');

  let popped = popMaterialHistoryUndo(history); history = popped.state;
  strokes = applyMaterialHistoryUndo(popped.action, strokes, []).strokes;
  assert.deepEqual(strokes, afterEdit, 'undo of the move restores the edited geometry exactly');
  popped = popMaterialHistoryUndo(history); history = popped.state;
  strokes = applyMaterialHistoryUndo(popped.action, strokes, []).strokes;
  assert.deepEqual(strokes, original, 'undo of the edit restores the ORIGINAL geometry exactly');
  popped = popMaterialHistoryRedo(history); history = popped.state;
  strokes = applyMaterialHistoryRedo(popped.action, strokes, []).strokes;
  assert.deepEqual(strokes, afterEdit, 'redo restores the edit');
  popped = popMaterialHistoryRedo(history); history = popped.state;
  strokes = applyMaterialHistoryRedo(popped.action, strokes, []).strokes;
  assert.deepEqual(strokes, afterMove, 'redo restores the move');
});

console.log('\nPersistence / eraser / export invariants');
check('persisted JSON round-trip (store, native serialize/parse) is lossless for edited and moved shapes', () => {
  const edited = materialShapeEdit(1, page(), 'circ', 1, { x: 480, y: 300 }).afterStrokes;
  assert.deepEqual(JSON.parse(JSON.stringify(edited)), edited);
});
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
check('shape survives every native<->store crossing (prop out, commit in, eraser replacePage in)', () => {
  assert.match(screen, /\.\.\.\(stroke\.shape \? \{ shape: stroke\.shape \} : \{\}\)/, 'prop out');
  assert.match(screen, /\.\.\.\(native\.shape \? \{ shape: native\.shape \} : \{\}\)/, 'commit + replacePage in (one shared toStoreStroke)');
  const swift = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
  assert.match(swift, /if let shape = stroke\.shape \{ payload\["shape"\] = shape\.json \}/, 'serializeStroke carries the shape (used by commit AND page replacement)');
  assert.match(swift, /a\.opacity == b\.opacity && a\.points == b\.points && a\.shape == b\.shape/, 'render identity includes the shape');
  assert.equal((swift.match(/AnnotationStroke\(/g) ?? []).length, 4, 'every construction site (parse, commit, move, scale) is shape-aware');
  assert.match(swift, /shape: stroke\.shape\.map \{ StrokeShape\(origin: \$0\.origin, geometry: \$0\.geometry\.scaled\(about: center, by: factor\)\) \}\)/, 'scale keeps the structured geometry');
  assert.match(swift, /shape: StrokeShape\.parse\(item\["shape"\]\)/);
  assert.match(swift, /shape: inProgressShape/);
  assert.match(swift, /geometry\.translated\(dx: dx, dy: dy\)/);
});
check('PDF export consumes the derived points of the CURRENT geometry (never a stale copy)', () => {
  const swiftModule = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift') + read('modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');
  assert.doesNotMatch(swiftModule, /stroke\["shape"\]/, 'export never reads the shape; it reads points, which always regenerate from the shape');
  const edited = materialShapeEdit(1, page(), 'tri', 1, { x: 330, y: 520 }).afterStrokes.find((s) => s.id === 'tri');
  assert.ok(edited.points.some((p) => Math.abs(p.x - 330) < 1e-9 && Math.abs(p.y - 520) < 1e-9), 'edited vertex is on the exported outline');
  assert.ok(!edited.points.some((p) => Math.abs(p.x - 300) < 1e-9 && Math.abs(p.y - 500) < 1e-9), 'old vertex is gone from the exported outline');
});

console.log('\nNotebook adapter contract');
const nb = read('components/NotebookCanvas.tsx');
const slice = (src, from, to) => {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `slice start marker missing: ${from.slice(0, 60)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `slice end marker missing: ${to.slice(0, 60)}`);
  return src.slice(start, end);
};
check('a snapped stroke is committed as a STRUCTURED shape; ordinary handwriting gets no shape', () => {
  const fire = slice(nb, 'const shapeHoldFire = useCallback', 'shapeHoldFireRef.current = shapeHoldFire');
  assert.match(fire, /shapeFromRecognition\(shape, points\)/);
  assert.match(fire, /freeze\(shapeToInkPoints\(structured\), structured\)/);
  const commit = slice(nb, 'const commitStroke = useCallback', 'const publishEraseSuppression');
  assert.match(commit, /\.\.\.\(snappedShape \? \{ shape: snappedShape \} : \{\}\)/);
  assert.match(commit, /getShape\(\)/);
});
check('move and duplicate go through translateInkStroke (geometry + points can never drift)', () => {
  assert.match(slice(nb, 'const commitMove = useCallback', 'const commitStroke = useCallback'), /translateInkStroke\(s, dx, dy\)/);
  assert.match(slice(nb, 'const duplicateSelected = useCallback', 'const pickImage = useCallback'), /translateInkStroke\(s, OFFSET, OFFSET\)/);
});
check('a handle drag: ONE history action on release; NO store write, history or selection state per sample', () => {
  const commitEdit = slice(nb, 'const commitShapeEdit = useCallback', 'const commitMove = useCallback');
  assert.equal((commitEdit.match(/recordHistory\(\)/g) ?? []).length, 1);
  assert.match(commitEdit, /strokeWithShape\(edit\.original/);
  const moveBranch = slice(nb, "selectActionRef.current === 'handle') {\n              updateShapeHandleEdit(point);", "} else if (selectActionRef.current === 'move') {\n              const start");
  const updater = slice(nb, 'const updateShapeHandleEdit = useCallback', 'Two FINGERS beginning on the selected content');
  assert.match(updater, /dragShapeHandle\(edit\.original\.shape\.geometry/);
  assert.match(updater, /shapeHandlesRef\.current\?\.update\(geometry\)/);
  assert.doesNotMatch(moveBranch + updater, /onStrokesChange|recordHistory|setSelectedIds|setEditingShapeId|setSelectionMoveOffset|setState|dispatchSelection/, 'per-sample work is the local preview only');
});
check('the live preview state lives in ShapeHandlesHost, not the canvas; the original is hidden only between begin and the store echo', () => {
  const host = slice(nb, 'const ShapeHandlesHost = memo', 'type CompletedStrokeLayerProps');
  assert.match(host, /useState<ShapeGeometry \| null>\(null\)/);
  assert.match(host, /SHAPE_HANDLE_RADIUS_PT \* unit/, 'handle size is defined in screen points');
  assert.equal((nb.match(/setEditingShapeId\(/g) ?? []).length, 2, 'hidden id set at begin, cleared at finish — never per sample');
  assert.match(nb, /shapeEditAwaitingRef\.current = edit\.original;[\s\S]{0,400}setTimeout\(/, 'store echo release with a fallback');
});
check('handle hit-test and tap-select tolerances are screen-point based (divided by the zoom)', () => {
  assert.match(nb, /SHAPE_HANDLE_HIT_PT \* unit/);
  assert.match(nb, /SHAPE_TAP_SELECT_PT \* unit/);
  assert.match(nb, /SHAPE_TAP_MAX_EXTENT_PT \* unit/);
});
check('Pencil handwriting hot path has ZERO structured-shape work (no shape code in the sample handler or ink append)', () => {
  const sampler = slice(nb, 'const handleNativePencilSampleWrapped', '   * The draw / erase gesture.');
  assert.doesNotMatch(sampler, /dragShapeHandle|hitTestStructuredStroke|shapeHandles/);
  const append = slice(nb, 'append(point: NotePoint) {', 'freeze(points');
  assert.doesNotMatch(append, /shapeRef|getShape|shapeFromRecognition|dragShapeHandle|hitTestStructured|isStructuredStroke/);
});

console.log('\nCourse Material adapter / native contract (performance gate)');
const swift = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
check('native handle drag: preview only — no event, no prop write, no file IO per sample; ONE onShapeEdited on release', () => {
  const update = slice(swift, '  func updateHandleDrag(at viewPoint: CGPoint)', '  /// Ends the drag.');
  assert.doesNotMatch(update, /onShapeEdited|onAnnotationsChanged|loadAnnotations|pagedStrokes\[|FileHandle|write\(|serialize/);
  // Two recognisers (Select's Pencil gesture, and the Pen/Highlighter Pencil gesture) each emit once per completed drag.
  assert.equal((swift.match(/onShapeEdited\(\[/g) ?? []).length, 2);
  assert.equal((swift.match(/if let edit = annotationOverlay\.finishHandleDrag\(at: end\) \{\s*onShapeEdited\(\[/g) ?? []).length, 2);
  assert.match(swift, /if let edit = annotationOverlay\.finishHandleDrag\(at: end\)/);
});
check('JS applies an edit as ONE explicit history action and bypasses the ink write gate', () => {
  const handler = slice(screen, 'const handleNativeShapeEdited = useCallback', '// Colour selection from the toolbar strip');
  assert.equal((handler.match(/pushMaterialHistory\(/g) ?? []).length, 1);
  assert.match(handler, /requestImmediateNativeAnnotations\(\)/);
  assert.match(handler, /kind: 'shape-edit'/);
  assert.match(screen, /action\.kind === 'selection-move' \|\| action\.kind === 'selection-scale' \|\| action\.kind === 'shape-edit'/, 'undo/redo of an edit is routed through the stroke store');
});
check('Shape Snap in Course Material still swaps geometry on the live layer and never touches props (PK4-C3 protections intact)', () => {
  const hold = slice(screen, 'const handleNativeShapeHold = useCallback', 'const handleNativePencilActivity');
  assert.match(hold, /shapeFromRecognition\(shape, points\)/);
  assert.match(hold, /applyShapeSnap\(event\.token, shapeToInkPoints\(structured\)/);
  assert.doesNotMatch(hold, /replaceMaterialPageAnnotationStrokes|setNativeHistory|nativeAnnotationsProp/);
});
console.log('\nstructured-shape-integration: all checks passed');
