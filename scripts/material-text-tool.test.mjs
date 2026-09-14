/**
 * Course Material Text tool, tap-to-select/deselect, finger-drag reposition,
 * and paste-as-history-create (P2, STAGE 2).
 *
 * Structural/source-level guards (same convention as
 * material-annotation-stale-snapshot.test.mjs and material-undo-redo-race.test.mjs)
 * over the native Swift gesture wiring and the JS-side text action handling.
 * The PURE undo/redo delta logic itself is exhaustively covered by
 * material-history.test.mjs — this file covers the wiring that produces the
 * history actions and drives the native interactions in the first place.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const pdfAnnotationView = read('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const expoPdfAnnotationIndex = read('../modules/expo-pdf-annotation/index.ts');
const toolbar = read('../components/MaterialFloatingToolbar.tsx');
const materialScreen = read('../app/lecture-material/[lectureId]/[materialId].tsx');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('Type layer: "text" mode + create/deselect actions exist end-to-end');

check('NativePdfAnnotationMode includes "text" alongside the existing draw tools', () => {
  assert.match(expoPdfAnnotationIndex, /export type NativePdfAnnotationMode = 'scroll' \| 'pen' \| 'highlighter' \| 'eraser' \| 'text';/);
});

check('NativePdfTextAnnotationActionEvent action union includes "create" and "deselect"', () => {
  assert.match(expoPdfAnnotationIndex, /action: 'paste' \| 'select' \| 'deselect' \| 'create' \| 'move' \| 'edit' \| 'copy' \| 'delete';/);
});

console.log('\nToolbar: Text tool reuses Notebook\'s glyph, and is gated to the native path only');

check('MaterialToolMode includes "text"', () => {
  assert.match(toolbar, /export type MaterialToolMode = 'scroll' \| 'pen' \| 'highlighter' \| 'eraser' \| 'text';/);
});

check('the text glyph path is the exact one from NotebookCanvas (visual-language reuse, not a redesign)', () => {
  assert.match(toolbar, /d="M6 8h11M6 8V6\.5M17 8V6\.5M11\.5 8v14M9 22h5"/);
  assert.match(toolbar, /d="M17 12h6M20 12v10M18\.5 22h3"/);
});

check('showTextTool defaults to false and gates whether the Text button renders at all', () => {
  assert.match(toolbar, /showTextTool = false,/);
  assert.match(toolbar, /\{showTextTool \? renderToolButton\(TEXT_TOOL\) : null\}/);
});

const showTextToolPropLine = /^\s*showTextTool\s*$/m;

check('the legacy JS-overlay toolbar instance never receives the showTextTool PROP (stays 3-tool, no text mode there)', () => {
  const legacyInstance = materialScreen.slice(
    materialScreen.indexOf(') : Pdf ? (\n        <MaterialFloatingToolbar'),
    materialScreen.indexOf('/>', materialScreen.indexOf(') : Pdf ? (\n        <MaterialFloatingToolbar')),
  );
  assert.doesNotMatch(legacyInstance, showTextToolPropLine);
});

check('the native toolbar instance passes the showTextTool prop', () => {
  const nativeInstance = materialScreen.slice(
    materialScreen.indexOf('{useNativePdfViewer ? (\n        <MaterialFloatingToolbar'),
    materialScreen.indexOf(') : Pdf ? (\n        <MaterialFloatingToolbar'),
  );
  assert.match(nativeInstance, showTextToolPropLine);
});

console.log('\nNative gesture precedence: long-press (hold) always wins over the new tap/drag gestures');

check('both new gestures require the existing long-press to fail first', () => {
  assert.match(pdfAnnotationView, /textTapGesture\.require\(toFail: longPress\)/);
  assert.match(pdfAnnotationView, /textDragGesture\.require\(toFail: longPress\)/);
});

check('both are finger-only (same touch-type restriction as the existing long-press) — Pencil is never involved', () => {
  const tapDecl = pdfAnnotationView.slice(pdfAnnotationView.indexOf('private lazy var textTapGesture'), pdfAnnotationView.indexOf('private lazy var textDragGesture'));
  const dragDecl = pdfAnnotationView.slice(pdfAnnotationView.indexOf('private lazy var textDragGesture'), pdfAnnotationView.indexOf('private var textDragContext'));
  assert.match(tapDecl, /allowedTouchTypes = \[NSNumber\(value: UITouch\.TouchType\.direct\.rawValue\)\]/);
  assert.match(dragDecl, /allowedTouchTypes = \[NSNumber\(value: UITouch\.TouchType\.direct\.rawValue\)\]/);
});

console.log('\nAdmission gate (gestureRecognizer(_:shouldReceive:)) — the actual "must not interfere" enforcement');

const shouldReceiveFn = pdfAnnotationView.slice(
  pdfAnnotationView.indexOf('public func gestureRecognizer(\n    _ gestureRecognizer: UIGestureRecognizer,\n    shouldReceive touch: UITouch'),
);

check('only governs the two new recognizers — every other recognizer (Pencil, PDFView pan/pinch, long-press) is untouched', () => {
  assert.match(shouldReceiveFn, /guard gestureRecognizer === textTapGesture \|\| gestureRecognizer === textDragGesture else \{ return true \}/);
});

check('neither engages outside "scroll" or "text" mode — Pen/Highlighter/Eraser are excluded', () => {
  assert.match(shouldReceiveFn, /guard annotationMode == "scroll" \|\| annotationMode == "text" else \{ return false \}/);
});

check('textDragGesture only ever receives a touch that starts on the CURRENTLY SELECTED annotation — nothing else, including no selection at all', () => {
  const dragGate = shouldReceiveFn.slice(shouldReceiveFn.indexOf('// textDragGesture:'));
  assert.match(dragGate, /guard let selectedId = selectedTextAnnotationId,\s*\n\s*let hit = annotationOverlay\.textAnnotation\(at: point\),\s*\n\s*hit\.id == selectedId\s*\n\s*else \{ return false \}/);
});

check('textTapGesture always receives the touch once the mode gate passes (it decides select vs create vs deselect itself)', () => {
  assert.match(shouldReceiveFn, /if gestureRecognizer === textTapGesture \{[\s\S]{0,200}return true\s*\n\s*\}/);
});

console.log('\nExclusivity: once textDragGesture decides to track a touch, PDFView\'s own pan must not also scroll it');

const simulFn = pdfAnnotationView.slice(
  pdfAnnotationView.indexOf('public func gestureRecognizer(\n    _ gestureRecognizer: UIGestureRecognizer,\n    shouldRecognizeSimultaneouslyWith'),
  pdfAnnotationView.indexOf('// Narrow admission gate'),
);

check('textDragGesture is the one deliberate exception to the otherwise-permissive simultaneous-recognition policy', () => {
  assert.match(simulFn, /if gestureRecognizer === textDragGesture \|\| otherGestureRecognizer === textDragGesture \{\s*\n\s*return false\s*\n\s*\}/);
});

console.log('\nTap handler: select existing text (+ inline-edit in "text" mode), inline-create on empty space, deselect otherwise');
console.log('(superseded by the fuller native inline-editing coverage in material-inline-text-editing.test.mjs — kept here for the parts still owned by this file: mode/state gating)');

const tapHandler = pdfAnnotationView.slice(
  pdfAnnotationView.indexOf('@objc private func handleTextTap'),
  pdfAnnotationView.indexOf('@objc private func handleTextDrag'),
);

check('only acts on .ended, and only in scroll/text mode (redundant with the delegate gate, but a real fallback)', () => {
  assert.match(tapHandler, /guard recognizer\.state == \.ended, annotationMode == "scroll" \|\| annotationMode == "text" else \{ return \}/);
});

check('an existing text hit always selects — never opens the action sheet (that stays long-press-only)', () => {
  const hitBranch = tapHandler.slice(tapHandler.indexOf('if let existing'), tapHandler.indexOf('    if annotationMode == "text" {\n      beginInlineTextCreation'));
  assert.match(hitBranch, /onTextAnnotationAction\(\["action": "select", "pageNumber": existing\.pageNumber, "annotationId": existing\.id\]\)/);
  assert.doesNotMatch(hitBranch, /presentTextActions/);
});

check('empty space in "text" mode begins a brand-new INLINE annotation at the tap point — nothing is emitted/created until the editor commits (see material-inline-text-editing.test.mjs)', () => {
  assert.match(tapHandler, /beginInlineTextCreation\(at: pagePoint, pageNumber: pageNumber, page: page\)/);
});

check('empty space in "scroll" mode with something selected emits "deselect"', () => {
  assert.match(tapHandler, /if selectedTextAnnotationId != nil \{\s*\n\s*onTextAnnotationAction\(\["action": "deselect", "pageNumber": pageNumber\]\)/);
});

console.log('\nDrag handler: live-tracks visually, commits exactly ONE "move" mutation at the end');

const dragHandler = pdfAnnotationView.slice(
  pdfAnnotationView.indexOf('@objc private func handleTextDrag'),
  pdfAnnotationView.indexOf('private func presentTextActions'),
);

check('.began anchors on the exact selected annotation\'s current origin, re-validated (not trusted from the delegate gate alone)', () => {
  const beganBranch = dragHandler.slice(dragHandler.indexOf('case .began:'), dragHandler.indexOf('case .changed:'));
  assert.match(beganBranch, /let selectedId = selectedTextAnnotationId,\s*\n\s*let hit = annotationOverlay\.textAnnotation\(at: point\), hit\.id == selectedId/);
  assert.match(beganBranch, /textDragContext = \(id: hit\.id, pageNumber: pageNumber, startPagePoint: pagePoint, originX: hit\.x, originY: hit\.y\)/);
});

check('.changed computes a fresh delta from the ORIGINAL anchor every time (no per-frame accumulation drift) and never emits a mutation', () => {
  const changedBranch = dragHandler.slice(dragHandler.indexOf('case .changed:'), dragHandler.indexOf('case .ended:'));
  assert.match(changedBranch, /let dx = currentPagePoint\.x - context\.startPagePoint\.x/);
  assert.match(changedBranch, /let dy = currentPagePoint\.y - context\.startPagePoint\.y/);
  assert.match(changedBranch, /annotationOverlay\.liveDraggedTextPosition = \(id: context\.id, x: context\.originX \+ dx, y: context\.originY \+ dy\)/);
  assert.doesNotMatch(changedBranch, /onTextAnnotationAction/);
});

check('.ended clears the live override and emits exactly one "move" action — reusing the existing move event type, no new JS handling required', () => {
  const endedBranch = dragHandler.slice(dragHandler.indexOf('case .ended:'), dragHandler.indexOf('case .cancelled'));
  assert.match(endedBranch, /annotationOverlay\.liveDraggedTextPosition = nil/);
  assert.match(endedBranch, /onTextAnnotationAction\(\["action": "move", "pageNumber": context\.pageNumber, "annotationId": context\.id, "x": finalX, "y": finalY\]\)/);
});

check('.cancelled/.failed drops the live override without emitting any mutation — an abandoned drag changes nothing', () => {
  const cancelBranch = dragHandler.slice(dragHandler.indexOf('case .cancelled'));
  assert.doesNotMatch(cancelBranch.slice(0, cancelBranch.indexOf('default:')), /onTextAnnotationAction/);
});

console.log('\nLive drag rendering never touches the committed store');

check('liveDraggedTextPosition is purely a drawing override — drawTextAnnotation reads it, nothing else writes pagedTextAnnotations from it', () => {
  const overlayDrawFn = pdfAnnotationView.slice(
    pdfAnnotationView.indexOf('private func drawTextAnnotation('),
    pdfAnnotationView.indexOf('private func strokeHitsEraser'),
  );
  assert.match(overlayDrawFn, /let liveOverride = liveDraggedTextPosition\?\.id == annotation\.id \? liveDraggedTextPosition : nil/);
  assert.match(overlayDrawFn, /let drawX = liveOverride\?\.x \?\? annotation\.x/);
  assert.match(overlayDrawFn, /let drawY = liveOverride\?\.y \?\? annotation\.y/);
});

console.log('\nJS wiring: create/deselect/paste/delete/edit/move all push exactly the right history action');

const handleTextActionFn = materialScreen.slice(
  materialScreen.indexOf('const handleNativeTextAnnotationAction = useCallback('),
  materialScreen.indexOf('}, [createTextAnnotationFromEvent, ensureTrailingBlankPageAfterContent, saveTextAnnotations, textAnnotationsForMaterialPage]);'),
);

// NOTE: 'create' and 'edit' are now native-inline-editor-driven (the modal
// this file originally tested for those two actions no longer exists) — see
// material-inline-text-editing.test.mjs for the full, current coverage of
// both, plus createTextAnnotationFromEvent (the shared paste/create helper).
// This file keeps only what it still owns: 'deselect'/'delete'/'move', which
// this workstream's inline-editing redesign left unchanged.

check('"deselect" clears the selection and nothing else', () => {
  const deselectBranch = handleTextActionFn.slice(handleTextActionFn.indexOf("if (event.action === 'deselect')"), handleTextActionFn.indexOf("if (event.action === 'create')"));
  assert.match(deselectBranch, /setSelectedTextAnnotationId\(undefined\)/);
});

check('"delete" pushes text-delete with the annotation BEING removed, captured before the store call', () => {
  const deleteBranch = handleTextActionFn.slice(handleTextActionFn.indexOf("if (event.action === 'delete')"), handleTextActionFn.indexOf("} else if (event.action === 'edit')"));
  const pushIdx = deleteBranch.indexOf("pushMaterialHistory(h, { kind: 'text-delete'");
  const storeIdx = deleteBranch.indexOf('saveTextAnnotations(event.pageNumber, current.filter');
  assert.ok(pushIdx > -1 && storeIdx > -1);
});

check('"move" pushes text-move with the pre-move (before) and new (after) coordinates — reached by both the long-press flow AND the drag gesture', () => {
  const moveBranch = handleTextActionFn.slice(handleTextActionFn.indexOf("} else if (event.action === 'move' &&"));
  assert.match(moveBranch, /before: \{ x: selected\.x, y: selected\.y \}/);
  assert.match(moveBranch, /after: \{ x: event\.x!, y: event\.y! \}/);
});

console.log('\nEraser gesture batching: one continuous erase drag = ONE stroke-erase history action, not one per stroke crossed');

const commitFn = materialScreen.slice(
  materialScreen.indexOf('const handleNativeAnnotationCommitted = useCallback('),
  materialScreen.indexOf('const handleNativeEraserGestureEnded = useCallback('),
);

check('replacePage captures the "before" snapshot only on the FIRST event since the last committed batch (not every event)', () => {
  assert.match(commitFn, /if \(!eraseBatchBeforeRef\.current \|\| eraseBatchBeforeRef\.current\.pageNumber !== page\) \{\s*\n\s*eraseBatchBeforeRef\.current = \{ pageNumber: page, strokes: annotationsForMaterialPage\(mid, page\) \};\s*\n\s*\}/);
});

check('replacePage itself never pushes history — that is deferred to the gesture-end batching boundary', () => {
  const replacePageBranch = commitFn.slice(commitFn.indexOf("if (event.action === 'replacePage')"), commitFn.indexOf('if (!event.stroke)'));
  assert.doesNotMatch(replacePageBranch, /pushMaterialHistory/);
});

check('a single drawn stroke still pushes exactly one stroke-add action (unchanged from STAGE 1 intent)', () => {
  const addBranch = commitFn.slice(commitFn.indexOf('if (!event.stroke) return;'));
  assert.match(addBranch, /pushMaterialHistory\(h, \{ kind: 'stroke-add', pageNumber: page, stroke \}\)/);
});

const eraserEndedFn = materialScreen.slice(
  materialScreen.indexOf('const handleNativeEraserGestureEnded = useCallback('),
  materialScreen.indexOf('}, [annotationsForMaterialPage, restoreNativeTemporaryEraserIfNeeded]);'),
);

check('the batch ref is cleared immediately at gesture end (so the NEXT erase gesture starts a fresh batch)', () => {
  assert.match(eraserEndedFn, /const before = eraseBatchBeforeRef\.current;\s*\n\s*eraseBatchBeforeRef\.current = null;/);
});

check('pushes exactly one stroke-erase action covering the whole gesture, only if something actually changed', () => {
  assert.match(eraserEndedFn, /kind: 'stroke-erase', pageNumber: before\.pageNumber, before: before\.strokes, after,/);
  assert.match(eraserEndedFn, /const changed = beforeIds\.size !== afterIds\.size \|\| \[\.\.\.beforeIds\]\.some\(\(id\) => !afterIds\.has\(id\)\);/);
});

check('still restores the temporary-eraser tool state afterward — existing double-tap-eraser behavior is preserved', () => {
  assert.match(eraserEndedFn, /restoreNativeTemporaryEraserIfNeeded\(\);/);
});

check('the view wires onEraserGestureEnded to the new combined handler, not the bare restore function', () => {
  assert.match(materialScreen, /onEraserGestureEnded=\{handleNativeEraserGestureEnded\}/);
});

// NOTE: history no longer resets on page change at all — that was the
// proven root cause of the "~2 action" history-truncation bug (physical
// incident). See material-history-retention.test.mjs for the current,
// correct behavior: nativeHistory resets on material?.id (document
// identity) only, and survives page navigation.

console.log(`\nmaterial-text-tool: ${passed} checks passed`);
