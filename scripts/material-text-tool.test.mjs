// Text is direct document content, not a manipulable canvas object.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const pdfAnnotationView = read('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const expoPdfAnnotationIndex = read('../modules/expo-pdf-annotation/index.ts');
const toolbar = read('../components/MaterialFloatingToolbar.tsx');
const materialScreen = read('../app/lecture-material/[lectureId]/[materialId].tsx');
const moduleSource = read('../modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('ok ' + name); };
check('Text mode remains a native tool', () => {
  assert.match(expoPdfAnnotationIndex, /\| 'text'/);
  assert.match(toolbar, /showTextTool = false/);
  assert.match(toolbar, /showTextTool \? renderToolButton\(TEXT_TOOL\)/);
});
check('only create/edit/delete actions survive the product simplification', () => {
  assert.match(expoPdfAnnotationIndex, /action: 'create' \| 'edit' \| 'delete'/);
  for (const source of [pdfAnnotationView, materialScreen, expoPdfAnnotationIndex, moduleSource]) {
    assert.doesNotMatch(source, /selectedTextAnnotationId|textDragGesture|liveResizedTextWidth|textDeleteButton/);
  }
  assert.doesNotMatch(pdfAnnotationView, /UIAlertAction\(title: "Move"|"action": "move"|"action": "resize"/);
  assert.doesNotMatch(materialScreen, /event.action === '(move|resize|select|deselect)'/);
});
check('no selection outline, resize handle, marquee or group state', () => {
  const textLayer = pdfAnnotationView.slice(pdfAnnotationView.indexOf('final class PageTextAnnotationLayer'), pdfAnnotationView.indexOf('final class AnnotationOverlay'));
  assert.doesNotMatch(textLayer, /CAShapeLayer|selectedId|handleSize|selection/);
  assert.doesNotMatch(materialScreen, /marquee|groupSelection|text-resize/);
});
check('tap gesture is finger-only and only admitted in Text mode', () => {
  const tap = pdfAnnotationView.slice(pdfAnnotationView.indexOf('private lazy var textTapGesture'), pdfAnnotationView.indexOf('private lazy var inlineTextEditor'));
  assert.match(tap, /UITouch.TouchType.direct.rawValue/);
  assert.match(pdfAnnotationView, /guard gestureRecognizer === textTapGesture else \{ return true \}/);
  assert.match(pdfAnnotationView, /return annotationMode == "text"/);
});
check('scroll/zoom retains original simultaneous recognition, without drag priority', () => {
  assert.match(pdfAnnotationView, /shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer\s*\) -> Bool \{ true \}/);
  assert.doesNotMatch(pdfAnnotationView, /textDragGesture/);
});
console.log('\nEraser gesture batching: one continuous erase drag = ONE stroke-erase history action, not one per stroke crossed');

const commitFn = materialScreen.slice(
  materialScreen.indexOf('const handleNativeAnnotationCommitted = useCallback('),
  materialScreen.indexOf('const handleNativeEraserGestureEnded = useCallback('),
);

check('replacePage captures its before snapshot and the native final payload in the same callback, before the async store update', () => {
  const replacePageBranch = commitFn.slice(commitFn.indexOf("if (event.action === 'replacePage')"), commitFn.indexOf('if (!event.stroke)'));
  assert.match(replacePageBranch, /const before = annotationsForMaterialPage\(mid, page\)/);
  assert.match(replacePageBranch, /const nextStrokes = event\.strokes\.map\(toStoreStroke\)/);
  assert.ok(replacePageBranch.indexOf('const before =') < replacePageBranch.indexOf('replaceMaterialPageAnnotationStrokesForMaterial'), 'history input is captured before the store mutates');
});

check('replacePage pushes exactly one stroke-erase action for the native gesture-final replacement', () => {
  const replacePageBranch = commitFn.slice(commitFn.indexOf("if (event.action === 'replacePage')"), commitFn.indexOf('if (!event.stroke)'));
  assert.match(replacePageBranch, /pushMaterialHistory\(h, \{\s*\n\s*kind: 'stroke-erase', pageNumber: page, before, after: nextStrokes,/);
});

check('a single drawn stroke still pushes exactly one stroke-add action (unchanged from STAGE 1 intent)', () => {
  const addBranch = commitFn.slice(commitFn.indexOf('if (!event.stroke) return;'));
  assert.match(addBranch, /pushMaterialHistory\(h, \{ kind: 'stroke-add', pageNumber: page, stroke \}\)/);
});

const eraserEndedFn = materialScreen.slice(
  materialScreen.indexOf('const handleNativeEraserGestureEnded = useCallback('),
  materialScreen.indexOf('const addPageStroke = useCallback('),
);

check('gesture-end no longer reads an asynchronously-updated store; it only restores temporary eraser state', () => {
  assert.doesNotMatch(eraserEndedFn, /annotationsForMaterialPage/);
  assert.doesNotMatch(eraserEndedFn, /pushMaterialHistory/);
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
