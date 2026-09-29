/**
 * PK4-C2B — selected-ink move (Notebook + Course Material) and the fixed
 * Undo/Redo capsule's glyph rendering.
 * Run: node --experimental-strip-types scripts/selection-move-and-history-ui.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { materialSelectionMove } from '../lib/materialSelection.ts';
import {
  applyMaterialHistoryRedo,
  applyMaterialHistoryUndo,
  popMaterialHistoryRedo,
  popMaterialHistoryUndo,
  pushMaterialHistory,
  EMPTY_MATERIAL_HISTORY,
} from '../lib/materialHistory.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };

const stroke = (id, x, y, coordSpace = 'pdfPage') => ({
  id, tool: 'pen', color: '#000', width: 2, coordSpace, createdAt: 't',
  points: [{ x, y }, { x: x + 5, y: y - 5 }],
});
const strokes = [stroke('a', 100, 600), stroke('b', 400, 400), stroke('legacy', 10, 10, 'viewport')];

console.log('Course Material move geometry');
check('selected pdfPage ink translates by the exact page-space delta; others keep identity', () => {
  const change = materialSelectionMove({ pageNumber: 1, strokeIds: ['a'] }, strokes, 20, -10);
  assert.deepEqual(change.afterStrokes[0].points, [{ x: 120, y: 590 }, { x: 125, y: 585 }]);
  assert.equal(change.afterStrokes[1], strokes[1]);
  assert.equal(change.afterStrokes[2], strokes[2]);
  assert.equal(change.beforeStrokes, strokes);
});
check('legacy viewport-space ink and empty/zero moves are never edited', () => {
  assert.equal(materialSelectionMove({ pageNumber: 1, strokeIds: ['legacy'] }, strokes, 5, 5), null);
  assert.equal(materialSelectionMove({ pageNumber: 1, strokeIds: ['a'] }, strokes, 0, 0), null);
  assert.equal(materialSelectionMove({ pageNumber: 1, strokeIds: [] }, strokes, 5, 5), null);
  assert.equal(materialSelectionMove({ pageNumber: 1, strokeIds: ['a'] }, strokes, NaN, 1), null);
});

console.log('\nMove history (one action, exact undo/redo, text untouched)');
check('undo restores exact original coordinates; redo re-applies exact moved coordinates', () => {
  const texts = [{ id: 't1', text: 'keep', x: 1, y: 2, width: 3, fontSize: 4, createdAt: 'x', updatedAt: 'x' }];
  const change = materialSelectionMove({ pageNumber: 1, strokeIds: ['a'] }, strokes, 20, -10);
  const action = { kind: 'selection-move', pageNumber: 1, strokeIds: ['a'], ...change };
  const history = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, action);
  assert.equal(history.undo.length, 1, 'one completed drag pushes exactly one action');
  const undone = popMaterialHistoryUndo(history);
  const undo = applyMaterialHistoryUndo(undone.action, change.afterStrokes, texts);
  assert.deepEqual(undo.strokes, strokes);
  assert.equal(undo.textAnnotations, texts, 'text is never touched by a move');
  assert.deepEqual(undo.removedStrokeIds, []);
  const redone = popMaterialHistoryRedo(undone.state);
  const redo = applyMaterialHistoryRedo(redone.action, undo.strokes, texts);
  assert.deepEqual(redo.strokes, change.afterStrokes);
  assert.equal(redo.textAnnotations, texts);
});

console.log('\nCourse Material wiring');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
const native = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
check('the screen pushes ONE history action per onSelectionMoved event and persists in page space', () => {
  const handler = screen.slice(screen.indexOf('const handleNativeSelectionMoved'), screen.indexOf('const handleNativeSelectionMoved') + 900);
  assert.equal((handler.match(/pushMaterialHistory\(/g) ?? []).length, 1);
  assert.match(handler, /kind: 'selection-move'/);
  assert.match(screen, /onSelectionMoved=\{handleNativeSelectionMoved\}/);
});
check('native emits onSelectionMoved only when a drag ENDS (never per sample), and only for a Pencil recognizer', () => {
  // Two recognisers (Pencil, finger) each emit exactly ONE event per completed drag, only from finishMove().
  assert.equal((native.match(/onSelectionMoved\(\[/g) ?? []).length, 2);
  assert.equal((native.match(/if let moved = annotationOverlay\.finishMove\(\) \{\s*onSelectionMoved\(\[/g) ?? []).length, 2);
  const ended = native.slice(native.indexOf('case .ended:', native.indexOf('handleSelectionGesture')));
  assert.ok(ended.indexOf('onSelectionMoved(') > 0 && ended.indexOf('onSelectionMoved(') < ended.indexOf('case .cancelled'));
  assert.match(native, /gesture\.allowedTouchTypes = \[NSNumber\(value: UITouch\.TouchType\.pencil\.rawValue\)\]/);
});
check('native move works in page space and clamps ink to its own page', () => {
  assert.match(native, /func beginMoveIfHit\(/);
  assert.match(native, /pdfView\.convert\(viewPoint, to: page\)/);
  assert.match(native, /box\.minX - bounds\.minX/);
  assert.match(native, /savedInkLayers\[id\]\?\.setAffineTransform\(CGAffineTransform\(translationX/);
});
check('Duplicate re-selects the copies so they stay movable', () => {
  assert.match(screen, /pdfRef\.current\?\.setSelection\(pageNumber, copyIds\)/);
});

console.log('\nNotebook move (existing product, verified)');
const notebook = read('components/NotebookCanvas.tsx');
check('Notebook begins a move only from a Pencil-down inside the selected bounds, previews live, commits once with one history record', () => {
  assert.match(notebook, /selectActionRef\.current = 'move'/);
  assert.match(notebook, /<G translateX=\{selectionMoveOffset\.x\} translateY=\{selectionMoveOffset\.y\}>/);
  const commit = notebook.slice(notebook.indexOf('const commitMove = useCallback'), notebook.indexOf('const commitStroke = useCallback'));
  assert.equal((commit.match(/recordHistory\(\)/g) ?? []).length, 1);
  // Points AND a structured shape's geometry move together (Shape System Phase 2).
  assert.match(commit, /translateInkStroke\(s, dx, dy\)/);
  const shapeLib = read('lib/annotationShape.ts');
  assert.match(shapeLib, /p\.x \+ dx, y: p\.y \+ dy/);
});

console.log('\nFixed Undo/Redo capsule glyphs');
const toolbar = read('components/SharedAnnotationToolbar.tsx');
check('every glyph in the shared toolbar renders inside an <Svg> (bare <Path> children draw nothing, leaving an empty capsule)', () => {
  const uses = [...toolbar.matchAll(/<SharedToolbarGlyphPaths\b/g)];
  assert.equal(uses.length, 1, 'only the ToolbarSvgGlyph wrapper may emit bare glyph paths');
  const wrapper = toolbar.slice(toolbar.indexOf('function ToolbarSvgGlyph'), toolbar.indexOf('const TOOL_DOCKS'));
  assert.match(wrapper, /<Svg[\s\S]*<SharedToolbarGlyphPaths/);
  assert.match(toolbar, /<ToolbarSvgGlyph name="undo"/);
  assert.match(toolbar, /<ToolbarSvgGlyph name="redo"/);
});

console.log('\nselection-move-and-history-ui: all checks passed');
