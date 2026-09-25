/**
 * Regression contract for the physical Course Material text failure.
 *
 * The physical trace proved that PDFKit can emit contentOffset/bounds KVO in
 * an in-progress layout state: the same page/PDF coordinate was converted to
 * a valid editor frame, then an impossible y=-75893 frame, then the valid
 * frame again. The text's persisted geometry and id never changed; applying
 * that intermediate conversion made the one live UITextView visibly jump.
 *
 * This pins the narrow fix: PDFKit KVO requests one next-main-runloop
 * reposition, rather than assigning a frame from the intermediate transform.
 * It is not a timer/debounce and leaves static AnnotationOverlay rendering,
 * persistence, Pencil, and eraser paths untouched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift', import.meta.url), 'utf8');
let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const coordinator = source.slice(
  source.indexOf('private func scheduleInlineTextEditorReposition()'),
  source.indexOf('private func repositionInlineTextEditor()'),
);
const kvo = source.slice(
  source.indexOf('public override func observeValue('),
  source.indexOf('// MARK: - Event helpers'),
);
const scale = source.slice(
  source.indexOf('private func handleAnnotationLayoutChange()'),
  source.indexOf('private func startObservingScroll()'),
);
const documentText = source.slice(
  source.indexOf('final class PageTextAnnotationLayer:'),
  source.indexOf('// MARK: - Stroke API'),
);

check('the coordinator is explicitly main-runloop coalesced, not timer/debounce based', () => {
  assert.match(source, /private var inlineEditorRepositionScheduled = false/);
  assert.match(coordinator, /DispatchQueue\.main\.async/);
  assert.doesNotMatch(coordinator, /DispatchQueue\.main\.asyncAfter|Timer\.|setTimeout|\.milliseconds/);
});

check('contentOffset/bounds KVO requests the coordinator instead of converting an intermediate PDFKit transform directly', () => {
  assert.match(kvo, /if inlineTextEditingContext != nil \{ scheduleInlineTextEditorReposition\(\) \}/);
  assert.doesNotMatch(kvo, /if inlineTextEditingContext != nil \{ repositionInlineTextEditor\(\) \}/);
});

check('PDFView scale/layout notifications use the same coordinator', () => {
  assert.match(scale, /if inlineTextEditingContext != nil \{ scheduleInlineTextEditorReposition\(\) \}/);
});

check('the final editor conversion still uses only the immutable PDF-page editing context', () => {
  const reposition = source.slice(
    source.indexOf('private func repositionInlineTextEditor()'),
    source.indexOf('private func commitInlineTextEditorIfNeeded()'),
  );
  assert.match(reposition, /CGPoint\(x: context\.originX, y: context\.originY\)/);
  assert.match(reposition, /pdfView\.convert\([^\n]+from: page\)/);
  assert.doesNotMatch(reposition, /contentOffset|liveDraggedTextPosition/);
});

check('static committed text is hosted by the PDF document, not drawn into the fixed viewport overlay', () => {
  assert.match(documentText, /final class PageTextAnnotationLayer: CALayer/);
  assert.match(documentText, /guard let pdfView, let host = pdfView\.documentView/);
  assert.match(documentText, /host\.layer\.addSublayer\(layer\)/);
  assert.match(documentText, /private func syncPageText\(\)/);
  assert.match(documentText, /syncPageText\(\)/);
  assert.doesNotMatch(source, /private func drawTextAnnotation\(/);
});

check('text and Pencil share the authoritative PDF-page -> document-view transform path', () => {
  const ink = source.slice(source.indexOf('private func pageInkLayer('), source.indexOf('private func syncPageInk()'));
  const text = source.slice(source.indexOf('private func pageTextLayer('), source.indexOf('private func syncPageText()'));
  for (const path of [ink, text]) {
    assert.match(path, /host\.convert\(pdfView\.convert\((p|point), from: page\), from: pdfView\)/);
    assert.match(path, /layer\.setAffineTransform/);
  }
});

console.log(`material-text-coordinate-stability: ${passed} checks passed`);
