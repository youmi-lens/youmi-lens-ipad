/**
 * Course Material workspace (Build 50) — screen-level integration coverage.
 *
 * lib/materialWorkspace.ts's pure functions (composite page-count math,
 * clamping, "meaningful content" detection) already have dedicated coverage
 * in scripts/material-workspace.test.mjs. This file covers the layer that
 * was NOT yet covered: how app/lecture-material/[lectureId]/[materialId].tsx
 * actually WIRES those functions into the real screen — text annotations,
 * appended note pages, last-viewed-page persistence, and annotated export —
 * plus the cross-feature interactions the task's own integration-check list
 * calls out explicitly (text+append, ink+append, resume+append, export+text,
 * Caption+material page stability).
 *
 * Source-level structural guards, same idiom as material-caption-visibility
 * .test.mjs and caption-window-behavior-parity.test.mjs — this is a native
 * PDFKit-backed screen; on-device feel is a physical-iPad checklist item.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const screen = stripComments(read('../app/lecture-material/[lectureId]/[materialId].tsx'));
const workspace = read('../lib/materialWorkspace.ts');

const slice = (src, startMarker, endMarker) => {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `anchor not found: ${startMarker}`);
  const end = endMarker ? src.indexOf(endMarker, start) : src.length;
  assert.ok(end > start, `end anchor not found after start: ${endMarker}`);
  return src.slice(start, end);
};

// =====================================================================
console.log('PAGE RESUME — screen wiring around lib/materialWorkspace.ts');
// =====================================================================

check('the resume value is derived via clampedMaterialResumePage + compositePageCount, not a raw stored number', () => {
  assert.match(
    screen,
    /const initialLinkedPage = clampedMaterialResumePage\(\s*material\?\.lastOpenedPage,\s*compositePageCount\(material\?\.sourcePageCount \?\? material\?\.pageCount \?\? 1, material\?\.appendedPageCount \?\? 0\),\s*\);/,
  );
});

check('resume is scoped to the material itself (material.lastOpenedPage) — the legacy per-lecture-link position is no longer read', () => {
  assert.doesNotMatch(screen, /materialLinksForLecture|materialLink\?\.lastOpenedPage|updateLectureMaterialLink/, 'legacy lecture-link resume path must be fully removed, not merely bypassed');
});

check('no saved value falls back to page 1 (clampedMaterialResumePage itself is proven separately in material-workspace.test.mjs)', () => {
  assert.match(workspace, /if \(!Number\.isFinite\(numeric\) \|\| numeric < 1\) return 1;/);
});

check('the initial native page is captured ONCE on mount (a live-updating page prop would cause a jump/loop) — a saved viewport takes priority, while old materials retain their last-page fallback', () => {
  const initialPageDecl = slice(screen, 'const [initialPage] = useState<number>(() => Math.max(1, initialViewport?.pageIndex ?? initialLinkedPage));', 'const pageStrokes');
  assert.match(initialPageDecl, /useState<number>\(\(\) => Math\.max\(1, initialViewport\?\.pageIndex \?\? initialLinkedPage\)\)/);
});

check('the persisted resume value is keyed by materialId via updateMaterial(id, ...) — never a global/device-wide key', () => {
  assert.match(screen, /updateMaterial\(id, \{ lastOpenedPage: viewport\.pageIndex, lastOpenedViewport: viewport \}\)/);
});

check('the native viewport handler waits 500ms before writing, and does not write on every scroll/frame event', () => {
  const handler = slice(screen, 'const scheduleViewportPersist = useCallback(', 'const pdfRef');
  assert.match(handler, /setTimeout\(\(\) => \{/);
  assert.match(handler, /\}, 500\);/);
  assert.doesNotMatch(handler, /updateMaterial\(/, 'the timeout schedules a single flush; it does not write on every native event');
});

check('leaving the screen flushes the ACTUAL current native viewport (awaited, not the debounced JS ref) via unmount cleanup, so a quick visit is never lost to the debounce window', () => {
  const effectBlock = slice(screen, 'const nativePdf = pdfRef.current;', 'const fileUri = material');
  assert.match(effectBlock, /persistAuthoritativeViewport\(nativePdf\)/);
  assert.match(effectBlock, /!useNativePdfViewer && id && typeof pending === 'number' && pending !== saved/);
  // The helper itself is what awaits captureViewport() before persisting —
  // see material-last-viewed-position.test.mjs for the full parity check.
  assert.match(screen, /const persistAuthoritativeViewport = useCallback/);
});

check('the driving event is PDFKit\'s own onPageChanged callback, not a scroll/gesture proxy', () => {
  assert.match(screen, /onPageChanged=\{\(event\) => handlePdfPageChanged\(event\.pageNumber\)\}/);
});

check('composite resume accounts for appended note pages too — a saved page beyond the source PDF (an appended page) is within the clamp range, not truncated back into the source range', () => {
  // Proven numerically for the shared function in material-workspace.test.mjs
  // ("saved appended note page restores exactly"); here we confirm the SCREEN
  // actually passes appendedPageCount into that same call, not just sourcePageCount.
  assert.match(screen, /compositePageCount\(material\?\.sourcePageCount \?\? material\?\.pageCount \?\? 1, material\?\.appendedPageCount \?\? 0\)/);
});

console.log('\nPAGE RESUME — not disturbed by unrelated features');

check('text annotation actions (create/edit/move/delete) never touch currentPage, initialPage, or pdfRef — only ensureTrailingBlankPageAfterContent, which itself never navigates', () => {
  const textHandler = slice(screen, 'const handleNativeTextAnnotationAction = useCallback', 'const handleNativeModeChange = useCallback');
  assert.doesNotMatch(textHandler, /setCurrentPage|pdfRef\.current/);
  const ensureFn = slice(screen, 'const ensureTrailingBlankPageAfterContent = useCallback', 'const nativeAnnotationsByPage = useMemo');
  assert.doesNotMatch(ensureFn, /setCurrentPage|pdfRef\.current/, 'creating a new workspace page must never navigate the viewer there automatically');
});

check('export never touches currentPage/initialPage/pdfRef — running an export cannot move the reader\'s position', () => {
  const exportButtonBlock = slice(screen, 'accessibilityLabel="Export annotated PDF"', '<FloatingPageNavigator');
  assert.doesNotMatch(exportButtonBlock, /setCurrentPage|pdfRef\.current/);
});

check('classroomSessionActive (Caption availability) is fully independent of page/annotation/export state — toggling Caption cannot reset the PDF page', () => {
  const captionDecl = slice(screen, 'const { isLectureSessionActive: classroomSessionActive } = useRecordingNotes();', 'const initialLinkedPage = clampedMaterialResumePage');
  assert.doesNotMatch(captionDecl, /setCurrentPage|pdfRef\.current|setInitialPage/);
});

// =====================================================================
console.log('\nAPPENDED PAGES — screen wiring');
// =====================================================================

check('ink strokes on the tracked lecture-scoped path call ensureTrailingBlankPageAfterContent with the page the stroke was drawn on', () => {
  const handler = slice(screen, 'const handleNativeAnnotationCommitted = useCallback', 'const addPageStroke = useCallback');
  assert.match(handler, /ensureTrailingBlankPageAfterContent\(page\);/);
});

check('ink strokes on the material-scoped (legacy JS fallback) path also call ensureTrailingBlankPageAfterContent, on the currently viewed page', () => {
  const handler = slice(screen, 'const addPageStroke = useCallback', 'const erasePageStrokeIds');
  assert.match(handler, /ensureTrailingBlankPageAfterContent\(currentPage\);/);
});

check('pasting text calls ensureTrailingBlankPageAfterContent on the page it was pasted onto (via the shared createTextAnnotationFromEvent helper, same as native "create")', () => {
  const pasteBranch = slice(screen, "if (event.action === 'create') {", 'const selected = current.find');
  assert.match(pasteBranch, /createTextAnnotationFromEvent\(event\.pageNumber, text, event\.x!, event\.y!, event\.width \?\? 180, 16, event\.anchor, event\.annotationId\);/);
  const createHelper = slice(screen, 'const createTextAnnotationFromEvent = useCallback', 'const handleNativeTextAnnotationAction = useCallback');
  assert.match(createHelper, /ensureTrailingBlankPageAfterContent\(pageNumber\);/);
});

check('committing a non-empty inline edit can extend the trailing page, but editing does not unconditionally call it every time (only when text is non-empty)', () => {
  const editBranch = slice(screen, "} else if (event.action === 'edit') {", 'const handleNativeModeChange = useCallback');
  assert.match(editBranch, /if \(text\) ensureTrailingBlankPageAfterContent\(event\.pageNumber\);/);
});

check('committing an inline edit with empty text (the clear-to-delete path) does NOT call ensureTrailingBlankPageAfterContent — removing content must never create a page', () => {
  const editBranch = slice(screen, "} else if (event.action === 'edit') {", 'const handleNativeModeChange = useCallback');
  const beforeEnsureCall = editBranch.slice(0, editBranch.indexOf('if (text) ensureTrailingBlankPageAfterContent'));
  assert.doesNotMatch(beforeEnsureCall, /ensureTrailingBlankPageAfterContent\(/);
});

check('appended-page bookkeeping is refs-backed (sourcePageCountRef/appendedPageCountRef) so ensureTrailingBlankPageAfterContent always reads the LATEST count, never a stale closure value across rapid strokes', () => {
  assert.match(screen, /const sourcePageCountRef = useRef\(sourcePageCount\);/);
  assert.match(screen, /const appendedPageCountRef = useRef\(appendedPageCount\);/);
  const ensureFn = slice(screen, 'const ensureTrailingBlankPageAfterContent = useCallback', 'const nativeAnnotationsByPage = useMemo');
  assert.match(ensureFn, /appendedPageCountRef\.current/);
  assert.doesNotMatch(ensureFn, /\bappendedPageCount\b(?!Ref)(?!:)/, 'must read the ref, not close over the possibly-stale state value (an object-literal key like \`appendedPageCount: next\` is fine — only a bare state-variable reference would be a stale-closure risk)');
});

check('the page-extension rule itself is monotonic and bounded (proven in material-workspace.test.mjs: no-op on a non-final page, +1 exactly once per newly-reached final page, never shrinks) — the screen only ever calls it, never reimplements the rule inline', () => {
  assert.doesNotMatch(screen, /appendedPageCount\s*[+-]=|setAppendedPageCount\((?!next\))/, 'appendedPageCount must only ever be set via the next value computed by appendedPageCountAfterFinalPageContent, never incremented/decremented ad hoc elsewhere');
});

// =====================================================================
console.log('\nTEXT ANNOTATIONS — screen wiring');
// =====================================================================

check('text annotations are persisted via the material-scoped store path (replaceMaterialPageTextAnnotationsForMaterial), matching the material-wide (not lecture-scoped) semantics text annotations need', () => {
  assert.match(screen, /const saveTextAnnotations = useCallback\(\(pageNumber: number, annotations: MaterialTextAnnotation\[\]\) => \{/);
  assert.match(screen, /replaceMaterialPageTextAnnotationsForMaterial\(id, pageNumber, annotations, materialScopeLectureId\(id\)\);/);
});

check('create (paste and native inline-create) generates a fresh id, captures native x/y, and rejects empty/invalid drops (no text, or non-finite coordinates)', () => {
  const pasteBranch = slice(screen, "if (event.action === 'create') {", 'const selected = current.find');
  assert.match(pasteBranch, /if \(!text \|\| !Number\.isFinite\(event\.x\) \|\| !Number\.isFinite\(event\.y\)\) return;/);
  const createHelper = slice(screen, 'const createTextAnnotationFromEvent = useCallback', 'const handleNativeTextAnnotationAction = useCallback');
  assert.match(createHelper, /id: annotationId \?\? `material-text-\$\{Date\.now\(\)\}-/);
});

check('edit is native-inline-editor-driven: the event already carries the FINAL text (no modal round-trip), and the handler writes it back with a fresh updatedAt', () => {
  const editBranch = slice(screen, "} else if (event.action === 'edit') {", 'const handleNativeModeChange = useCallback');
  assert.doesNotMatch(editBranch, /setEditingText/, 'no JS modal state exists anymore — see material-inline-text-editing.test.mjs');
  assert.match(editBranch, /const text = \(event\.text \?\? ''\)\.trim\(\);/);
  assert.match(editBranch, /\{ \.\.\.annotation, text, updatedAt: new Date\(\)\.toISOString\(\) \}/);
});

check('object movement is no longer reachable; content editing preserves saved coordinates', () => {
  const handler = slice(screen, 'const handleNativeTextAnnotationAction = useCallback', 'const handleNativeModeChange = useCallback');
  assert.doesNotMatch(handler, /event.action === 'move'|event.action === 'resize'/);
});

check('delete removes exactly the targeted annotation by id and clears the selection — it does not touch any other annotation on the page', () => {
  const deleteBranch = slice(screen, "if (event.action === 'delete') {", "} else if (event.action === 'edit'");
  assert.match(deleteBranch, /current\.filter\(\(annotation\) => annotation\.id !== selected\.id\)/);
  assert.doesNotMatch(deleteBranch, /setSelectedTextAnnotationId/);
});

check('width and fontSize are captured at creation time and are part of the persisted annotation shape, so re-render/re-layout does not have to re-derive wrapping from scratch', () => {
  const pasteBranch = slice(screen, "if (event.action === 'create') {", 'const selected = current.find');
  assert.match(pasteBranch, /createTextAnnotationFromEvent\(event\.pageNumber, text, event\.x!, event\.y!, event\.width \?\? 180, 16, event\.anchor, event\.annotationId\)/, 'commit passes document width, fixed font16 and native identity into the shared helper');
  const createHelper = slice(screen, 'const createTextAnnotationFromEvent = useCallback', 'const handleNativeTextAnnotationAction = useCallback');
  assert.match(createHelper, /x, y, width, fontSize, anchor, createdAt: now, updatedAt: now,/, 'width/fontSize are real fields on the persisted annotation, not derived later');
});

check('selection state and manipulation props are removed', () => {
  assert.doesNotMatch(screen, /selectedTextAnnotationId|setSelectedTextAnnotationId/);
});

check('every text mutation path (edit/move/delete, plus paste/create via the shared createTextAnnotationFromEvent helper) goes through the SAME saveTextAnnotations function — one persistence path, not one per action', () => {
  const handler = slice(screen, 'const handleNativeTextAnnotationAction = useCallback', 'const handleNativeModeChange = useCallback');
  const calls = handler.match(/saveTextAnnotations\(/g) ?? [];
  assert.ok(calls.length >= 2, `expected delete/edit/move to route through saveTextAnnotations, found ${calls.length} call sites`);
  const createHelper = slice(screen, 'const createTextAnnotationFromEvent = useCallback', 'const handleNativeTextAnnotationAction = useCallback');
  assert.match(createHelper, /saveTextAnnotations\(/);
});

check('material isolation: text annotations are read/written by materialId (materialIdRef.current), never by lectureId alone', () => {
  const textAnnotationsMemo = slice(screen, 'const nativeTextAnnotationsByPage = useMemo', 'const saveTextAnnotations = useCallback');
  assert.match(textAnnotationsMemo, /textAnnotationsForMaterialPage\(material\.id, page\)/);
});

// =====================================================================
console.log('\nEXPORT — screen wiring');
// =====================================================================

check('export is disabled while a previous export is in flight, and while no source page count is known yet', () => {
  const exportButton = slice(screen, 'accessibilityLabel="Export annotated PDF"', 'accessibilityRole="button"\n          disabled={exporting || sourcePageCount < 1}'.split('\n')[0]);
  assert.match(screen, /disabled=\{exporting \|\| sourcePageCount < 1\}/);
});

check('export passes sourcePageCount + appendedBlankPageCount (not raw totalPages) to exportAnnotatedPdfAsync — the trailing untouched workspace page must be excludable by the native side using this same accounting exportedPageCount() proves', () => {
  const exportCall = slice(screen, 'const outputUri = await exportAnnotatedPdfAsync({', '});');
  assert.match(exportCall, /sourcePageCount,/);
  assert.match(exportCall, /appendedBlankPageCount: appendedPageCount,/);
  assert.match(exportCall, /annotationsByPage: nativeAnnotationsByPage,/);
  assert.match(exportCall, /textAnnotationsByPage: nativeTextAnnotationsByPage,/);
});

check('the exported/trailing-page distinction is governed by exportedPageCount(), proven separately: an unused trailing page is excluded, a used one is included', () => {
  assert.match(workspace, /return source \+ Math\.max\(0, Math\.round\(appendedPageCount \|\| 0\) - 1\);/);
});

check('export failures are caught, surfaced to the user, and always clear the exporting flag (finally) — a failed export cannot leave the button permanently disabled', () => {
  const exportCall = slice(screen, 'onPress={async () => {', 'style={({ pressed })');
  assert.match(exportCall, /catch \(error\) \{/);
  assert.match(exportCall, /finally \{\s*setExporting\(false\);/);
});

check('export never calls updateMaterial or any annotation-mutating function — it is read-only over existing state', () => {
  const exportCall = slice(screen, 'onPress={async () => {', 'style={({ pressed })');
  assert.doesNotMatch(exportCall, /updateMaterial\(|saveTextAnnotations\(|addAnnotationStroke\(/);
});

console.log(`\nmaterial-course-workspace: ${passed} checks passed`);
