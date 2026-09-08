/**
 * Course Material spontaneous viewport jump — exact position + Pencil
 * gesture isolation.
 *
 * Proven root cause (read-only audit): handwriting near the last page grows
 * `appendedBlankPageCount`, which triggers `rebuildCompositeDocument` — a
 * full in-memory PDFDocument rebuild from the immutable source file plus
 * fresh trailing blank pages. The old code restored only the page NUMBER
 * (`goToPage(oldPage)`), which jumps to the top of that page and discards
 * whatever intra-page scroll offset the user had — visible as the reported
 * "平白无故往上跑一段，往下跑一段" while writing near the bottom of a page.
 *
 * The fix captures a PDF-space anchor (the page + point currently sitting
 * at the viewport's top-left corner) and the current scaleFactor BEFORE the
 * rebuild, then restores both via PDFKit's own `PDFDestination` API after
 * the composite document is rebuilt — this works because appending trailing
 * blank pages never changes the geometry of any earlier page (the source
 * PDF is reloaded byte-identical every time).
 *
 * Secondary defensive fix: while an Apple Pencil stroke is physically in
 * progress, every other gesture recognizer on PDFView is disabled so a
 * resting palm cannot drive an accidental pan/pinch mid-stroke, then
 * restored the instant the stroke ends/cancels/fails.
 *
 * Native Swift with no XCTest target in this repo — see
 * material-native-ink-performance.test.mjs for the established pattern.
 * These are structural source-level guards; actual on-device "no jump"
 * feel can only be judged on a real iPad.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift', import.meta.url), 'utf8');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const rebuild = source.slice(
  source.indexOf('  private func rebuildCompositeDocument('),
  source.indexOf('  private func applyInitialPageIfPossible('),
);
const handlePencilGesture = source.slice(
  source.indexOf('  @objc private func handlePencilGesture('),
  source.indexOf('  // MARK: - Notifications + KVO'),
);

console.log('Fix B — exact viewport anchor + scale survive the append-triggered PDF rebuild');

check('scale is captured before the rebuild reassigns pdfView.document', () => {
  const captureIdx = rebuild.indexOf('restoreScale = pdfView.scaleFactor');
  const reassignIdx = rebuild.indexOf('pdfView.document = freshSource');
  assert.ok(captureIdx > 0 && captureIdx < reassignIdx, 'capture must happen before the document is replaced');
});

check('the anchor is the PDF-space point at the viewport top-left, not just the page number', () => {
  assert.match(rebuild, /pdfView\.page\(for: \.zero, nearest: true\)/, 'reads whatever page is currently at the viewport origin');
  assert.match(rebuild, /pdfView\.convert\(\.zero, to: anchorPage\)/, 'converts that point into page-local coordinates, independent of scroll position');
  assert.match(rebuild, /restoreAnchor = \(currentDocument\.index\(for: anchorPage\), pdfView\.convert\(\.zero, to: anchorPage\)\)/);
});

check('restoration uses PDFDestination (exact point), not goToPage (page-level only)', () => {
  assert.match(rebuild, /pdfView\.go\(to: PDFDestination\(page: page, at: restoreAnchor\.point\)\)/);
  const restoreSection = rebuild.slice(rebuild.indexOf('guard preservingCurrentPage else { return }'));
  assert.match(restoreSection, /if let restoreScale \{ pdfView\.scaleFactor = restoreScale \}/, 'scale is restored');
  const scaleIdx = restoreSection.indexOf('if let restoreScale');
  const goToIdx = restoreSection.indexOf('pdfView.go(to: PDFDestination');
  assert.ok(scaleIdx < goToIdx, 'scale must be restored BEFORE navigating to the anchor, or the anchor point would land at the wrong on-screen position');
});

check('goToPage(oldPage) is retained only as a defensive fallback when the anchor page no longer exists', () => {
  const restoreSection = rebuild.slice(rebuild.indexOf('guard preservingCurrentPage else { return }'));
  assert.match(restoreSection, /\} else \{\s*\/\/ Defensive fallback only[\s\S]*goToPage\(oldPage, reason:/);
});

check('no hard-coded delay was introduced — restoration runs synchronously in the same call, like the goToPage it replaces', () => {
  assert.doesNotMatch(rebuild, /DispatchQueue\.main\.asyncAfter|Timer\.scheduledTimer/);
});

console.log('Fix C — active Pencil stroke gets exclusive interaction priority');

check('a dedicated helper toggles every non-Pencil recognizer, never the Pencil recognizer itself', () => {
  assert.match(source, /private func setNonPencilGesturesEnabled\(_ enabled: Bool\) \{/);
  const helperBody = source.slice(
    source.indexOf('private func setNonPencilGesturesEnabled('),
    source.indexOf('private func applyPdfGestureTouchPolicy('),
  );
  assert.match(helperBody, /where recognizer !== pencilGesture/);
  assert.match(helperBody, /recognizer\.isEnabled = enabled/);
});

check('Pencil .began disables other recognizers before any drawing/erasing begins', () => {
  const beganIdx = handlePencilGesture.indexOf('case .began:');
  const nextCaseIdx = handlePencilGesture.indexOf('case .changed:');
  const beganBody = handlePencilGesture.slice(beganIdx, nextCaseIdx);
  const disableIdx = beganBody.indexOf('setNonPencilGesturesEnabled(false)');
  assert.ok(disableIdx > 0, 'must disable in .began');
  assert.ok(disableIdx < beganBody.indexOf('let p = recognizer.location'), 'disabled before any per-mode handling runs');
});

check('both .ended and .cancelled/.failed restore normal finger pan/pinch immediately — no path leaves it stuck off', () => {
  const endedIdx = handlePencilGesture.indexOf('case .ended:');
  const cancelledIdx = handlePencilGesture.indexOf('case .cancelled, .failed:');
  const endedBody = handlePencilGesture.slice(endedIdx, cancelledIdx);
  assert.match(endedBody, /^\s*case \.ended:\s*\n\s*setNonPencilGesturesEnabled\(true\)/, '.ended restores unconditionally, before branching on tool mode');
  const defaultIdx = handlePencilGesture.indexOf('default:');
  const cancelledBody = handlePencilGesture.slice(cancelledIdx, defaultIdx);
  assert.match(cancelledBody, /^\s*case \.cancelled, \.failed:\s*\n\s*setNonPencilGesturesEnabled\(true\)/, '.cancelled/.failed also restores unconditionally');
});

check('this does not touch the existing persistent mode-level allowedTouchTypes restriction (finger pan while a tool is selected)', () => {
  assert.match(source, /scrollView\.panGestureRecognizer\.allowedTouchTypes = \[finger\]/, 'untouched — still the existing per-mode policy, orthogonal to the transient isEnabled toggle');
});

console.log(`\nmaterial-viewport-preservation: ${passed} checks passed`);
