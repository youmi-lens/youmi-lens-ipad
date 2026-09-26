// Source wiring guards; actual PDFKit conversions run in material-text-native-geometry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const source = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const geometry = read('modules/expo-pdf-annotation/ios/MaterialTextGeometry.swift');
const exporter = read('modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('ok ' + name); };
check('one shared page rectangle serves editor/static/hit/export', () => {
  assert.equal((source.match(/MaterialTextGeometry\.pageRect\(/g) ?? []).length, 2);
  assert.match(source, /PageTextAnnotationLayer\.annotationFrame\(annotation\)/);
  assert.match(exporter, /MaterialTextGeometry\.pageRect\(/);
});
check('new top-left and historical bottom-left semantics explicitly differ', () => {
  assert.match(geometry, /anchor == "top-left" \? y - Double\(height\) : y/);
  assert.match(source, /anchor: item\["anchor"\] as\? String == "top-left" \? "top-left" : nil/);
  assert.match(screen, /text, x, y, width, fontSize, anchor,/);
});
check('editor uses PDFKit affine basis, including rotated pages, never offsets', () => {
  assert.match(geometry, /container\.convert\(pdfView\.convert\(point, from: page\), from: pdfView\)/);
  assert.match(source, /MaterialTextGeometry\.editorPlacement/);
  assert.match(source, /inlineTextEditor\.transform = placement\.transform/);
  assert.doesNotMatch(geometry, /contentOffset|safeArea|device|UIScreen/);
});
check('static text stays document-hosted with one glyph counter-reflection', () => {
  assert.match(source, /host\.layer\.addSublayer\(layer\)/);
  assert.match(source, /text\.setAffineTransform\(CGAffineTransform\(scaleX: 1, y: -1\)\)/);
  assert.doesNotMatch(source, /private func drawTextAnnotation/);
});
check('text and Pencil share unchanged PDFKit page basis', () => {
  for (const name of ['pageInkLayer', 'pageTextLayer']) {
    const start = source.indexOf('private func ' + name);
    const body = source.slice(start, source.indexOf('private func syncPage', start));
    assert.match(body, /host\.convert\(pdfView\.convert\((p|point), from: page\), from: pdfView\)/);
    assert.match(body, /layer\.setAffineTransform/);
  }
});
check('KVO coalesces only the transient editor, not a timer', () => {
  assert.match(source, /if inlineTextEditingContext != nil \{ scheduleInlineTextEditorReposition\(\) \}/);
  const body = source.slice(source.indexOf('private func scheduleInlineTextEditorReposition'), source.indexOf('private func repositionInlineTextEditor'));
  assert.match(body, /DispatchQueue\.main\.async/);
  assert.doesNotMatch(body, /Timer|asyncAfter/);
});
check('export converts the shared page box to UIKit once', () => assert.match(exporter, /y: pageHeight - rect\.maxY/));
check('selection and manipulation rendering are absent', () => assert.doesNotMatch(source, /selectedTextAnnotationId|liveDraggedTextPosition|liveResizedTextWidth|isTextResizeHandle|textDragGesture|textDeleteButton/));
console.log('material-text-coordinate-stability: ' + passed + ' checks passed');
