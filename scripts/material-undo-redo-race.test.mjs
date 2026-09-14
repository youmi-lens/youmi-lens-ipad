/**
 * Course Material native Pencil Undo/Redo responsiveness (P1).
 *
 * Proven root cause (audit, not this fix): `pendingLocalStrokeIds` exists to
 * protect a just-drawn stroke from a stale `annotationsByPage` JS snapshot
 * (see material-annotation-stale-snapshot.test.mjs) — but JS-initiated Undo
 * has no channel to distinguish "this snapshot omits the stroke because it's
 * stale" from "this snapshot omits the stroke because the user just asked to
 * remove it." Tapping Undo immediately after finishing a stroke (before that
 * stroke's own round-trip echo lands) could be silently reverted by the same
 * protection that keeps rapid handwriting from flashing — the stroke stays
 * on screen until the original echo eventually catches up on its own.
 *
 * The fix adds a narrow, explicit side-channel — `markStrokeRemovalIntent`,
 * mirroring the native eraser path's own `pendingLocalStrokeIds.remove(id)`
 * (erase is native-initiated and can update the guard directly; Undo is
 * JS-initiated and needs an imperative call to do the same thing before its
 * snapshot arrives). This is a native Swift view with no XCTest target in
 * this repo, so — following the established convention (see
 * material-annotation-stale-snapshot.test.mjs, material-native-ink-performance.test.mjs) —
 * these are structural source-level guards on the actual shipped logic
 * across all four bridge layers, not a mock of it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const pdfAnnotationView = read('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const pdfAnnotationModule = read('../modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');
const nativePdfAnnotationViewTsx = read('../components/NativePdfAnnotationView.tsx');
const expoPdfAnnotationIndex = read('../modules/expo-pdf-annotation/index.ts');
const materialScreen = read('../app/lecture-material/[lectureId]/[materialId].tsx');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('Native side-channel: AnnotationOverlay.markStrokeRemovalIntent');

const annotationOverlayClassStart = pdfAnnotationView.indexOf('final class AnnotationOverlay: UIView {');
assert.ok(annotationOverlayClassStart > -1, 'AnnotationOverlay class must exist');
const overlayMethod = pdfAnnotationView.slice(
  pdfAnnotationView.indexOf('func markStrokeRemovalIntent(ids: [String]) {', annotationOverlayClassStart),
  pdfAnnotationView.indexOf('// MARK: - Loading committed strokes from JS', annotationOverlayClassStart),
);

check('exists on AnnotationOverlay and clears exactly the given ids from pendingLocalStrokeIds', () => {
  assert.ok(overlayMethod.length > 0, 'method body must be found before the loading section');
  assert.match(overlayMethod, /pendingLocalStrokeIds\.subtract\(ids\)/);
});

check('is a no-op guard for an empty list (does not touch the set at all)', () => {
  assert.match(overlayMethod, /guard !ids\.isEmpty else \{ return \}/);
});

check('never touches pagedStrokes or any drawn ink — purely a pending-set operation', () => {
  assert.doesNotMatch(overlayMethod, /pagedStrokes/);
});

console.log('\nUnrelated pending ids are NOT removed — only the ids explicitly passed');

check('subtract() is a set-difference, not a clear() — ids absent from the call stay pending', () => {
  assert.match(overlayMethod, /pendingLocalStrokeIds\.subtract\(ids\)/);
  assert.doesNotMatch(overlayMethod, /pendingLocalStrokeIds\.removeAll|pendingLocalStrokeIds = \[\]/);
});

console.log('\nOuter view passthrough: PdfAnnotationView.markStrokeRemovalIntent');

const outerMethodStart = pdfAnnotationView.indexOf(
  'func markStrokeRemovalIntent(ids: [String]) {',
  pdfAnnotationView.indexOf('public final class PdfAnnotationView: ExpoView {'),
);
assert.ok(outerMethodStart > -1 && outerMethodStart < annotationOverlayClassStart,
  'the outer PdfAnnotationView passthrough must be found before the AnnotationOverlay class starts');
const outerMethod = pdfAnnotationView.slice(outerMethodStart, outerMethodStart + 300);

check('dispatches onto the main queue and forwards to the overlay unchanged', () => {
  const body = outerMethod.slice(0, outerMethod.indexOf('\n  }\n') + 5);
  assert.match(body, /DispatchQueue\.main\.async/);
  assert.match(body, /self\?\.annotationOverlay\.markStrokeRemovalIntent\(ids: ids\)/);
});

console.log('\nBridge: Expo Module AsyncFunction registration');

check('markStrokeRemovalIntentAsync is registered and forwards to the view method', () => {
  assert.match(
    pdfAnnotationModule,
    /AsyncFunction\("markStrokeRemovalIntentAsync"\) \{ \(view: PdfAnnotationView, ids: \[String\]\) in\s*\n\s*view\.markStrokeRemovalIntent\(ids: ids\)/,
  );
});

console.log('\nJS imperative handle: NativePdfAnnotationViewRef.markStrokeRemovalIntent');

check('exposed on the ref type and calls the native async function, swallowing rejection like sibling methods', () => {
  assert.match(nativePdfAnnotationViewTsx, /markStrokeRemovalIntent: \(ids: string\[\]\) => void;/);
  const impl = nativePdfAnnotationViewTsx.slice(nativePdfAnnotationViewTsx.indexOf('markStrokeRemovalIntent(ids: string[]) {'));
  assert.match(impl, /nativeRef\.current\?\.markStrokeRemovalIntentAsync\?\.\(ids\)\.catch/);
});

check('the underlying native ref type declares markStrokeRemovalIntentAsync', () => {
  assert.match(expoPdfAnnotationIndex, /markStrokeRemovalIntentAsync\?: \(ids: string\[\]\) => Promise<void>;/);
});

console.log('\nSTAGE 2: undo/redo now run through the unified history (lib/materialHistory.ts),');
console.log('but the STAGE 1 contract is preserved — notify native BEFORE the store mutation,');
console.log('for BOTH directions, via one shared applyNativeHistoryStep helper.');

const applyStepFn = materialScreen.slice(
  materialScreen.indexOf('const applyNativeHistoryStep = useCallback('),
  materialScreen.indexOf('[replaceMaterialPageAnnotationStrokesForMaterial, saveTextAnnotations, selectedTextAnnotationId],'),
);

check('applyNativeHistoryStep notifies native of any removed stroke ids before either store call', () => {
  const notifyIdx = applyStepFn.indexOf('pdfRef.current?.markStrokeRemovalIntent(result.removedStrokeIds)');
  const strokeStoreIdx = applyStepFn.indexOf('replaceMaterialPageAnnotationStrokesForMaterial(mid, action.pageNumber, result.strokes');
  const textStoreIdx = applyStepFn.indexOf('saveTextAnnotations(action.pageNumber, result.textAnnotations)');
  assert.ok(notifyIdx > -1 && strokeStoreIdx > -1 && textStoreIdx > -1);
  assert.ok(notifyIdx < strokeStoreIdx, 'native must be told before the stroke snapshot that omits them is ever produced');
  assert.ok(notifyIdx < textStoreIdx, 'the notify call is unconditional and ordered first regardless of which store this step touches');
});

check('the notify call is gated on removedStrokeIds actually being non-empty (never an unconditional no-op call)', () => {
  assert.match(applyStepFn, /if \(result\.removedStrokeIds\.length > 0\) \{\s*\n\s*pdfRef\.current\?\.markStrokeRemovalIntent\(result\.removedStrokeIds\)/);
});

check('a stroke-kind action goes through the stroke store; every other kind goes through the text store — never both', () => {
  assert.match(applyStepFn, /if \(action\.kind === 'stroke-add' \|\| action\.kind === 'stroke-erase'\) \{/);
  const strokeBranch = applyStepFn.slice(applyStepFn.indexOf("if (action.kind === 'stroke-add'"), applyStepFn.indexOf('return;\n      }'));
  assert.doesNotMatch(strokeBranch, /saveTextAnnotations/);
});

console.log('\nUndo pops from the unified undo stack; Redo pops from the unified redo stack');

const undoFn = materialScreen.slice(
  materialScreen.indexOf('const undoNativeCurrentPage = useCallback('),
  materialScreen.indexOf('}, [annotationsForMaterialPage, applyNativeHistoryStep, nativeHistory, textAnnotationsForMaterialPage]);'),
);

check('undoNativeCurrentPage pops via popMaterialHistoryUndo and applies through applyMaterialHistoryUndo', () => {
  assert.match(undoFn, /const popped = popMaterialHistoryUndo\(nativeHistory\)/);
  assert.match(undoFn, /const result = applyMaterialHistoryUndo\(popped\.action, strokes, texts\)/);
  assert.match(undoFn, /applyNativeHistoryStep\(popped\.action, result\)/);
});

check('undo commits the new history state (moving the action to redo) via setNativeHistory', () => {
  assert.match(undoFn, /setNativeHistory\(popped\.state\)/);
});

const redoFnStart = materialScreen.indexOf('const redoNativeCurrentPage = useCallback(');
const redoFn = materialScreen.slice(redoFnStart, materialScreen.indexOf(
  '}, [annotationsForMaterialPage, applyNativeHistoryStep, nativeHistory, textAnnotationsForMaterialPage]);',
  redoFnStart,
));

check('redoNativeCurrentPage pops via popMaterialHistoryRedo and applies through applyMaterialHistoryRedo — same shared step helper as undo', () => {
  assert.match(redoFn, /const popped = popMaterialHistoryRedo\(nativeHistory\)/);
  assert.match(redoFn, /const result = applyMaterialHistoryRedo\(popped\.action, strokes, texts\)/);
  assert.match(redoFn, /applyNativeHistoryStep\(popped\.action, result\)/);
});

console.log('\ncanUndo/canRedo stay synchronized with the unified history stacks driving them');

check('toolbar wiring reads canUndo/canRedo directly off nativeHistory.undo/redo.length, no separate/stale flag', () => {
  assert.match(materialScreen, /canUndo=\{nativeHistory\.undo\.length > 0\}/);
  assert.match(materialScreen, /canRedo=\{nativeHistory\.redo\.length > 0\}/);
});

console.log(`\nmaterial-undo-redo-race: ${passed} checks passed`);
