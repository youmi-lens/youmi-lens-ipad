/**
 * P0 — annotated PDF export rendered every page vertically mirrored.
 *
 * Proven via an isolated executable reproduction (a standalone Swift binary,
 * compiled for iOS Simulator and run via `simctl spawn`, containing a
 * verbatim copy of PdfAnnotatedExporter): a fixture PDF with TOP/BOTTOM/LEFT/
 * RIGHT markers, exported through the unmodified exporter, came back with
 * TOP and BOTTOM swapped and every glyph upside-down — reproduced at
 * rotation 0 (the only rotation found on any real user material inspected;
 * no mixed/non-zero rotation exists in the affected data), and confirmed
 * fixed by wrapping only the page.draw(...) call with a compensating flip.
 *
 * Root cause: UIGraphicsPDFRenderer hands out a CGContext in the top-left-
 * origin, y-down (UIKit) coordinate convention. PDFPage.draw(with:to:) draws
 * assuming the standard PDF bottom-left-origin, y-up convention. Calling one
 * directly into the other with no compensation mirrors the base page
 * vertically. The fix flips the context to PDF's own convention for just
 * that one draw call, then restores it — so drawStrokes/drawText (already
 * authored for the context's native y-down convention) are unaffected.
 *
 * This is a source-level guard (Swift is not unit-importable from Node here;
 * the actual pixel-level reproduction lives in
 * modules/expo-pdf-annotation/ios/__tests__/pdf_export_orientation_fixture.swift,
 * run manually via Simulator — see that file's header for how to run it).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const source = read('../modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');
const exportFn = source.slice(
  source.indexOf('static func export(options: [String: Any]) throws -> String {'),
  source.indexOf('private static func drawStrokes'),
);

console.log('base-page draw is wrapped with a compensating vertical flip');
check('page.draw(with:to:) is preceded by translateBy(y: bounds.height) + scaleBy(y: -1), and followed by a restore', () => {
  const drawIdx = exportFn.indexOf('page.draw(with: .mediaBox, to: context)');
  assert.ok(drawIdx > -1, 'the base-page draw call must still exist');
  const before = exportFn.slice(0, drawIdx);
  const after = exportFn.slice(drawIdx);
  // The nearest preceding save/translate/scale (searching backwards from the
  // draw call, within the same `if let page` block) must be exactly this
  // flip — not e.g. a 180°-rotate, not a translate without a matching
  // negative y-scale, which would produce a different (still wrong) result.
  const saveIdx = before.lastIndexOf('context.saveGState()');
  const translateIdx = before.lastIndexOf('context.translateBy(x: 0, y: bounds.height)');
  const scaleIdx = before.lastIndexOf('context.scaleBy(x: 1, y: -1)');
  assert.ok(saveIdx > -1 && translateIdx > -1 && scaleIdx > -1, 'save/translate/scale must all be present before the draw call');
  assert.ok(saveIdx < translateIdx && translateIdx < scaleIdx && scaleIdx < drawIdx, 'must be in save -> translate -> scale -> draw order');
  assert.match(after, /context\.restoreGState\(\)/, 'must restore the flip after drawing the base page, so annotation drawing below is unaffected');
});
check('the base-page flip wraps ONLY the page.draw call — drawStrokes/drawText run after the restore, in the y-down context', () => {
  const restoreIdx = exportFn.indexOf('context.restoreGState()');
  const strokesCallIdx = exportFn.indexOf('drawStrokes(');
  assert.ok(restoreIdx > -1 && strokesCallIdx > -1);
  assert.ok(restoreIdx < strokesCallIdx, 'drawStrokes must run after the base-page flip is restored');
});
check('no other transform (rotation, horizontal flip, or a second unrelated translate) was introduced', () => {
  assert.doesNotMatch(exportFn, /context\.rotate\(/);
  // Exactly one translateBy and one scaleBy in the whole export function —
  // the one pair belonging to this fix, nothing stacked on top of it.
  const translateCount = (exportFn.match(/context\.translateBy\(/g) ?? []).length;
  const scaleCount = (exportFn.match(/context\.scaleBy\(/g) ?? []).length;
  assert.equal(translateCount, 1);
  assert.equal(scaleCount, 1);
});

console.log('unrelated behavior is untouched');
check('bounds/canvas sizing (mediaBox-based) is unchanged — this fix does not touch rotation/canvas-size handling', () => {
  assert.match(exportFn, /let bounds = page\?\.bounds\(for: \.mediaBox\) \?\? finalBounds/);
});
check('drawText converts the shared PDF-page box to UIKit y-down once', () => {
  const textFn = source.slice(source.indexOf('private static func drawText'), source.indexOf('}\n\nprivate func PdfExporterColor'));
  assert.match(textFn, /MaterialTextGeometry\.pageRect/);
  assert.match(textFn, /pageHeight - rect\.maxY/);
});

// Build 55: build 54 fixed only the base page and left strokes drawn raw into
// the y-down context, so every stroke exported vertically mirrored relative to
// the (now-correct) base page — physically observed on the PY105 homework.
// Strokes are captured in PDF page space (y-up); they must be flipped to
// pageHeight - y, the same convention drawText already uses. Proven by the
// rendered geometry fixture __tests__/pdf_export_annotation_orientation_fixture.swift.
console.log('strokes are y-flipped to match the base page (build 55)');
check('drawStrokes receives pageHeight and flips every point y to pageHeight - y', () => {
  const strokesFn = source.slice(source.indexOf('private static func drawStrokes'), source.indexOf('private static func drawText'));
  assert.match(strokesFn, /private static func drawStrokes\(_ strokes: \[\[String: Any\]\], context: CGContext, pageHeight: CGFloat\)/, 'drawStrokes must take pageHeight');
  assert.match(strokesFn, /context\.move\(to: CGPoint\(x: first\[0\], y: pageHeight - first\[1\]\)\)/, 'first point y must be flipped');
  assert.match(strokesFn, /context\.addLine\(to: CGPoint\(x: point\[0\], y: pageHeight - point\[1\]\)\)/, 'every subsequent point y must be flipped');
  assert.doesNotMatch(strokesFn, /y: first\[1\]\)/, 'the old raw (unflipped) first-point draw must be gone');
});
check('the exporter passes bounds.height into drawStrokes', () => {
  assert.match(exportFn, /drawStrokes\(strokes\[String\(index \+ 1\)\] as\? \[\[String: Any\]\] \?\? \[\], context: context, pageHeight: bounds\.height\)/);
});

console.log(`\npdf-export-orientation: ${passed} checks passed`);
