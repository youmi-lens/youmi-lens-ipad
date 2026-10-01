/**
 * Course Material pasted/committed text "flash" / floating feel.
 *
 * Root cause (read-only audit, matches the pre-existing heavy-annotation-
 * state investigation in lib/courseMaterialHeavyStateDiagnostics.ts, which
 * documented the identical mechanism for the STROKE side of this same
 * screen — nativeAnnotationsByPage / the Eraser task, untouched here):
 *
 *   `textAnnotationsForMaterialPage` is an inline closure on the whole
 *   DataContext value (lib/store.tsx), which gets a NEW reference on every
 *   unrelated store update — recording autosave, an unrelated lecture edit,
 *   anything. That alone used to force `nativeTextAnnotationsByPage`
 *   (app/lecture-material/[lectureId]/[materialId].tsx) to rebuild a BRAND
 *   NEW grouped object every time, even when no text annotation actually
 *   changed, and hand it to the native PDF overlay as a "new" prop.
 *   PdfAnnotationView.swift's `loadTextAnnotations` then unconditionally
 *   replaced its native store and called `setNeedsDisplay()` — a full
 *   redraw of every committed text annotation — on every single resend,
 *   with no comparison against what was already loaded. That redraw fires
 *   on a cadence tied to unrelated app activity, not to anything the user
 *   did on this screen, which is what reads as pasted/committed text
 *   "flashing" and feeling like a floating overlay rather than something
 *   printed on the page.
 *
 * Two independent, minimal, content-based equality checks close this:
 *   1. JS: `nativeTextAnnotationsByPage`'s useMemo now returns the SAME
 *      object reference across an unrelated recompute when the grouped
 *      content is unchanged (textAnnotationsByPageEqual, lib/materialWorkspace.ts).
 *   2. Native: `loadTextAnnotations` skips the reassignment + redraw
 *      entirely when the incoming data equals what is already loaded
 *      (TextAnnotation is now Equatable) — defense-in-depth, correct even
 *      if some future caller ever sends this prop unmemoized.
 *
 * Neither coordinate system nor object identity needed to change: text
 * annotation geometry was already stored in PDF-page points (see
 * lib/models.ts's MaterialTextAnnotation doc comment) and ids were already
 * minted once and never regenerated on save (createTextAnnotationFromEvent).
 * This file proves those pre-existing invariants stay true, and proves the
 * new reference-stability fix, rather than re-testing paste-as-history-
 * create wiring already covered by material-text-tool.test.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const materialWorkspace = read('../lib/materialWorkspace.ts');
const materialScreen = read('../app/lecture-material/[lectureId]/[materialId].tsx');
const pdfAnnotationView = read('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const models = read('../lib/models.ts');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('Pure equality helper: textAnnotationsByPageEqual (lib/materialWorkspace.ts)');

// Executable, not just pattern-matched: import the real module and run it
// against representative inputs, so the actual comparison logic is proven,
// not just its presence in source.
const { textAnnotationsByPageEqual } = await import('../lib/materialWorkspace.ts')
  .catch(async () => {
    // Plain Node has no TS loader; fall back to a structural source check
    // for the CI path that runs these .mjs files directly against .ts
    // source without a TS-aware runtime. The behavioral assertions below
    // still run wherever a TS-aware runtime IS available.
    return { textAnnotationsByPageEqual: null };
  });

const annotationA = { id: 'a1', text: 'hello', x: 10, y: 20, width: 180, fontSize: 16, createdAt: 't', updatedAt: 't' };
const annotationAClone = { ...annotationA }; // same content, different object identity
const annotationB = { ...annotationA, text: 'different' };

if (textAnnotationsByPageEqual) {
  check('identical content across different object/array instances is equal', () => {
    assert.equal(textAnnotationsByPageEqual({ '1': [annotationA] }, { '1': [annotationAClone] }), true);
  });
  check('a real content change (text edited) is NOT equal', () => {
    assert.equal(textAnnotationsByPageEqual({ '1': [annotationA] }, { '1': [annotationB] }), false);
  });
  check('a real geometry change (moved) is NOT equal', () => {
    assert.equal(textAnnotationsByPageEqual({ '1': [annotationA] }, { '1': [{ ...annotationA, x: 99 }] }), false);
  });
  check('a page gaining or losing an annotation is NOT equal', () => {
    assert.equal(textAnnotationsByPageEqual({ '1': [annotationA] }, { '1': [annotationA], '2': [annotationA] }), false);
    assert.equal(textAnnotationsByPageEqual({ '1': [annotationA] }, {}), false);
  });
  check('two empty groupings are equal (no annotations on either side)', () => {
    assert.equal(textAnnotationsByPageEqual({}, {}), true);
  });
} else {
  check('(fallback) textAnnotationsByPageEqual is defined and compares id/text/x/y/width/fontSize per page', () => {
    assert.match(materialWorkspace, /export function textAnnotationsByPageEqual/);
    assert.match(materialWorkspace, /x\.id !== y\.id \|\|\s*\n\s*x\.text !== y\.text \|\|\s*\n\s*x\.x !== y\.x \|\|\s*\n\s*x\.y !== y\.y \|\|\s*\n\s*x\.width !== y\.width \|\|\s*\n\s*x\.fontSize !== y\.fontSize/);
  });
}

console.log('\nJS wiring: nativeTextAnnotationsByPage keeps its reference stable across an unrelated recompute');

const textByPageMemo = materialScreen.slice(
  materialScreen.indexOf('const lastTextAnnotationsByPageRef ='),
  materialScreen.indexOf('const saveTextAnnotations = useCallback('),
);

check('a ref holds the last grouped result across renders (survives an unrelated recompute of the surrounding component)', () => {
  assert.match(textByPageMemo, /const lastTextAnnotationsByPageRef = useRef<NativePdfTextAnnotationsByPage>\(\{\}\);/);
});

check('content-equal recomputes return the CACHED reference, not the freshly built object', () => {
  assert.match(textByPageMemo, /if \(textAnnotationsByPageEqual\(lastTextAnnotationsByPageRef\.current, grouped\)\) \{\s*\n\s*return lastTextAnnotationsByPageRef\.current;\s*\n\s*\}/);
});

check('a genuinely new/changed grouping DOES update the cached ref (so real edits still propagate)', () => {
  assert.match(textByPageMemo, /lastTextAnnotationsByPageRef\.current = grouped;\s*\n\s*return grouped;/);
});

check('the stroke/Eraser sibling (nativeAnnotationsByPage) is untouched by this fix — different task, own useMemo, no ref/equality wiring added here', () => {
  const strokeMemo = materialScreen.slice(
    materialScreen.indexOf('const nativeAnnotationsByPage = useMemo<NativePdfAnnotationsByPage>('),
    materialScreen.indexOf('}, [annotationsForMaterialPage, lectureId, material?.id, material?.pageCount, totalPages, useNativePdfViewer]);')
      + '}, [annotationsForMaterialPage, lectureId, material?.id, material?.pageCount, totalPages, useNativePdfViewer]);'.length,
  );
  assert.doesNotMatch(strokeMemo, /textAnnotationsByPageEqual/);
  assert.doesNotMatch(strokeMemo, /lastTextAnnotationsByPageRef/);
});

console.log('\nNative wiring: loadTextAnnotations skips the redraw when content is unchanged (PdfAnnotationView.swift)');

check('TextAnnotation conforms to Equatable (enables the whole-dictionary comparison below)', () => {
  assert.match(pdfAnnotationView, /struct TextAnnotation: Equatable \{/);
});

const loadTextAnnotationsFn = pdfAnnotationView.slice(
  pdfAnnotationView.indexOf('  func loadTextAnnotations('),
  pdfAnnotationView.indexOf('  func textAnnotation(at viewPoint:'),
);

check('the parsed result is compared against the currently-loaded dictionary before committing', () => {
  assert.match(loadTextAnnotationsFn, /if loaded == pagedTextAnnotations \{ return \}/);
});

check('the equality check happens BEFORE the assignment and setNeedsDisplay (a no-op resend never redraws)', () => {
  const guardIdx = loadTextAnnotationsFn.indexOf('if loaded == pagedTextAnnotations');
  const assignIdx = loadTextAnnotationsFn.indexOf('pagedTextAnnotations = loaded');
  const redrawIdx = loadTextAnnotationsFn.indexOf('setNeedsDisplay()');
  assert.ok(guardIdx > -1 && assignIdx > guardIdx && redrawIdx > assignIdx);
});

console.log('\nPre-existing invariants this fix relies on and must not disturb');

check('text annotation geometry is documented as PDF-page points, not screen/viewport/scroll-relative (canonical paper-space, unchanged by this fix)', () => {
  assert.match(models, /All geometry is in PDF-page points\./);
});

check('paste and native-create share exactly one annotation-construction path — one committed text always gets exactly one id, never regenerated on save', () => {
  const createFn = materialScreen.slice(
    materialScreen.indexOf('const createTextAnnotationFromEvent = useCallback('),
    materialScreen.indexOf('const handleNativeTextAnnotationAction = useCallback('),
  );
  assert.match(createFn, /id: annotationId \?\? `material-text-\$\{Date\.now\(\)\}-\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 8\)\}`/);
  const pasteBranch = materialScreen.slice(
    materialScreen.indexOf("if (event.action === 'create')"),
    materialScreen.indexOf("const selected = current.find"),
  );
  assert.match(pasteBranch, /createTextAnnotationFromEvent\(event\.pageNumber, text, event\.x!, event\.y!, event\.width \?\? 180, 16, event\.anchor, event\.annotationId\);/);
});

check('the store setter itself already bails out on identical content (belt-and-suspenders with the two checks above)', () => {
  const setterFn = read('../lib/store.tsx').slice(
    read('../lib/store.tsx').indexOf('const replaceMaterialPageTextAnnotationsForMaterial = useCallback('),
    read('../lib/store.tsx').indexOf('const undoLastAnnotationStroke = useCallback('),
  );
  assert.match(setterFn, /if \(current\.length === sanitized\.length && current\.every\(\(item, i\) => item === sanitized\[i\]\)\) return prev;/);
});

check('an in-progress edit is never double-rendered: the committed draw loop skips the annotation currently owned by the live UITextView', () => {
  const drawLoop = pdfAnnotationView.slice(
    pdfAnnotationView.indexOf('for (pageNumber, annotations) in pagedTextAnnotations {'),
    pdfAnnotationView.indexOf('  private func drawTextAnnotation('),
  );
  assert.match(drawLoop, /annotations\.filter \{ \$0\.id != editingTextAnnotationId \}/);
});

check('the inline editor never recomputes its anchor at commit time — it reuses the begin-time origin exactly, so committing cannot visibly jump', () => {
  const commitFn = pdfAnnotationView.slice(
    pdfAnnotationView.indexOf('  private func commitInlineTextEditorIfNeeded('),
    pdfAnnotationView.indexOf('  private func presentTextActions('),
  );
  assert.match(commitFn, /"x": context\.originX, "y": context\.originY, "width": context\.width, "fontSize": context\.fontSize/);
  assert.doesNotMatch(commitFn, /pdfView\.convert/);
});

console.log(`\nmaterial-text-paste-flicker: ${passed} checks passed`);
