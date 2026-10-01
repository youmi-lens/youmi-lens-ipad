import assert from 'node:assert/strict';
import { materialSelectionChange } from '../lib/materialSelection.ts';
import { applyMaterialHistoryRedo, applyMaterialHistoryUndo } from '../lib/materialHistory.ts';

const stroke = (id, coordSpace = 'pdfPage') => ({
  id, coordSpace, tool: 'highlighter', color: '#F5D246', width: 18, opacity: 0.34,
  points: [{ x: 100, y: 600 }, { x: 105, y: 595 }], createdAt: 'old',
});
const text = (id) => ({ id, text: 'Hello', x: 110, y: 610, width: 180, fontSize: 16, anchor: 'top-left', createdAt: 'old', updatedAt: 'old' });
const beforeStrokes = [stroke('a'), stroke('b'), stroke('legacy', 'viewport')];
const beforeTextAnnotations = [text('t'), text('other')];
const selection = { pageNumber: 2, strokeIds: ['a', 'legacy'] };
const otherPage = [stroke('different-page')];
let seq = 0;
const id = () => `copy-${++seq}`;

for (const operation of ['delete', 'duplicate']) {
  const change = materialSelectionChange(selection, beforeStrokes, operation, id, 'now');
  assert.ok(change);
  const action = { kind: 'selection-change', pageNumber: 2, ...change };
  assert.deepEqual(otherPage, [stroke('different-page')], 'another page is untouched');
  assert.ok(change.afterStrokes.some((item) => item.id === 'legacy'), 'legacy viewport stroke is untouched');
  assert.ok(change.afterStrokes.some((item) => item.id === 'b'), 'unselected ink survives');
  assert.equal('afterTextAnnotations' in change, false, 'selection action cannot mutate text');

  if (operation === 'delete') {
    assert.deepEqual(change.afterStrokes.map((item) => item.id), ['b', 'legacy']);
  } else {
    const copy = change.afterStrokes.at(-1);
    assert.deepEqual(copy.points, [{ x: 118, y: 582 }, { x: 123, y: 577 }]);
    assert.equal(copy.tool, 'highlighter');
    assert.equal(copy.opacity, 0.34);
    assert.equal(copy.coordSpace, 'pdfPage');
  }

  const undone = applyMaterialHistoryUndo(action, change.afterStrokes, beforeTextAnnotations);
  assert.deepEqual(undone.strokes, beforeStrokes, `${operation} Undo restores exact ink`);
  assert.deepEqual(undone.textAnnotations, beforeTextAnnotations, `${operation} Undo restores exact text`);
  assert.deepEqual(undone.removedStrokeIds, operation === 'duplicate' ? [change.afterStrokes.at(-1).id] : []);
  const redone = applyMaterialHistoryRedo(action, undone.strokes, undone.textAnnotations);
  assert.deepEqual(redone.strokes, change.afterStrokes);
  assert.deepEqual(redone.textAnnotations, beforeTextAnnotations);
  assert.deepEqual(redone.removedStrokeIds, operation === 'delete' ? ['a'] : []);
}

assert.equal(materialSelectionChange({ pageNumber: 2, strokeIds: ['missing'] }, beforeStrokes, 'delete', id, 'now'), null);
console.log('material-selection-history: delete, duplicate, legacy isolation, page isolation, Undo/Redo PASS');
