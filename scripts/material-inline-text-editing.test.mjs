/**
 * Course Material inline text editing — replaces the modal-based "tap →
 * separate modal → type → Save" flow (physically rejected by the owner:
 * "feels like editing metadata/form content, not writing directly on
 * paper") with a native UITextView overlay positioned directly on the PDF
 * page, matching "I click where I want to type, and I type there."
 *
 * Structural/source-level guards (same convention as
 * material-undo-redo-race.test.mjs / material-text-tool.test.mjs) over the
 * native Swift inline-editor wiring and the simplified JS side. Coordinate
 * math itself (PDF page space ↔ PDFView space) reuses the exact
 * `pdfView.convert` pattern already proven in drawTextAnnotation and
 * handleTextDrag — not re-derived here.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const pdfAnnotationView = await read('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const expoPdfAnnotationIndex = await read('../modules/expo-pdf-annotation/index.ts');
const materialScreen = await read('../app/lecture-material/[lectureId]/[materialId].tsx');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('No JS modal remains for text create/edit — native owns the entire typing UX');

check('editingText/editingTextValue/creatingTextAt state, saveEditedText, saveCreatedText, and the <Modal> JSX are all gone', () => {
  assert.doesNotMatch(materialScreen, /const \[editingText, setEditingText\]/);
  assert.doesNotMatch(materialScreen, /const \[editingTextValue, setEditingTextValue\]/);
  assert.doesNotMatch(materialScreen, /const \[creatingTextAt, setCreatingTextAt\]/);
  assert.doesNotMatch(materialScreen, /const saveEditedText = useCallback/);
  assert.doesNotMatch(materialScreen, /const saveCreatedText = useCallback/);
  assert.doesNotMatch(materialScreen, /textEditorBackdrop|textEditorCard|textEditorTitle|textEditorInput/);
});

check('the screen explains text editing is now native-inline, not modal, right where the old modal used to be documented', () => {
  assert.match(materialScreen, /Text create\/edit is a native inline UITextView overlay/);
});

console.log('\nJS wiring: create/edit/paste all converge on ONE shared creation helper — no second text-creation path');

check('createTextAnnotationFromEvent is the single place a MaterialTextAnnotation is constructed and history-pushed for creation', () => {
  const fn = materialScreen.slice(
    materialScreen.indexOf('const createTextAnnotationFromEvent = useCallback('),
    materialScreen.indexOf('const handleNativeTextAnnotationAction = useCallback('),
  );
  assert.match(fn, /pushMaterialHistory\(h, \{ kind: 'text-create', pageNumber, annotation: created \}\)/);
  assert.match(fn, /saveTextAnnotations\(pageNumber, \[\.\.\.current, created\]\)/);
});

check('"create" (native inline editor commit) reads the FINAL text/width/fontSize straight off the event — no modal round-trip', () => {
  const branch = materialScreen.slice(
    materialScreen.indexOf("if (event.action === 'create')"),
    materialScreen.indexOf("if (event.action === 'paste')"),
  );
  assert.match(branch, /createTextAnnotationFromEvent\(event\.pageNumber, text, event\.x!, event\.y!, event\.width \?\? 180, event\.fontSize \?\? 16\)/);
  assert.doesNotMatch(branch, /setCreatingTextAt|setEditingTextValue/);
});

check('"paste" now routes through the exact same shared helper as native "create" — one text-creation code path total', () => {
  const branch = materialScreen.slice(
    materialScreen.indexOf("if (event.action === 'paste')"),
    materialScreen.indexOf('const selected = current.find'),
  );
  assert.match(branch, /createTextAnnotationFromEvent\(event\.pageNumber, text, event\.x!, event\.y!, 180, 16\)/);
});

check('"edit" (native inline editor commit) applies text-edit or text-delete-on-empty directly from event.text — no setEditingText modal trigger', () => {
  const branch = materialScreen.slice(
    materialScreen.indexOf("} else if (event.action === 'edit') {"),
    materialScreen.indexOf("} else if (event.action === 'move' &&"),
  );
  assert.doesNotMatch(branch, /setEditingText/);
  assert.match(branch, /kind: 'text-edit', pageNumber: event\.pageNumber, annotationId: selected\.id, before: selected\.text, after: text,/);
  assert.match(branch, /kind: 'text-delete', pageNumber: event\.pageNumber, annotation: selected/);
});

console.log('\nType layer: create/edit event payload carries the final content, not just a tap notification');

check('NativePdfTextAnnotationActionEvent gains width/fontSize for the create commit', () => {
  assert.match(expoPdfAnnotationIndex, /width\?: number;/);
  assert.match(expoPdfAnnotationIndex, /fontSize\?: number;/);
});

console.log('\nNative: TextAnnotationHit carries width/fontSize so the editor can be sized identically to how the annotation already renders');

check('TextAnnotationHit struct includes width and fontSize', () => {
  const struct = pdfAnnotationView.slice(pdfAnnotationView.indexOf('struct TextAnnotationHit {'), pdfAnnotationView.indexOf('struct TextAnnotationHit {') + 500);
  assert.match(struct, /let width: Double/);
  assert.match(struct, /let fontSize: Double/);
});

check('textAnnotation(at:) populates them from the real stored annotation, not a default', () => {
  const fn = pdfAnnotationView.slice(pdfAnnotationView.indexOf('func textAnnotation(at viewPoint: CGPoint)'), pdfAnnotationView.indexOf('func pageNumber(forTextAnnotationId'));
  assert.match(fn, /x: annotation\.x, y: annotation\.y, width: annotation\.width, fontSize: annotation\.fontSize/);
});

console.log('\nNative: inline editor is a real UITextView, zero-inset/zero-padding to match static rendering math');

check('inlineTextEditor is configured with isScrollEnabled=false (auto-grows) and zero container inset/padding', () => {
  const decl = pdfAnnotationView.slice(pdfAnnotationView.indexOf('private lazy var inlineTextEditor: UITextView'), pdfAnnotationView.indexOf('private lazy var textDeleteButton'));
  assert.match(decl, /tv\.isScrollEnabled = false/);
  assert.match(decl, /tv\.textContainerInset = \.zero/);
  assert.match(decl, /tv\.textContainer\.lineFragmentPadding = 0/);
  assert.match(decl, /tv\.delegate = self/);
});

check('added as a real subview (manually framed, not Auto Layout) so it can be positioned from PDF-coordinate conversion', () => {
  assert.match(pdfAnnotationView, /addSubview\(inlineTextEditor\)/);
});

console.log('\nNative: creation begins on empty-space tap in "text" mode, editing begins on existing-text tap — no modal opened by either');

const tapFn = pdfAnnotationView.slice(
  pdfAnnotationView.indexOf('@objc private func handleTextTap('),
  pdfAnnotationView.indexOf('@objc private func handleTextDrag('),
);

check('any tap first commits an already-open editor before evaluating the new tap', () => {
  const bodyStart = tapFn.indexOf('commitInlineTextEditorIfNeeded()');
  const existingCheck = tapFn.indexOf('if let existing = annotationOverlay.textAnnotation');
  assert.ok(bodyStart > -1 && bodyStart < existingCheck, 'commit must run before the new tap is evaluated');
});

check('tapping existing text in "text" mode selects it AND opens the inline editor immediately — no long-press, no modal', () => {
  const existingBranch = tapFn.slice(tapFn.indexOf('if let existing ='), tapFn.indexOf('if annotationMode == "text" {\n      beginInlineTextCreation'));
  assert.match(existingBranch, /onTextAnnotationAction\(\["action": "select"/);
  assert.match(existingBranch, /if annotationMode == "text" \{\s*\n\s*beginInlineTextEditing\(existing\)/);
});

check('tapping empty space in "text" mode begins a brand-new inline annotation at the tap point — no event emitted yet, nothing created until commit', () => {
  assert.match(tapFn, /beginInlineTextCreation\(at: pagePoint, pageNumber: pageNumber, page: page\)/);
});

console.log('\nNative: commit logic — create only when non-empty, edit always (JS decides edit-vs-delete), anchor never recomputed from screen position');

const commitFn = pdfAnnotationView.slice(
  pdfAnnotationView.indexOf('private func commitInlineTextEditorIfNeeded()'),
  pdfAnnotationView.indexOf('@objc private func handleTextDeleteButtonTap()'),
);

check('a brand-new (id == nil) annotation only emits "create" when the trimmed text is non-empty', () => {
  assert.match(commitFn, /\} else if !finalText\.isEmpty \{\s*\n\s*onTextAnnotationAction\(\[\s*\n\s*"action": "create"/);
});

check('an existing (id != nil) annotation always emits "edit", even with empty text — JS\'s existing clear-to-delete rule decides', () => {
  assert.match(commitFn, /if let id = context\.id \{\s*\n\s*onTextAnnotationAction\(\["action": "edit", "pageNumber": context\.pageNumber, "annotationId": id, "text": finalText\]\)/);
});

check('the anchor (x, y, width, fontSize) committed is the ORIGINAL begin-time context, never recomputed from the editor\'s live frame — typing only grows the box, never moves the anchor', () => {
  assert.match(commitFn, /"x": context\.originX, "y": context\.originY, "width": context\.width, "fontSize": context\.fontSize/);
  assert.doesNotMatch(commitFn, /inlineTextEditor\.frame\.origin/);
});

check('re-entrancy safety: ALL state is cleared before resignFirstResponder() is called, so the UIKit-triggered textViewDidEndEditing re-entrant call is a guaranteed no-op, never a double-emit', () => {
  const clearIdx = commitFn.indexOf('inlineTextEditingContext = nil');
  const resignIdx = commitFn.indexOf('inlineTextEditor.resignFirstResponder()');
  const emitIdx = commitFn.indexOf('onTextAnnotationAction');
  assert.ok(clearIdx > -1 && resignIdx > -1 && emitIdx > -1);
  assert.ok(clearIdx < resignIdx, 'inlineTextEditingContext must be nil BEFORE resignFirstResponder can re-enter this function');
});

console.log('\nNative: UITextViewDelegate — one keystroke reposition (visual only), commit on end-editing, no per-character mutation');

check('textViewDidChange only repositions (auto-grow) — it never emits a history action or onTextAnnotationAction call per keystroke', () => {
  const delegateExt = pdfAnnotationView.slice(
    pdfAnnotationView.indexOf('extension PdfAnnotationView: UITextViewDelegate'),
  );
  const didChangeFn = delegateExt.slice(delegateExt.indexOf('func textViewDidChange'), delegateExt.indexOf('func textViewDidEndEditing'));
  assert.match(didChangeFn, /repositionInlineTextEditor\(\)/);
  assert.doesNotMatch(didChangeFn, /onTextAnnotationAction|pushMaterialHistory/);
});

check('textViewDidEndEditing commits — covers dismissal paths that don\'t go through handleTextTap (e.g. the keyboard\'s own dismiss)', () => {
  const delegateExt = pdfAnnotationView.slice(pdfAnnotationView.indexOf('extension PdfAnnotationView: UITextViewDelegate'));
  assert.match(delegateExt, /func textViewDidEndEditing\(_ textView: UITextView\) \{\s*\n\s*commitInlineTextEditorIfNeeded\(\)/);
});

console.log('\nNative: editor tracks scroll AND zoom while active (KVO contentOffset/bounds + PDFViewScaleChanged)');

check('the scale-change handler repositions the editor and delete button only while each is actually active', () => {
  const fn = pdfAnnotationView.slice(pdfAnnotationView.indexOf('@objc private func handleAnnotationLayoutChange()'), pdfAnnotationView.indexOf('private func startObservingScroll()'));
  assert.match(fn, /if inlineTextEditingContext != nil \{ repositionInlineTextEditor\(\) \}/);
  assert.match(fn, /if selectedTextAnnotationId != nil \{ repositionTextDeleteButton\(\) \}/);
});

check('the contentOffset/bounds KVO handler does the same for scroll', () => {
  const fn = pdfAnnotationView.slice(pdfAnnotationView.indexOf('public override func observeValue('), pdfAnnotationView.indexOf('public override func observeValue(') + 900);
  assert.match(fn, /if inlineTextEditingContext != nil \{ repositionInlineTextEditor\(\) \}/);
  assert.match(fn, /if selectedTextAnnotationId != nil \{ repositionTextDeleteButton\(\) \}/);
});

console.log('\nNative: an annotation being edited is suppressed from BOTH drawing and hit-testing — the live editor is the sole visual/interactive copy');

check('AnnotationOverlay.editingTextAnnotationId exists and drives both suppressions', () => {
  assert.match(pdfAnnotationView, /var editingTextAnnotationId: String\? \{ didSet \{ setNeedsDisplay\(\) \} \}/);
  const drawLoop = pdfAnnotationView.slice(pdfAnnotationView.indexOf('for annotation in annotations where annotation.id != editingTextAnnotationId'));
  assert.ok(drawLoop.startsWith('for annotation in annotations where annotation.id != editingTextAnnotationId'));
  const hitTest = pdfAnnotationView.slice(pdfAnnotationView.indexOf('func textAnnotation(at viewPoint: CGPoint)'));
  assert.match(hitTest, /if annotation\.id == editingTextAnnotationId \{ continue \}/);
});

check('beginInlineTextEditing sets editingTextAnnotationId; commit always clears it', () => {
  const beginFn = pdfAnnotationView.slice(pdfAnnotationView.indexOf('private func beginInlineTextEditing('), pdfAnnotationView.indexOf('private func showInlineTextEditorAndFocus'));
  assert.match(beginFn, /annotationOverlay\.editingTextAnnotationId = hit\.id/);
  assert.match(commitFn, /annotationOverlay\.editingTextAnnotationId = nil/);
});

console.log('\nNative: mode-switch and gesture-priority safety — Pencil can never trigger or collide with inline text');

check('leaving "text" mode always commits any open editor first — never leaves it dangling while switching to Pen/Highlighter/Eraser', () => {
  const modeDidSet = pdfAnnotationView.slice(pdfAnnotationView.indexOf('var annotationMode: String = "scroll" {'), pdfAnnotationView.indexOf('var penColor: String'));
  assert.match(modeDidSet, /if annotationMode != "text" \{\s*\n\s*commitInlineTextEditorIfNeeded\(\)\s*\n\s*\}/);
});

check('the delete button — a real touchable subview — is force-hidden outside scroll/text mode so it can never swallow a Pencil touch meant for drawing', () => {
  const modeDidSet = pdfAnnotationView.slice(pdfAnnotationView.indexOf('var annotationMode: String = "scroll" {'), pdfAnnotationView.indexOf('var penColor: String'));
  assert.match(modeDidSet, /if annotationMode != "scroll" && annotationMode != "text" \{\s*\n\s*textDeleteButton\.isHidden = true/);
});

check('inline editing can only ever be entered from a finger tap (handleTextTap) gated to scroll\/text mode, or the scroll-mode-only long-press Edit action — never from the Pencil-only gesture recognizer', () => {
  assert.doesNotMatch(pdfAnnotationView, /pencilGesture[\s\S]{0,200}beginInlineText/);
});

console.log('\nNative: long-press "Edit" now opens the SAME inline editor — one edit experience, not two');

check('presentTextActions\' Edit action calls beginInlineTextEditing directly, no longer emits a JS "edit" event that used to open a modal', () => {
  const menuFn = pdfAnnotationView.slice(pdfAnnotationView.indexOf('private func presentTextActions('), pdfAnnotationView.indexOf('private func present(_ controller'));
  assert.match(menuFn, /UIAlertAction\(title: "Edit", style: \.default\) \{ \[weak self\] _ in\s*\n\s*self\?\.beginInlineTextEditing\(annotation\)/);
});

console.log('\nNative: delete affordance — a small button at the selection, works without opening the editor or a modal');

check('textDeleteButton exists, is a small circular button (restrained, not a large inspector), driven by selectedTextAnnotationId', () => {
  const decl = pdfAnnotationView.slice(pdfAnnotationView.indexOf('private lazy var textDeleteButton: UIButton'), pdfAnnotationView.indexOf('private var inlineTextEditingContext'));
  assert.match(decl, /button\.layer\.cornerRadius = 12/);
  assert.match(decl, /systemName: "trash\.circle\.fill"/);
});

check('selectedTextAnnotationId\'s didSet repositions/shows/hides the delete button', () => {
  const propDidSet = pdfAnnotationView.slice(pdfAnnotationView.indexOf('var selectedTextAnnotationId: String? {\n    didSet {'), pdfAnnotationView.indexOf('var selectedTextAnnotationId: String? {\n    didSet {') + 300);
  assert.match(propDidSet, /repositionTextDeleteButton\(\)/);
});

check('tapping delete emits the delete action directly — reuses the existing, already-tested JS delete handler, no new JS logic needed', () => {
  const fn = pdfAnnotationView.slice(pdfAnnotationView.indexOf('@objc private func handleTextDeleteButtonTap()'), pdfAnnotationView.indexOf('private func pagedTextAnnotationPageNumber'));
  assert.match(fn, /onTextAnnotationAction\(\["action": "delete", "pageNumber": pageNumber, "annotationId": id\]\)/);
});

check('deleting the annotation currently being edited discards the in-flight edit instead of committing it first (delete supersedes an in-progress edit)', () => {
  const fn = pdfAnnotationView.slice(pdfAnnotationView.indexOf('@objc private func handleTextDeleteButtonTap()'), pdfAnnotationView.indexOf('private func pagedTextAnnotationPageNumber'));
  assert.match(fn, /if inlineTextEditingContext\?\.id == id \{/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf('guard let pageNumber')), /commitInlineTextEditorIfNeeded/);
});

console.log(`\nmaterial-inline-text-editing: ${passed} checks passed`);
