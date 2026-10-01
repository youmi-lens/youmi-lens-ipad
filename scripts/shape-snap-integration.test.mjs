/**
 * Shape Snap — integration contracts:
 *  - a snapped shape is ORDINARY ink (erase / select / move / duplicate / delete / undo / redo),
 *  - ONE shared recognizer and ONE set of hold constants (no per-platform re-implementation),
 *  - the PK4-C3 hot-path protections are not weakened (no prop delivery, redraw, file IO or
 *    blocking wait on the Pencil path).
 * Run: node --experimental-strip-types scripts/shape-snap-integration.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { recognizeShape } from '../lib/shapeSnap.ts';
import { shapeToPoints } from '../lib/annotationShape.ts';
import { SHAPE_SNAP_HOLD_MS, SHAPE_SNAP_HOLD_TOLERANCE_PT } from '../lib/shapeSnapHold.ts';
import { selectedInkIds } from '../lib/selectionSemantics.ts';
import { materialSelectionChange, materialSelectionMove } from '../lib/materialSelection.ts';
import { pushMaterialHistory, popMaterialHistoryUndo, popMaterialHistoryRedo, applyMaterialHistoryUndo, applyMaterialHistoryRedo, EMPTY_MATERIAL_HISTORY } from '../lib/materialHistory.ts';
import { strokeNearSweep } from '../lib/inkEraser.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };

// A rough rectangle, snapped, as it would be committed.
function roughRect() {
  const c = [[100, 100], [300, 104], [296, 220], [98, 216], [100, 100]];
  const pts = [];
  for (let i = 1; i < c.length; i += 1) {
    const [ax, ay] = c[i - 1], [bx, by] = c[i];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 3);
    for (let k = 0; k < n; k += 1) pts.push({ x: ax + ((bx - ax) * k) / n + ((k * 7) % 3) * 0.4, y: ay + ((by - ay) * k) / n + ((k * 5) % 3) * 0.4 });
  }
  pts.push({ x: 100, y: 100 });
  return pts;
}
const drawn = roughRect();
const shape = recognizeShape(drawn);
const snapped = shapeToPoints(shape, drawn);
const stroke = { id: 'snap-1', tool: 'pen', color: '#061B34', width: 2.4, coordSpace: 'pdfPage', createdAt: 't', points: snapped };
const other = { id: 'other', tool: 'pen', color: '#000', width: 2, coordSpace: 'pdfPage', createdAt: 't', points: [{ x: 500, y: 500 }, { x: 510, y: 505 }] };

console.log('Snapped shape = ordinary ink');
check('the fixture rectangle is recognized', () => assert.equal(shape?.type, 'rectangle'));
check('ERASER: a sweep across any snapped side hits it (dense points, no special overlay)', () => {
  assert.equal(strokeNearSweep(stroke, { x: 200, y: 90 }, { x: 200, y: 110 }, 12), true, 'top side');
  assert.equal(strokeNearSweep(stroke, { x: 90, y: 160 }, { x: 110, y: 160 }, 12), true, 'left side');
  assert.equal(strokeNearSweep(stroke, { x: 200, y: 150 }, { x: 205, y: 155 }, 12), false, 'interior is empty');
});
check('SELECTION: Freeform and Box select the snapped shape as ink', () => {
  const box = [{ x: 60, y: 60 }, { x: 340, y: 260 }];
  assert.deepEqual([...selectedInkIds([stroke, other], 'rect', box)], ['snap-1']);
  const lasso = [{ x: 60, y: 60 }, { x: 340, y: 70 }, { x: 350, y: 260 }, { x: 70, y: 250 }];
  assert.deepEqual([...selectedInkIds([stroke, other], 'lasso', lasso)], ['snap-1']);
});
check('MOVE / DUPLICATE / DELETE work exactly like other ink', () => {
  const sel = { pageNumber: 1, strokeIds: ['snap-1'] };
  const moved = materialSelectionMove(sel, [stroke, other], 20, -10);
  assert.equal(moved.afterStrokes[0].points.length, snapped.length);
  assert.equal(moved.afterStrokes[0].points[0].x, snapped[0].x + 20);
  assert.equal(moved.afterStrokes[1], other);
  let n = 0;
  const dup = materialSelectionChange(sel, [stroke, other], 'duplicate', () => `copy-${n++}`, 'now');
  assert.equal(dup.afterStrokes.length, 3);
  assert.equal(dup.afterStrokes[2].points.length, snapped.length);
  const del = materialSelectionChange(sel, [stroke, other], 'delete', () => 'x', 'now');
  assert.deepEqual(del.afterStrokes.map((s) => s.id), ['other']);
});
check('UNDO / REDO: one completed snapped shape is one normal stroke-add history action', () => {
  const history = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, { kind: 'stroke-add', pageNumber: 1, stroke });
  assert.equal(history.undo.length, 1);
  const undone = popMaterialHistoryUndo(history);
  const afterUndo = applyMaterialHistoryUndo(undone.action, [stroke, other], []);
  assert.deepEqual(afterUndo.strokes.map((s) => s.id), ['other']);
  const redone = popMaterialHistoryRedo(undone.state);
  const afterRedo = applyMaterialHistoryRedo(redone.action, afterUndo.strokes, []);
  assert.deepEqual(afterRedo.strokes.at(-1).points, snapped, 'redo restores the snapped geometry exactly');
});
check('PERSISTENCE: no new document model — models.ts gains no shape type, snapped points are plain {x,y}', () => {
  assert.doesNotMatch(read('lib/models.ts'), /shapeSnap|ShapeSnap/);
  assert.ok(snapped.every((p) => Object.keys(p).sort().join() === 'x,y'));
});

console.log('\nOne shared engine, one set of constants');
const swift = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
const canvas = read('components/NotebookCanvas.tsx');
check('both workspaces import the SAME recognizer and hold constants; native contains NO recognition logic', () => {
  for (const source of [canvas, screen]) {
    assert.match(source, /from '@\/lib\/shapeSnap'/);
    assert.match(source, /SHAPE_SNAP_HOLD_MS/);
  }
  assert.doesNotMatch(swift, /recognizeShape|minAreaBox|convexHull|ellipseFrame/);
  const native = read('modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');
  assert.match(native, /Prop\("shapeSnapHoldMs"\) \{ \(view: PdfAnnotationView, ms: Double\?\) in\s*view\.shapeSnapHoldMs = ms \?\? 650/);
  assert.equal(SHAPE_SNAP_HOLD_MS, 650, 'native default mirrors the shared semantic constant');
  assert.match(native, new RegExp(`view\\.shapeSnapTolerancePt = pt \\?\\? ${SHAPE_SNAP_HOLD_TOLERANCE_PT}`));
});

console.log('\nPK4-C3 hot-path protections stay intact');
check('Course Material: the hold handler never touches annotation props, the write gate or the store', () => {
  const handler = screen.slice(screen.indexOf('const handleNativeShapeHold'), screen.indexOf('const handleNativePencilActivity'));
  assert.match(handler, /recognizeShapeDetailed\(/);
  assert.match(handler, /applyShapeSnap\(event\.token/);
  assert.doesNotMatch(handler, /replaceMaterial|requestImmediate|setNativeAnnotationsProp|setNativeTextProp|nativeAnnotationsByPage|addAnnotationStroke|saveAnnotation/);
});
check('native: hold work is a single main-runloop Timer (no sleep / blocking / file IO), event only from the timer', () => {
  const region = swift.slice(swift.indexOf('// MARK: - Shape Snap hold tracking'), swift.indexOf('func endStroke()'));
  assert.match(region, /Timer\(timeInterval:/);
  assert.match(region, /RunLoop\.main\.add\(timer, forMode: \.common\)/);
  assert.doesNotMatch(region, /sleep|usleep|Thread\.|DispatchSemaphore|\.wait\(|Data\(contentsOf|\.write\(to|setNeedsDisplay|loadAnnotations/);
  assert.equal((swift.match(/onShapeHold\?\(strokeToken/g) ?? []).length, 1);
});
check('native: applying a snap swaps ONE live layer (one transaction) and commits nothing itself', () => {
  const start = swift.indexOf('func applyShapeSnap(token: Int, points: [CGPoint], shape: StrokeShape? = nil)');
  const fn = swift.slice(start, swift.indexOf('    return true\n  }', start));
  assert.equal((fn.match(/CATransaction\.begin\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(fn, /pagedStrokes|pendingLocalStrokeIds|emitStrokeCommitted|setNeedsDisplay/);
});
check('native: ordinary handwriting pays one distance compare per accepted sample, only when enabled', () => {
  assert.match(swift, /if shapeSnapEnabled \{ for point in accepted \{ noteHoldSample\(point, scale: pdfView\.scaleFactor\) \} \}/);
});
check('Notebook: hold tracking is refs + one self-re-arming timer, with no React state or re-render per Pencil sample', () => {
  const core = canvas.slice(canvas.indexOf('// ---- Shape Snap (draw-and-hold)'), canvas.indexOf('const endStroke = useCallback'));
  assert.match(core, /const \[shapeHold\] = useState\(\(\) => new ShapeHoldTracker\(\)\)/);
  assert.doesNotMatch(core, /\bset(?!Timeout)[A-Z]\w*\(/, 'no React state setter anywhere in the hold path');
  const sample = core.slice(core.indexOf('const noteShapeHoldSample'), core.indexOf('const noteShapeHoldSample') + 700);
  assert.doesNotMatch(sample, /\bset(?!Timeout)[A-Z]\w*\(/);
  // Phase 2: the snap freezes the live stroke with the STRUCTURED shape's clean points.
  assert.match(core, /activeInkRef\.current\?\.freeze\(shapeToInkPoints\(structured\), structured\)/);
});
check('Notebook: normal live path is unchanged until a hold is recognized (freeze is the only new host behavior)', () => {
  const host = canvas.slice(canvas.indexOf('const ActiveInkHost = memo('), canvas.indexOf('type CompletedStrokeLayerProps'));
  assert.match(host, /if \(frozenRef\.current\) return;\s*if \(!appendStrokePoint\(pointsRef\.current, point, MIN_POINT_DISTANCE\)\) return;/);
  assert.match(canvas, /clearShapeHold\(\);\s*activeTouchIdRef\.current = null;\s*(?:\/\/[^\n]*\s*)*endStylusScrollLock\(\{ grace: !fingerManipulationRef\.current \}\)/);
});
check('Shape Snap only arms for ink tools (pen/highlighter): never eraser, select, text or finger', () => {
  assert.match(canvas, /if \(!drawingRef\.current \|\| \(modeRef\.current !== 'write' && modeRef\.current !== 'highlight'\)\) return;/);
  assert.match(canvas, /beginShapeHold\(point\);/);
});

console.log('\nshape-snap-integration: all checks passed');
