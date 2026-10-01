/**
 * Course Material unified action history (P2, STAGE 2) — pure logic tests.
 *
 * Covers lib/materialHistory.ts in isolation: one chronological undo/redo
 * stack over stroke-add / stroke-erase / text-create / text-delete /
 * text-edit / text-move, exactly matching the mixed-chronological test
 * matrix the workstream spec requires (draw A, create B, move B, draw C,
 * edit B, delete B — then Undo six times in exact reverse order, Redo six
 * times in exact forward order).
 */
import assert from 'node:assert/strict';
import {
  pushMaterialHistory,
  popMaterialHistoryUndo,
  popMaterialHistoryRedo,
  applyMaterialHistoryUndo,
  applyMaterialHistoryRedo,
  EMPTY_MATERIAL_HISTORY,
} from '../lib/materialHistory.ts';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const stroke = (id) => ({ id, tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }], coordSpace: 'pdfPage', createdAt: '2026-01-01T00:00:00.000Z' });
const text = (id, x, y, value = 'hello') => ({ id, text: value, x, y, width: 180, fontSize: 16, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

console.log('Stack mechanics: push/undo/redo, redo cleared by a new action');

check('push adds to undo and clears redo', () => {
  let h = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, { kind: 'stroke-add', pageNumber: 1, stroke: stroke('a') });
  assert.equal(h.undo.length, 1);
  assert.equal(h.redo.length, 0);
});

check('undo moves the action from undo to redo, in order', () => {
  let h = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, { kind: 'stroke-add', pageNumber: 1, stroke: stroke('a') });
  const popped = popMaterialHistoryUndo(h);
  assert.equal(popped.action.kind, 'stroke-add');
  assert.equal(popped.state.undo.length, 0);
  assert.equal(popped.state.redo.length, 1);
});

check('redo moves it back to undo', () => {
  let h = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, { kind: 'stroke-add', pageNumber: 1, stroke: stroke('a') });
  h = popMaterialHistoryUndo(h).state;
  const popped = popMaterialHistoryRedo(h);
  assert.equal(popped.state.undo.length, 1);
  assert.equal(popped.state.redo.length, 0);
});

check('undo on an empty stack returns null, never throws', () => {
  assert.equal(popMaterialHistoryUndo(EMPTY_MATERIAL_HISTORY), null);
  assert.equal(popMaterialHistoryRedo(EMPTY_MATERIAL_HISTORY), null);
});

check('a brand-new action after Undo clears the redo stack (branching, not a redo-preserving timeline)', () => {
  let h = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, { kind: 'stroke-add', pageNumber: 1, stroke: stroke('a') });
  h = popMaterialHistoryUndo(h).state;
  assert.equal(h.redo.length, 1);
  h = pushMaterialHistory(h, { kind: 'stroke-add', pageNumber: 1, stroke: stroke('b') });
  assert.equal(h.redo.length, 0, 'new action must invalidate the old redo branch');
  assert.equal(h.undo.length, 1);
});

console.log('\nExact required mixed-chronological matrix: A(stroke) → B(text create) → move B → C(stroke) → edit B → delete B');

let hist = EMPTY_MATERIAL_HISTORY;
let strokes = [];
let texts = [];

// 1. create stroke A
hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 1, stroke: stroke('A') });
strokes = [...strokes, stroke('A')];

// 2. create text B
const bCreated = text('B', 10, 10);
hist = pushMaterialHistory(hist, { kind: 'text-create', pageNumber: 1, annotation: bCreated });
texts = [...texts, bCreated];

// 3. move B
hist = pushMaterialHistory(hist, { kind: 'text-move', pageNumber: 1, annotationId: 'B', before: { x: 10, y: 10 }, after: { x: 50, y: 60 } });
texts = texts.map((t) => (t.id === 'B' ? { ...t, x: 50, y: 60 } : t));

// 4. create stroke C
hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 1, stroke: stroke('C') });
strokes = [...strokes, stroke('C')];

// 5. edit B
hist = pushMaterialHistory(hist, { kind: 'text-edit', pageNumber: 1, annotationId: 'B', before: 'hello', after: 'hello world' });
texts = texts.map((t) => (t.id === 'B' ? { ...t, text: 'hello world' } : t));

// 6. delete B
const bAtDelete = texts.find((t) => t.id === 'B');
hist = pushMaterialHistory(hist, { kind: 'text-delete', pageNumber: 1, annotation: bAtDelete });
texts = texts.filter((t) => t.id !== 'B');

check('after all six actions: undo stack has exactly 6 entries in push order, redo empty', () => {
  assert.equal(hist.undo.length, 6);
  assert.equal(hist.redo.length, 0);
  assert.deepEqual(hist.undo.map((a) => a.kind), ['stroke-add', 'text-create', 'text-move', 'stroke-add', 'text-edit', 'text-delete']);
});

check('current derived state matches the six actions applied forward (sanity baseline before undoing)', () => {
  assert.equal(strokes.length, 2);
  assert.equal(texts.length, 0, 'B was deleted');
});

console.log('\nUndo #1 (delete B): B restored, EDITED text ("hello world"), at its MOVED position');
{
  const popped = popMaterialHistoryUndo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryUndo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('B is back with the edited text and moved position, not the original', () => {
    const b = texts.find((t) => t.id === 'B');
    assert.ok(b, 'B must be restored');
    assert.equal(b.text, 'hello world');
    assert.equal(b.x, 50); assert.equal(b.y, 60);
  });
  check('no stroke ids were removed by this step (pure text restore)', () => {
    assert.deepEqual(result.removedStrokeIds, []);
  });
}

console.log('Undo #2 (edit B): B text reverts to "hello", position UNCHANGED (still moved)');
{
  const popped = popMaterialHistoryUndo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryUndo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('B text is the pre-edit value; position is untouched by this step', () => {
    const b = texts.find((t) => t.id === 'B');
    assert.equal(b.text, 'hello');
    assert.equal(b.x, 50); assert.equal(b.y, 60);
  });
}

console.log('Undo #3 (stroke C): C is gone, A and B untouched');
{
  const popped = popMaterialHistoryUndo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryUndo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('C removed, A remains', () => {
    assert.deepEqual(strokes.map((s) => s.id), ['A']);
  });
  check('this undo reports C\'s id as a removed stroke (native side-channel must be notified)', () => {
    assert.deepEqual(result.removedStrokeIds, ['C']);
  });
}

console.log('Undo #4 (move B): B position reverts to its ORIGINAL create-time coordinates');
{
  const popped = popMaterialHistoryUndo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryUndo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('B is back at (10, 10)', () => {
    const b = texts.find((t) => t.id === 'B');
    assert.equal(b.x, 10); assert.equal(b.y, 10);
  });
}

console.log('Undo #5 (create B): B disappears entirely');
{
  const popped = popMaterialHistoryUndo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryUndo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('no text annotations remain', () => {
    assert.equal(texts.length, 0);
  });
  check('a text removal never reports a removed STROKE id (pendingLocalStrokeIds is stroke-only)', () => {
    assert.deepEqual(result.removedStrokeIds, []);
  });
}

console.log('Undo #6 (stroke A): A is gone — back to the empty starting state');
{
  const popped = popMaterialHistoryUndo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryUndo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('no strokes, no text — fully back to start', () => {
    assert.equal(strokes.length, 0);
    assert.equal(texts.length, 0);
  });
  check('undo stack is now empty, redo stack has all 6', () => {
    assert.equal(hist.undo.length, 0);
    assert.equal(hist.redo.length, 6);
  });
}

console.log('\nRedo all six, in exact forward order, reproducing the exact same intermediate states');

console.log('Redo #1 (stroke A)');
{
  const popped = popMaterialHistoryRedo(hist);
  hist = popped.state;
  check('redo pops actions in forward (oldest-undone-first) order', () => {
    assert.equal(popped.action.kind, 'stroke-add');
    assert.equal(popped.action.stroke.id, 'A');
  });
  const result = applyMaterialHistoryRedo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  assert.deepEqual(strokes.map((s) => s.id), ['A']);
}

console.log('Redo #2 (create B)');
{
  const popped = popMaterialHistoryRedo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryRedo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('B reappears at its original create-time position with original text', () => {
    const b = texts.find((t) => t.id === 'B');
    assert.ok(b); assert.equal(b.x, 10); assert.equal(b.y, 10); assert.equal(b.text, 'hello');
  });
}

console.log('Redo #3 (move B)');
{
  const popped = popMaterialHistoryRedo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryRedo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('B is at the moved position (50, 60)', () => {
    const b = texts.find((t) => t.id === 'B');
    assert.equal(b.x, 50); assert.equal(b.y, 60);
  });
}

console.log('Redo #4 (stroke C)');
{
  const popped = popMaterialHistoryRedo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryRedo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('C is back', () => {
    assert.deepEqual(strokes.map((s) => s.id), ['A', 'C']);
  });
}

console.log('Redo #5 (edit B)');
{
  const popped = popMaterialHistoryRedo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryRedo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('B text is "hello world" again', () => {
    const b = texts.find((t) => t.id === 'B');
    assert.equal(b.text, 'hello world');
  });
}

console.log('Redo #6 (delete B)');
{
  const popped = popMaterialHistoryRedo(hist);
  hist = popped.state;
  const result = applyMaterialHistoryRedo(popped.action, strokes, texts);
  strokes = result.strokes; texts = result.textAnnotations;
  check('B is gone again, matching the original forward-applied end state exactly', () => {
    assert.equal(texts.length, 0);
    assert.deepEqual(strokes.map((s) => s.id), ['A', 'C']);
  });
  check('both stacks are back to fully-undo-able, nothing left to redo', () => {
    assert.equal(hist.undo.length, 6);
    assert.equal(hist.redo.length, 0);
  });
}

console.log('\nStroke-erase (multi-stroke eraser gesture) undo/redo — before/after snapshot semantics');

check('undoing an erase restores the exact BEFORE snapshot, independent of current array identity', () => {
  const before = [stroke('x'), stroke('y'), stroke('z')];
  const after = [stroke('y')]; // x and z were erased in one gesture
  const action = { kind: 'stroke-erase', pageNumber: 1, before, after };
  const result = applyMaterialHistoryUndo(action, after, []);
  assert.deepEqual(result.strokes.map((s) => s.id), ['x', 'y', 'z']);
  assert.deepEqual(result.removedStrokeIds, [], 'restoring erased strokes is never a removal');
});

check('redoing an erase reports EVERY id present in before but missing from after as removed (batches the whole gesture into one notification)', () => {
  const before = [stroke('x'), stroke('y'), stroke('z')];
  const after = [stroke('y')];
  const action = { kind: 'stroke-erase', pageNumber: 1, before, after };
  const result = applyMaterialHistoryRedo(action, before, []);
  assert.deepEqual(result.strokes.map((s) => s.id), ['y']);
  assert.deepEqual(result.removedStrokeIds.sort(), ['x', 'z']);
});

console.log('\nStroke-add removal side-channel (STAGE 1 contract, now expressed through the unified history)');

check('undoing a stroke-add reports exactly that one stroke id as removed', () => {
  const result = applyMaterialHistoryUndo({ kind: 'stroke-add', pageNumber: 1, stroke: stroke('solo') }, [stroke('solo')], []);
  assert.deepEqual(result.removedStrokeIds, ['solo']);
  assert.equal(result.strokes.length, 0);
});

check('redoing a stroke-add never touches removedStrokeIds (an add is not subject to pendingLocalStrokeIds)', () => {
  const result = applyMaterialHistoryRedo({ kind: 'stroke-add', pageNumber: 1, stroke: stroke('solo') }, [], []);
  assert.deepEqual(result.removedStrokeIds, []);
  assert.deepEqual(result.strokes.map((s) => s.id), ['solo']);
});

console.log(`\nmaterial-history: ${passed} checks passed`);
