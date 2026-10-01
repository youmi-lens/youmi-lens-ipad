/**
 * Course Material unified history — RETENTION fix (physical incident,
 * 2026-09-11 owner iPad test): Undo/Redo effectively only reached back
 * ~2 actions.
 *
 * Proven root cause (read-only audit, not assumed): the ONLY unconditional
 * `setNativeHistory` reset site was keyed to `[currentPage]`. Native's
 * `emitCurrentPage()` fires on ANY PDFKit page-boundary crossing —
 * including incidental ones from ordinary continuous scrolling while
 * writing near a page edge, not just deliberate navigation — so the
 * effect wiped the ENTIRE undo/redo stack far more often than the user
 * would ever notice a "page change." The push/pop mechanics themselves
 * (lib/materialHistory.ts) were already correct and exhaustively tested
 * (see material-history.test.mjs) — this was purely a lifetime bug.
 *
 * Fix: the reset now keys on the DOCUMENT identity (`material?.id`), not
 * the current page — history survives page navigation and only starts
 * fresh on a genuinely new editing session (this screen remounting for a
 * different material). Each history action already carries its own
 * `pageNumber` and undo/redo apply it there directly (proven unaffected
 * by this fix, since that logic was never the bug).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  EMPTY_MATERIAL_HISTORY,
  pushMaterialHistory,
  popMaterialHistoryUndo,
  popMaterialHistoryRedo,
  applyMaterialHistoryUndo,
  applyMaterialHistoryRedo,
} from '../lib/materialHistory.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const materialScreen = await read('../app/lecture-material/[lectureId]/[materialId].tsx');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const stroke = (id, page = 1) => ({ id, tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }], coordSpace: 'pdfPage', createdAt: '2026-01-01T00:00:00.000Z', _page: page });

console.log('Source-level proof the reset site is fixed');

check('the history-reset effect is keyed on material?.id (document identity), never on currentPage', () => {
  const idx = materialScreen.indexOf('Native-path unified history is scoped to the whole document');
  assert.ok(idx > -1, 'the fix\'s own explanatory comment must be present');
  const endMarker = materialScreen.indexOf('}, [material?.id]);', idx);
  const effectBlock = materialScreen.slice(idx, endMarker + '}, [material?.id]);'.length);
  assert.match(effectBlock, /setNativeHistory\(EMPTY_MATERIAL_HISTORY\);/);
  assert.match(effectBlock, /\}, \[material\?\.id\]\);/);
  assert.doesNotMatch(effectBlock, /\[currentPage\]/, 'must not still be keyed on the page — that was the exact bug');
});

check('no OTHER unconditional setNativeHistory(EMPTY_MATERIAL_HISTORY) reset exists anywhere else in the screen', () => {
  const resets = materialScreen.match(/setNativeHistory\(EMPTY_MATERIAL_HISTORY\)/g) ?? [];
  assert.equal(resets.length, 1, 'exactly one reset site (the document-identity one) — any more reintroduces a truncation bug');
});

check('handleNativeModeChange (Pen/Highlighter/Eraser/Text tool switching) never touches nativeHistory', () => {
  const fn = materialScreen.slice(
    materialScreen.indexOf('const handleNativeModeChange = useCallback('),
    materialScreen.indexOf('}, []);', materialScreen.indexOf('const handleNativeModeChange = useCallback(')),
  );
  assert.doesNotMatch(fn, /nativeHistory|setNativeHistory/);
});

check('the legacy (unrelated, out-of-scope) JS-overlay path keeps its own separate page-scoped redoStack reset, untouched', () => {
  assert.match(materialScreen, /\/\/ Legacy JS-overlay path keeps its existing, unrelated, page-scoped redo[\s\S]{0,80}useEffect\(\(\) => \{\s*\n\s*setRedoStack\(\[\]\);\s*\n\s*\}, \[currentPage\]\);/);
});

console.log('\nRequired scenario: 10 Pen strokes → Undo all → Redo all');

{
  let hist = EMPTY_MATERIAL_HISTORY;
  let strokes = [];
  const ids = Array.from({ length: 10 }, (_, i) => `pen-${i}`);
  for (const id of ids) {
    hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 1, stroke: stroke(id) });
    strokes = [...strokes, stroke(id)];
  }
  check('after 10 strokes, undo stack has all 10, in order', () => {
    assert.equal(hist.undo.length, 10);
    assert.deepEqual(hist.undo.map((a) => a.stroke.id), ids);
  });
  for (let i = 9; i >= 0; i -= 1) {
    const popped = popMaterialHistoryUndo(hist);
    hist = popped.state;
    const result = applyMaterialHistoryUndo(popped.action, strokes, []);
    strokes = result.strokes;
  }
  check('undoing all 10 leaves zero strokes and a full 10-entry redo stack', () => {
    assert.equal(strokes.length, 0);
    assert.equal(hist.undo.length, 0);
    assert.equal(hist.redo.length, 10);
  });
  for (let i = 0; i < 10; i += 1) {
    const popped = popMaterialHistoryRedo(hist);
    hist = popped.state;
    const result = applyMaterialHistoryRedo(popped.action, strokes, []);
    strokes = result.strokes;
  }
  check('redoing all 10 restores every stroke in original forward order', () => {
    assert.deepEqual(strokes.map((s) => s.id), ids);
    assert.equal(hist.undo.length, 10);
    assert.equal(hist.redo.length, 0);
  });
}

console.log('\nRequired scenario: 100 sequential actions retained, all undoable, all redoable');

{
  let hist = EMPTY_MATERIAL_HISTORY;
  let strokes = [];
  for (let i = 0; i < 100; i += 1) {
    hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: (i % 5) + 1, stroke: stroke(`s-${i}`) });
    strokes = [...strokes, stroke(`s-${i}`)];
  }
  check('history length is exactly 100 — no cap, no premature discard', () => {
    assert.equal(hist.undo.length, 100);
  });
  const undone = [];
  for (let i = 0; i < 100; i += 1) {
    const popped = popMaterialHistoryUndo(hist);
    hist = popped.state;
    undone.push(popped.action.stroke.id);
  }
  check('all 100 are undoable, popped in exact reverse order', () => {
    assert.deepEqual(undone, Array.from({ length: 100 }, (_, i) => `s-${99 - i}`));
    assert.equal(hist.undo.length, 0);
    assert.equal(hist.redo.length, 100);
  });
  const redone = [];
  for (let i = 0; i < 100; i += 1) {
    const popped = popMaterialHistoryRedo(hist);
    hist = popped.state;
    redone.push(popped.action.stroke.id);
  }
  check('all 100 are redoable, popped in exact forward order', () => {
    assert.deepEqual(redone, Array.from({ length: 100 }, (_, i) => `s-${i}`));
    assert.equal(hist.undo.length, 100);
    assert.equal(hist.redo.length, 0);
  });
}

console.log('\nRequired scenario: Pen → Undo → Redo → Highlighter → Undo → Undo reaches the OLDER Pen action');

{
  let hist = EMPTY_MATERIAL_HISTORY;
  const penStroke = { id: 'pen-A', tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }], coordSpace: 'pdfPage', createdAt: '2026-01-01T00:00:00.000Z' };
  const highlightStroke = { id: 'hl-C', tool: 'highlighter', color: '#FFE066', width: 18, points: [{ x: 5, y: 5 }], coordSpace: 'pdfPage', createdAt: '2026-01-01T00:00:01.000Z' };

  hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 1, stroke: penStroke }); // Pen
  let popped = popMaterialHistoryUndo(hist); hist = popped.state; // Undo
  popped = popMaterialHistoryRedo(hist); hist = popped.state; // Redo
  hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 1, stroke: highlightStroke }); // Highlighter

  check('after Pen→Undo→Redo→Highlighter, the undo stack holds BOTH actions, oldest first', () => {
    assert.equal(hist.undo.length, 2);
    assert.equal(hist.undo[0].stroke.id, 'pen-A');
    assert.equal(hist.undo[1].stroke.id, 'hl-C');
  });

  const first = popMaterialHistoryUndo(hist);
  hist = first.state;
  check('first Undo reaches the Highlighter action', () => {
    assert.equal(first.action.stroke.id, 'hl-C');
  });

  const second = popMaterialHistoryUndo(hist);
  hist = second.state;
  check('second Undo reaches the OLDER Pen action — this is exactly what the owner reported as broken', () => {
    assert.equal(second.action.stroke.id, 'pen-A');
  });

  check('both are now exhausted from undo; redo is ready to restore pen-A first (forward chronological order) then hl-C', () => {
    assert.equal(hist.undo.length, 0);
    assert.equal(hist.redo.length, 2);
    const redoFirst = popMaterialHistoryRedo(hist);
    assert.equal(redoFirst.action.stroke.id, 'pen-A', 'the OLDER action redoes first, matching forward chronology');
    const redoSecond = popMaterialHistoryRedo(redoFirst.state);
    assert.equal(redoSecond.action.stroke.id, 'hl-C');
  });
}

console.log('\nRequired scenario: a new action after Undo clears ONLY the redo stack — earlier undo history is untouched');

{
  let hist = EMPTY_MATERIAL_HISTORY;
  const a = { id: 'A', tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }], coordSpace: 'pdfPage', createdAt: 't' };
  const b = { id: 'B', tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }], coordSpace: 'pdfPage', createdAt: 't' };
  const c = { id: 'C', tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }], coordSpace: 'pdfPage', createdAt: 't' };

  hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 1, stroke: a }); // A
  hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 1, stroke: b }); // B
  const undoneB = popMaterialHistoryUndo(hist); hist = undoneB.state; // Undo B
  hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 1, stroke: c }); // create C

  check('undo = [A, C], redo = [] — matches the exact required example', () => {
    assert.deepEqual(hist.undo.map((x) => x.stroke.id), ['A', 'C']);
    assert.equal(hist.redo.length, 0);
  });

  const undoC = popMaterialHistoryUndo(hist); hist = undoC.state;
  check('Undo C works', () => {
    assert.equal(undoC.action.stroke.id, 'C');
  });
  const undoA = popMaterialHistoryUndo(hist); hist = undoA.state;
  check('Undo A also works — earlier history was never erased by the new action after Undo', () => {
    assert.equal(undoA.action.stroke.id, 'A');
  });
}

console.log('\nRequired scenario: mixed text/stroke exact chronology survives a page boundary (page 17 Pen A, page 18 Highlighter B)');

{
  let hist = EMPTY_MATERIAL_HISTORY;
  const a = { id: 'A', tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }], coordSpace: 'pdfPage', createdAt: 't' };
  const b = { id: 'B', tool: 'highlighter', color: '#FFE066', width: 18, points: [{ x: 0, y: 0 }], coordSpace: 'pdfPage', createdAt: 't' };
  hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 17, stroke: a });
  hist = pushMaterialHistory(hist, { kind: 'stroke-add', pageNumber: 18, stroke: b });

  check('both actions, from two different pages, coexist in one ordered history', () => {
    assert.equal(hist.undo.length, 2);
    assert.equal(hist.undo[0].pageNumber, 17);
    assert.equal(hist.undo[1].pageNumber, 18);
  });

  const undoB = popMaterialHistoryUndo(hist); hist = undoB.state;
  check('Undo #1 targets page 18\'s action, carrying its own pageNumber for the caller to apply correctly', () => {
    assert.equal(undoB.action.pageNumber, 18);
    assert.equal(undoB.action.stroke.id, 'B');
  });
  const undoA = popMaterialHistoryUndo(hist); hist = undoA.state;
  check('Undo #2 reaches back across the page boundary to page 17\'s action — this must never be discarded for belonging to "another page"', () => {
    assert.equal(undoA.action.pageNumber, 17);
    assert.equal(undoA.action.stroke.id, 'A');
  });
}

console.log('\nWiring: undo/redo apply against the ACTION\'S OWN page, not whatever page is currently on screen');

{
  const undoFn = materialScreen.slice(
    materialScreen.indexOf('const undoNativeCurrentPage = useCallback('),
    materialScreen.indexOf('}, [annotationsForMaterialPage, applyNativeHistoryStep, nativeHistory, textAnnotationsForMaterialPage]);'),
  );
  check('undoNativeCurrentPage reads strokes/text for popped.action.pageNumber, not the viewed page', () => {
    assert.match(undoFn, /annotationsForMaterialPage\(mid, popped\.action\.pageNumber\)/);
    assert.match(undoFn, /textAnnotationsForMaterialPage\(mid, popped\.action\.pageNumber\)/);
  });
}

check('applyNativeHistoryStep commits strokes/text keyed on action.pageNumber (already correct pre-fix — the bug was purely the reset lifetime)', () => {
  const fn = materialScreen.slice(
    materialScreen.indexOf('const applyNativeHistoryStep = useCallback('),
    materialScreen.indexOf('[replaceMaterialPageAnnotationStrokesForMaterial, saveTextAnnotations],'),
  );
  assert.match(fn, /replaceMaterialPageAnnotationStrokesForMaterial\(mid, action\.pageNumber, result\.strokes/);
  assert.match(fn, /saveTextAnnotations\(action\.pageNumber, result\.textAnnotations\)/);
});

console.log(`\nmaterial-history-retention: ${passed} checks passed`);
