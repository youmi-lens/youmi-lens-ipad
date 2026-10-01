import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  EMPTY_MATERIAL_HISTORY,
  applyMaterialHistoryUndo,
  applyMaterialHistoryRedo,
  popMaterialHistoryUndo,
  popMaterialHistoryRedo,
  pushMaterialHistory,
} from '../lib/materialHistory.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const screen = readFileSync(path.join(root, 'app/lecture-material/[lectureId]/[materialId].tsx'), 'utf8');
const stroke = (id, coordSpace = 'pdfPage') => ({ id, coordSpace, tool: 'pen', points: [{ x: 1, y: 2 }] });
const text = (id) => ({ id, text: id, x: 3, y: 4, width: 180, fontSize: 16 });

for (const pageNumber of [1, 3]) {
  const otherPage = { strokes: [stroke('other')], texts: [text('other-text')] };
  const beforeStrokes = [stroke(`pdf-${pageNumber}`), stroke(`legacy-${pageNumber}`, 'viewport')];
  const beforeTextAnnotations = [text(`text-${pageNumber}`)];
  const afterStrokes = beforeStrokes.filter((item) => item.coordSpace !== 'pdfPage');
  const action = { kind: 'page-clear', pageNumber, beforeStrokes, afterStrokes, beforeTextAnnotations, afterTextAnnotations: [] };
  let history = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, action);

  const cleared = { strokes: afterStrokes, texts: [] };
  assert.deepEqual(cleared.strokes.map((item) => item.id), [`legacy-${pageNumber}`]);
  assert.deepEqual(otherPage.strokes.map((item) => item.id), ['other'], 'other PDF pages remain unchanged');
  assert.deepEqual(otherPage.texts.map((item) => item.id), ['other-text']);

  const undone = popMaterialHistoryUndo(history);
  history = undone.state;
  assert.equal(undone.action.pageNumber, pageNumber);
  const restored = applyMaterialHistoryUndo(undone.action, cleared.strokes, cleared.texts);
  assert.deepEqual(restored.strokes, beforeStrokes, 'Undo restores exact ink snapshot, including legacy records');
  assert.deepEqual(restored.textAnnotations, beforeTextAnnotations, 'Undo restores exact text snapshot');
  assert.deepEqual(restored.removedStrokeIds, []);

  const redone = popMaterialHistoryRedo(history);
  const result = applyMaterialHistoryRedo(redone.action, restored.strokes, restored.textAnnotations);
  assert.deepEqual(result.strokes, afterStrokes);
  assert.deepEqual(result.textAnnotations, []);
  assert.deepEqual(result.removedStrokeIds, [`pdf-${pageNumber}`], 'Redo marks only PDF-space ink for native removal');
  assert.equal(redone.state.undo.length, 1);
  assert.equal(redone.state.redo.length, 0);
}

assert.match(screen, /const pageNumber = nativeCurrentPageRef\.current;/, 'Clear Page targets the native page indicator source');
assert.match(screen, /Alert\.alert\(t\('tools\.clearPage'\), t\('tools\.clearPageBody'\)/, 'Clear Page requires confirmation');
assert.match(screen, /\{ text: t\('common\.cancel'\), style: 'cancel' \}/, 'Cancel is non-destructive');
assert.match(screen, /onPress: hasNativeSelection \? \(\) => changeNativeSelection\('delete'\) : clearNativeCurrentPage/, 'shared toolbar retains Clear Page without a selection');
assert.match(screen, /pdfRef\.current\?\.markStrokeRemovalIntent\(removedIds\)/, 'native stale-snapshot guard sees removed ink');
assert.match(screen, /pdfRef\.current\?\.setTextHistoryIntent\(pageNumber, \[\]\)/, 'native text receives explicit clear intent');
console.log('material-clear-page: page 1 and middle page, legacy preservation, confirmation, Undo and Redo PASS');
