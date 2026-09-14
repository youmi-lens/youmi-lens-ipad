/**
 * Course Material continuation blank page — "too short to write on"
 * physical incident (owner iPad test, page 17→18 continuation).
 *
 * Proven root cause (read-only audit): the synthetic blank `PDFPage()`
 * appended in `rebuildCompositeDocument` only ever set `.mediaBox`.
 * `PDFView.displayBox` (which decides what box continuous-mode layout and
 * rendering actually measure each page by) is never overridden anywhere in
 * this codebase, so it stays at PDFKit's own default, `.cropBox`. A bare,
 * programmatically-constructed `PDFPage()` has no page-tree to inherit
 * cropBox from mediaBox — its cropBox defaults to a degenerate/near-zero
 * rect. The page therefore laid out and rendered as a short sliver despite
 * mediaBox being fully correct (and simply never consulted for layout).
 *
 * This never affected pages from the ORIGINAL source PDF (untouched here,
 * "Do NOT mutate original imported PDF bytes") — those come from a real
 * PDF page-tree where cropBox already correctly inherits/is set, which is
 * exactly why the existing PHYSICAL-PASS/FROZEN pencil/viewport behavior on
 * real content pages was never in question. Only the synthetic page was
 * ever missing box geometry.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift', import.meta.url), 'utf8');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const rebuildFn = source.slice(
  source.indexOf('private func rebuildCompositeDocument('),
  source.indexOf('guard preservingCurrentPage else { return }'),
);

console.log('CURRENT BLANK PAGE WIDTH/HEIGHT / SOURCE OF DIMENSIONS — inherited from the last real source page, full size');

check('blankBounds is the LAST SOURCE PAGE\'s own mediaBox — full page size, not a short/arbitrary rect', () => {
  assert.match(
    rebuildFn,
    /let blankBounds = freshSource\.page\(at: max\(0, sourcePageCount - 1\)\)\?\.bounds\(for: \.mediaBox\)\s*\n\s*\?\? CGRect\(x: 0, y: 0, width: 612, height: 792\)/,
  );
});

check('the fallback (only used when the source page truly cannot be read) is a full US-Letter-portrait page, not a short strip', () => {
  assert.match(rebuildFn, /CGRect\(x: 0, y: 0, width: 612, height: 792\)/);
});

console.log('\nWHY IT WAS SHORT — proven: cropBox (the box PDFKit actually lays out/renders by) was never set on the synthetic page');

check('displayBox is never overridden anywhere in this file — PDFKit keeps its own default, .cropBox', () => {
  assert.doesNotMatch(source, /\.displayBox\s*=/);
});

check('the fix: EVERY PDF box type is now set to the same full-page bounds on the synthetic blank page, not just mediaBox', () => {
  const blankConstruction = rebuildFn.slice(rebuildFn.indexOf('let blank = PDFPage()'));
  assert.match(blankConstruction, /blank\.setBounds\(blankBounds, for: \.mediaBox\)/);
  assert.match(blankConstruction, /blank\.setBounds\(blankBounds, for: \.cropBox\)/);
  assert.match(blankConstruction, /blank\.setBounds\(blankBounds, for: \.bleedBox\)/);
  assert.match(blankConstruction, /blank\.setBounds\(blankBounds, for: \.trimBox\)/);
  assert.match(blankConstruction, /blank\.setBounds\(blankBounds, for: \.artBox\)/);
});

check('exactly one PDFPage() is ever constructed in this module (no second, unpatched blank-page path elsewhere)', () => {
  const matches = source.match(/PDFPage\(\)/g) ?? [];
  assert.equal(matches.length, 1);
});

console.log('\nScope discipline: original source PDF pages are never touched by this fix');

check('rebuildCompositeDocument reloads the source PDF byte-identically every time — this fix never calls setBounds on anything from that reload except the newly-constructed synthetic pages', () => {
  const beforeBlank = rebuildFn.slice(0, rebuildFn.indexOf('let blank = PDFPage()'));
  assert.doesNotMatch(beforeBlank, /\.setBounds\(/);
});

console.log(`\nmaterial-blank-page-dimensions: ${passed} checks passed`);
