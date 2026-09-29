/**
 * RC-1.3 — Course Material: selected content is MOVABLE CONTENT and may cross PDF pages (Notebook parity).
 *
 * Root cause (first branch that prevented it): the native overlay clamped every drag to the SOURCE page
 * (`updateMove`: dx/dy limited to that page's mediaBox), `finishMove` rebuilt strokes only inside
 * `pagedStrokes[selectionPageNumber]`, the event carried one page number + a page-space delta, and JS applied it with
 * `materialSelectionMove` on that ONE page bucket while history (`selection-move`) encoded one page. Notebook has no
 * per-page ownership at all (one continuous canvas; pages are y-bands), so its drag is a plain translation.
 *
 * Run: node --experimental-strip-types scripts/material-cross-page-selection.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import {
  inkPointsMatchShape, shapeHandles, shapeToInkPoints, transformInkStroke, translateInkStroke,
} from '../lib/annotationShape.ts';
import { materialSelectionMove, materialSelectionTransfer, materialShapeEdit } from '../lib/materialSelection.ts';
import { boundsOfPoints, selectionReferencePoint } from '../lib/selectionTransform.ts';
import {
  EMPTY_MATERIAL_HISTORY, applyMaterialHistoryRedo, applyMaterialHistoryUndo, popMaterialHistoryRedo,
  popMaterialHistoryUndo, pushMaterialHistory,
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

const word = (id, x0, y0) => ({
  id, tool: 'pen', color: '#061B34', width: 2.4, coordSpace: 'pdfPage', createdAt: 't',
  points: Array.from({ length: 6 }, (_, i) => ({ x: x0 + i * 4, y: y0 + (i % 2 === 0 ? 0 : 6) })),
});
const shape = (id, s) => ({ id, tool: 'pen', color: '#061B34', width: 3, coordSpace: 'pdfPage', createdAt: 't', points: shapeToInkPoints(s), shape: clone(s) });
const SHAPES = {
  quad: { origin: 'rectangle', geometry: { kind: 'polygon', vertices: [{ x: 330, y: 380 }, { x: 430, y: 380 }, { x: 430, y: 480 }, { x: 330, y: 480 }] } },
  triangle: { origin: 'triangle', geometry: { kind: 'polygon', vertices: [{ x: 200, y: 500 }, { x: 300, y: 500 }, { x: 250, y: 600 }] } },
  line: { origin: 'line', geometry: { kind: 'line', a: { x: 100, y: 150 }, b: { x: 220, y: 190 } } },
  ellipse: { origin: 'circle', geometry: { kind: 'ellipse', center: { x: 400, y: 300 }, ax: { x: 40, y: 0 }, ay: { x: 0, y: 40 } } },
};
const pageA = () => [
  word('h', 100, 700), word('e', 130, 700), word('l1', 160, 700), word('l2', 190, 700), word('o', 220, 700),
  ...Object.entries(SHAPES).map(([id, s]) => shape(id, s)),
  word('far', 500, 60),
  { ...word('legacy', 10, 10), coordSpace: 'viewport' },
];
const pageB = () => [word('p2-existing', 300, 300)];
// A same-orientation page transfer is a pure translation: 100 right, -1000 down the document.
const SHIFT = { a: 1, b: 0, c: 0, d: 1, tx: 100, ty: -1000 };
const ROT90 = { a: 0, b: 1, c: -1, d: 0, tx: 700, ty: -50 };
const sel = (...ids) => ({ pageNumber: 1, strokeIds: ids });
const ids = (strokes) => strokes.map((s) => s.id);

console.log('Pure transfer: ownership moves atomically, ids stable, geometry exact');
const GROUPS = {
  'ordinary ink stroke': ['h'],
  'handwritten word (Box/Lasso group of 5)': ['h', 'e', 'l1', 'l2', 'o'],
  'structured quadrilateral': ['quad'],
  'structured triangle': ['triangle'],
  'structured ellipse': ['ellipse'],
  'structured line': ['line'],
  'mixed ink + shapes group': ['h', 'e', 'quad', 'triangle'],
};
for (const [label, group] of Object.entries(GROUPS)) {
  check(`${label}: page 1 -> page 2, same ids, no ghost, no duplicate, unselected + legacy untouched`, () => {
    const from = pageA();
    const to = pageB();
    const t = materialSelectionTransfer(sel(...group), from, 2, to, SHIFT);
    assert.ok(t);
    assert.deepEqual(t.movedIds, from.filter((s) => group.includes(s.id)).map((s) => s.id), 'stable ids, original order');
    assert.equal(t.fromPage, 1);
    assert.equal(t.toPage, 2);
    for (const id of group) assert.ok(!ids(t.afterFromStrokes).includes(id), `${id}: no ghost on the source page`);
    assert.deepEqual(ids(t.afterToStrokes), ['p2-existing', ...group.filter((id) => ids(from).includes(id)).sort((a, b) => ids(from).indexOf(a) - ids(from).indexOf(b))]);
    const everything = [...t.afterFromStrokes, ...t.afterToStrokes];
    assert.equal(new Set(ids(everything)).size, everything.length, 'no duplicate ids');
    assert.equal(everything.length, from.length + to.length, 'nothing lost');
    assert.equal(t.afterFromStrokes.find((s) => s.id === 'far'), from.find((s) => s.id === 'far'), 'unselected keeps identity');
    assert.equal(t.afterFromStrokes.find((s) => s.id === 'legacy'), from.find((s) => s.id === 'legacy'), 'legacy viewport stroke untouched');
    assert.equal(t.afterToStrokes[0], to[0], 'existing destination ink untouched');
    assert.equal(t.beforeFromStrokes, from);
    assert.equal(t.beforeToStrokes, to);
  });
}
check('relative geometry of a multi-stroke group is preserved EXACTLY', () => {
  const from = pageA();
  const group = ['h', 'e', 'l1', 'l2', 'o'];
  const t = materialSelectionTransfer(sel(...group), from, 2, [], SHIFT);
  const moved = t.afterToStrokes;
  for (let i = 0; i < group.length; i += 1) {
    const original = from.find((s) => s.id === group[i]);
    moved[i].points.forEach((p, j) => {
      assert.equal(p.x - original.points[j].x, 100);
      assert.equal(p.y - original.points[j].y, -1000);
    });
    assert.equal(moved[i].width, original.width);
    assert.equal(moved[i].color, original.color);
  }
  const bBefore = boundsOfPoints(from.filter((s) => group.includes(s.id)).flatMap((s) => s.points));
  const bAfter = boundsOfPoints(moved.flatMap((s) => s.points));
  assert.equal(bAfter.maxX - bAfter.minX, bBefore.maxX - bBefore.minX);
  assert.equal(bAfter.maxY - bAfter.minY, bBefore.maxY - bBefore.minY);
});
check('structured shapes STAY structured: same origin/kind, handles preserved (3 / 4 / 2 / 4), points match geometry', () => {
  const counts = { quad: 4, triangle: 3, line: 2, ellipse: 4 };
  for (const [id, count] of Object.entries(counts)) {
    const t = materialSelectionTransfer(sel(id), pageA(), 2, [], SHIFT);
    const moved = t.afterToStrokes.find((s) => s.id === id);
    assert.equal(moved.shape.origin, SHAPES[id].origin);
    assert.equal(moved.shape.geometry.kind, SHAPES[id].geometry.kind);
    assert.equal(shapeHandles(moved.shape.geometry).length, count, `${id} handles`);
    assert.ok(inkPointsMatchShape(moved, 1e-9), `${id}: ink points regenerate from the transferred geometry`);
    const t0 = shapeHandles(SHAPES[id].geometry)[0];
    const m0 = shapeHandles(moved.shape.geometry)[0];
    assert.deepEqual({ x: m0.x - t0.x, y: m0.y - t0.y }, { x: 100, y: -1000 });
  }
});
check('a shape edited after the transfer still works on the destination page (handle edit = shared semantics)', () => {
  const t = materialSelectionTransfer(sel('quad'), pageA(), 2, pageB(), SHIFT);
  const edit = materialShapeEdit(2, t.afterToStrokes, 'quad', 1, { x: 600, y: -600 });
  const moved = edit.afterStrokes.find((s) => s.id === 'quad');
  assert.deepEqual(moved.shape.geometry.vertices[1], { x: 600, y: -600 });
  assert.ok(inkPointsMatchShape(moved, 1e-9));
  const again = materialSelectionMove({ pageNumber: 2, strokeIds: ['quad'] }, t.afterToStrokes, 5, -5);
  assert.ok(again, 'a subsequent body move on the destination page works');
});
check('a rotated destination page maps points AND ellipse axes through the exact linear part; the shape stays valid', () => {
  const t = materialSelectionTransfer(sel('ellipse', 'quad'), pageA(), 3, [], ROT90);
  const ell = t.afterToStrokes.find((s) => s.id === 'ellipse');
  assert.deepEqual(ell.shape.geometry.ax, { x: 0, y: 40 }, 'axis vector rotated by the linear part only (no translation)');
  assert.deepEqual(ell.shape.geometry.ay, { x: -40, y: 0 });
  const startHint = ell.points[0];
  const regenerated = shapeToInkPoints(ell.shape, startHint);
  regenerated.forEach((p, i) => {
    assert.ok(Math.abs(p.x - ell.points[i].x) < 1e-9 && Math.abs(p.y - ell.points[i].y) < 1e-9, 'geometry and ink agree after rotation');
  });
  const quad = t.afterToStrokes.find((s) => s.id === 'quad');
  assert.deepEqual(quad.shape.geometry.vertices[1], { x: 700 - 380, y: 430 - 50 });
  assert.deepEqual(transformInkStroke(pageA()[0], ROT90), t.afterToStrokes.find((s) => s.id === 'h') ?? transformInkStroke(pageA()[0], ROT90));
});
check('bad input is refused: same page, unknown ids, legacy-only, non-finite affine, bad destination', () => {
  assert.equal(materialSelectionTransfer(sel('h'), pageA(), 1, [], SHIFT), null);
  assert.equal(materialSelectionTransfer(sel('nope'), pageA(), 2, [], SHIFT), null);
  assert.equal(materialSelectionTransfer(sel('legacy'), pageA(), 2, [], SHIFT), null);
  assert.equal(materialSelectionTransfer(sel('h'), pageA(), 2, [], { ...SHIFT, tx: NaN }), null);
  assert.equal(materialSelectionTransfer(sel('h'), pageA(), 0, [], SHIFT), null);
  assert.equal(materialSelectionTransfer(sel('h'), pageA(), 2.5, [], SHIFT), null);
});
check('a stale destination that already holds a moved id cannot produce a duplicate', () => {
  const stale = [word('p2-existing', 1, 1), { ...word('h', 0, 0) }];
  const t = materialSelectionTransfer(sel('h'), pageA(), 2, stale, SHIFT);
  assert.deepEqual(ids(t.afterToStrokes), ['p2-existing', 'h']);
});
check('the same pure translation as the same-page move (no accidental scale/skew for same-orientation pages)', () => {
  const from = pageA();
  const viaTransfer = materialSelectionTransfer(sel('h', 'quad'), from, 2, [], SHIFT).afterToStrokes;
  const viaTranslate = from.filter((s) => ['h', 'quad'].includes(s.id)).map((s) => translateInkStroke(s, 100, -1000));
  assert.deepEqual(viaTransfer, viaTranslate);
});

console.log('\nHistory: ONE action encodes geometry AND page ownership');
check('transfer -> undo restores BOTH pages exactly -> redo restores both exactly; the group is re-selected where it lives', () => {
  const from = pageA();
  const to = pageB();
  const original = { from: clone(from), to: clone(to) };
  const t = materialSelectionTransfer(sel('h', 'e', 'l1', 'l2', 'o'), from, 2, to, SHIFT);
  const action = {
    kind: 'selection-transfer', pageNumber: 1, toPageNumber: 2, strokeIds: t.movedIds,
    beforeStrokes: t.beforeFromStrokes, afterStrokes: t.afterFromStrokes,
    beforeToStrokes: t.beforeToStrokes, afterToStrokes: t.afterToStrokes,
  };
  let history = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, action);
  assert.equal(history.undo.length, 1, 'one continuous cross-page drag = ONE history entry');
  const undone = applyMaterialHistoryUndo(popMaterialHistoryUndo(history).action, t.afterFromStrokes, []);
  assert.deepEqual(undone.strokes, original.from, 'undo: source page exactly as before');
  assert.deepEqual(undone.otherPages, [{ pageNumber: 2, strokes: original.to }], 'undo: destination page exactly as before (no ghost)');
  assert.deepEqual(undone.selection, { pageNumber: 1, strokeIds: t.movedIds });
  assert.deepEqual(undone.removedStrokeIds, []);
  history = popMaterialHistoryUndo(history).state;
  const redone = applyMaterialHistoryRedo(popMaterialHistoryRedo(history).action, undone.strokes, []);
  assert.deepEqual(redone.strokes, t.afterFromStrokes);
  assert.deepEqual(redone.otherPages, [{ pageNumber: 2, strokes: t.afterToStrokes }], 'redo: exact transferred geometry on page 2');
  assert.deepEqual(redone.selection, { pageNumber: 2, strokeIds: t.movedIds });
  const all = [...redone.strokes, ...redone.otherPages[0].strokes];
  assert.equal(new Set(ids(all)).size, all.length, 'no duplicate ids after redo');
});
check('transfer + later same-page move + undo x2 + redo x2 stays exact', () => {
  const from = pageA();
  const t = materialSelectionTransfer(sel('quad'), from, 2, [], SHIFT);
  let history = pushMaterialHistory(EMPTY_MATERIAL_HISTORY, {
    kind: 'selection-transfer', pageNumber: 1, toPageNumber: 2, strokeIds: ['quad'],
    beforeStrokes: t.beforeFromStrokes, afterStrokes: t.afterFromStrokes, beforeToStrokes: t.beforeToStrokes, afterToStrokes: t.afterToStrokes,
  });
  const move = materialSelectionMove({ pageNumber: 2, strokeIds: ['quad'] }, t.afterToStrokes, 7, 9);
  history = pushMaterialHistory(history, { kind: 'selection-move', pageNumber: 2, strokeIds: ['quad'], ...move });
  let p = popMaterialHistoryUndo(history); history = p.state;
  assert.deepEqual(applyMaterialHistoryUndo(p.action, move.afterStrokes, []).strokes, t.afterToStrokes);
  p = popMaterialHistoryUndo(history); history = p.state;
  assert.deepEqual(applyMaterialHistoryUndo(p.action, t.afterFromStrokes, []).strokes, from);
  p = popMaterialHistoryRedo(history); history = p.state;
  assert.deepEqual(applyMaterialHistoryRedo(p.action, from, []).otherPages[0].strokes, t.afterToStrokes);
  p = popMaterialHistoryRedo(history);
  assert.deepEqual(applyMaterialHistoryRedo(p.action, t.afterToStrokes, []).strokes, move.afterStrokes);
});

console.log('\nPersistence + export ownership (production store reducer, page-bucket model)');
const store = read('lib/store.tsx');
const reducerBody = slice(store, 'let mutated = false;\n      const claimedIds', 'return mutated ? next : prev;');
const reducerFn = stripTypeScriptTypes(
  `function replaceBucket(prev, materialId, normalizedPage, materialScopeLectureId, strokes, remainingIds, incomingById, now, makeMaterialAnnotationId) {\n${reducerBody}\nreturn mutated ? next : prev;\n}`,
);
const replaceBucketRaw = new Function(`${reducerFn}\nreturn replaceBucket;`)();
const replaceBucket = (prev, materialId, page, scopeLecture, strokes, now, makeId) =>
  replaceBucketRaw(prev, materialId, page, scopeLecture, strokes, new Set(strokes.map((s) => s.id)), new Map(strokes.map((s) => [s.id, s])), now, makeId);
const record = (page, strokes) => ({ id: `rec-${page}`, lectureId: 'L', materialId: 'M', pageNumber: page, strokes, createdAt: 'c', updatedAt: 'u' });
const applyReplace = (prev, page, strokes) => replaceBucket(prev, 'M', page, 'L', strokes, 'now', (l, m, p) => `rec-new-${p}`);
// NOTE (pre-existing, outside this phase): the production reducer re-appends a legacy `viewport` stroke that is
// passed back inside the page array (it is kept by the filter AND never "claimed"), so this persistence proof uses
// pdfPage-only pages, the only kind the native overlay ever shows or moves.
const pdfPageA = () => pageA().filter((stroke) => stroke.coordSpace === 'pdfPage');
check('persisting BOTH page buckets moves the annotation id between page records (no ghost, no duplicate, survives reload)', () => {
  const t = materialSelectionTransfer(sel('h', 'e', 'quad'), pdfPageA(), 2, pageB(), SHIFT);
  let records = [record(1, pdfPageA()), record(2, pageB())];
  records = applyReplace(records, 1, t.afterFromStrokes);
  records = applyReplace(records, 2, t.afterToStrokes);
  const p1 = records.find((r) => r.pageNumber === 1).strokes;
  const p2 = records.find((r) => r.pageNumber === 2).strokes;
  assert.deepEqual(ids(p1), ids(t.afterFromStrokes));
  assert.deepEqual(ids(p2), ['p2-existing', 'h', 'e', 'quad']);
  assert.ok(!ids(p1).some((id) => ['h', 'e', 'quad'].includes(id)), 'no source-page ghost after persistence');
  const persisted = JSON.parse(JSON.stringify(records)); // AsyncStorage round trip
  assert.deepEqual(persisted, records, 'what is persisted reloads identically');
  // Undo persists the exact previous buckets too.
  const undone = applyReplace(applyReplace(records, 1, t.beforeFromStrokes), 2, t.beforeToStrokes);
  // (The store re-appends restored ids at the END of a bucket — pre-existing behavior for every undo of an
  // erase/delete — so exact GEOMETRY and ownership are compared per id, independent of draw order.)
  const byId = (strokes) => [...strokes].sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(byId(undone.find((r) => r.pageNumber === 1).strokes), byId(pdfPageA()));
  assert.deepEqual(undone.find((r) => r.pageNumber === 2).strokes, pageB());
});
check('a transfer onto a page that has no record yet creates it (the destination bucket is authoritative)', () => {
  const t = materialSelectionTransfer(sel('ellipse'), pdfPageA(), 3, [], SHIFT);
  let records = [record(1, pdfPageA())];
  records = applyReplace(records, 1, t.afterFromStrokes);
  records = applyReplace(records, 3, t.afterToStrokes);
  assert.deepEqual(ids(records.find((r) => r.pageNumber === 3).strokes), ['ellipse']);
});
check('export reads the authoritative page buckets, so page ownership is the export ownership (protected exporter untouched)', () => {
  const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
  const grouping = slice(screen, 'const nativeAnnotationsByPage = useMemo', '`textAnnotationsForMaterialPage`');
  assert.match(grouping, /annotationsForMaterialPage\(material\.id, page\)/);
  assert.match(grouping, /grouped\[String\(page\)\] = native/);
  const exportCall = slice(screen, 'exportAnnotatedPdfAsync({', '});');
  assert.match(exportCall, /annotationsByPage: nativeAnnotationsByPage/);
  const exporter = read('modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');
  assert.match(exporter, /drawStrokes\(strokes\[String\(index \+ 1\)\] as\? \[\[String: Any\]\] \?\? \[\], context: context, pageHeight: bounds\.height\)/, 'the exporter draws page N from bucket N only');
});

console.log('\nShared semantic + source contracts');
const swift = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const notebook = read('components/NotebookCanvas.tsx');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
check('shared semantic: ONE reference point (center of the selection bounds after the drag) — TS and native agree', () => {
  assert.deepEqual(selectionReferencePoint({ minX: 100, minY: 700, maxX: 240, maxY: 706 }, 10, -20), { x: 180, y: 683 });
  assert.match(swift, /let reference = CGPoint\(x: bounds\.midX \+ dx, y: bounds\.midY \+ dy\)/);
  assert.match(swift, /page\(for: pdfView\.convert\(reference, from: source\), nearest: true\)/, 'gap / beyond-document releases resolve to the NEAREST page, never nothing');
});
check("Notebook (the reference) has no per-page movement prison: a move is a plain translation of the selection", () => {
  const commit = slice(notebook, 'const commitMove = useCallback', 'const commitStroke = useCallback');
  assert.match(commit, /translateInkStroke\(s, dx, dy\)/);
  assert.doesNotMatch(commit, /pageGeom|pageStride|PAGE_HEIGHT|clamp/i);
});
check('native: the live drag is NOT clamped to the source page; release resolves + clamps to the DESTINATION page; one event', () => {
  const update = slice(swift, 'func updateMove(at viewPoint: CGPoint) {', '  private func applyMoveTransforms');
  assert.doesNotMatch(update.replace(/\/\/.*$/gm, ''), /box\.minX|mediaBox|clamp/, 'no per-page clamp in the live drag (comments excluded)');
  const finish = slice(swift, 'func finishMove() -> MoveResult? {', 'private func commitTransfer(');
  assert.ok(finish.indexOf('moveOffset = .zero') < finish.indexOf('pagedStrokes[number] ='));
  assert.match(finish, /transferDestination\(from: number, dx: dx, dy: dy\)/);
  assert.match(finish, /clampedMove\(dx, dy, page: page\)/, 'same-page release keeps the accepted stay-on-page rule');
  const commit = slice(swift, 'private func commitTransfer(', '  func cancelMove() {');
  assert.match(commit, /landed\.width <= box\.width/, 'the released group stays fully on its destination page');
  assert.match(commit, /pagedStrokes\.removeValue\(forKey: number\)|pagedStrokes\[number\] = remaining/);
  assert.match(commit, /pagedStrokes\[destination\.number\] = \(pagedStrokes\[destination\.number\] \?\? \[\]\) \+ placed/);
  assert.doesNotMatch(commit, /onSelectionMoved|loadAnnotations|FileHandle/, 'no event/IO inside the commit; the recogniser emits ONE event');
});
check('perf contract: preview is layer-local; no JS event, prop, history or file write per drag sample', () => {
  const update = slice(swift, 'func updateMove(at viewPoint: CGPoint) {', '  private func applyMoveTransforms');
  assert.doesNotMatch(update, /onSelectionMoved|loadAnnotations|serializeStroke|FileHandle|annotationsByPage|setNeedsDisplay/);
  assert.equal((swift.match(/onSelectionMoved\(moved\.payload\)/g) ?? []).length, 2, 'Pencil + finger recogniser, once each per completed drag');
  assert.match(swift, /layer\.zPosition = 10_000/);
});
check('JS: a page-transfer event is ONE history action + both buckets + selection follows; a same-page event keeps the accepted path', () => {
  const handler = slice(screen, 'const handleNativeSelectionMoved = useCallback', 'const handleNativeSelectionScaled');
  assert.match(handler, /event\.toPageNumber && event\.toPageNumber !== event\.pageNumber && event\.transform\?\.length === 6/);
  assert.equal((handler.match(/pushMaterialHistory\(/g) ?? []).length, 2, 'one push per branch, exactly one action per event');
  assert.match(handler, /kind: 'selection-transfer'/);
  assert.match(handler, /kind: 'selection-move'/);
  assert.match(handler, /replaceMaterialPageAnnotationStrokesForMaterial\(mid, transfer\.fromPage, transfer\.afterFromStrokes/);
  assert.match(handler, /replaceMaterialPageAnnotationStrokesForMaterial\(mid, transfer\.toPage, transfer\.afterToStrokes/);
  assert.match(handler, /setNativeSelection\(\{ pageNumber: transfer\.toPage, strokeIds: transfer\.movedIds \}\)/);
  const apply = slice(screen, 'const applyNativeHistoryStep = useCallback', 'const undoNativeCurrentPage');
  assert.match(apply, /action\.kind === 'selection-transfer'/);
  assert.match(apply, /pdfRef\.current\?\.setSelection\(result\.selection\.pageNumber, result\.selection\.strokeIds\)/);
});
check('Text keeps its own accepted model: Box/Lasso still cannot select text (this phase never touches it)', () => {
  const finish = slice(swift, 'func finishSelection() -> (pageNumber: Int, strokeIds: [String])? {', '/// Box selection is corner-to-corner');
  assert.doesNotMatch(finish, /pagedTextAnnotations|TextAnnotation/);
});
check('RC-1.2 finger arbitration is preserved: scale -> handle -> move', () => {
  const fn = slice(swift, 'func beginFingerManipulation(at points: [CGPoint]) -> FingerManipulation {', '// MARK: Structured shape handle drag');
  assert.ok(fn.indexOf('beginScale(at:') < fn.indexOf('beginHandleDragIfHit(at:') && fn.indexOf('beginHandleDragIfHit(at:') < fn.indexOf('beginMoveIfHit(at:'));
});

console.log('\nmaterial-cross-page-selection: transfer semantics, history, persistence, export ownership, contracts PASS');
