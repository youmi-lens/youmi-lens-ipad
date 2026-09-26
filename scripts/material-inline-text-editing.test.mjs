// Simplified product contract: native editor → one immutable page anchor → commit.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const native = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
const geometry = read('modules/expo-pdf-annotation/ios/MaterialTextGeometry.swift');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('ok ' + name); };
const section = (start, end) => native.slice(native.indexOf(start), native.indexOf(end, native.indexOf(start)));
const tap = section('@objc private func handleTextTap(', '// MARK: - Native inline text editing');
const commit = section('private func commitInlineTextEditorIfNeeded()', 'private func presentTextActions');
check('tap resolves the owning real page before capturing the PDF point', () => {
  assert.match(tap, /annotationMode == "text"/);
  assert.match(tap, /page\(for: point, nearest: false\)/);
  assert.match(tap, /pdfView\.convert\(point, to: page\)/);
  assert.match(tap, /document\.index\(for: page\) \+ 1/);
});
check('tap existing content opens the editor directly, never selects an object', () => {
  assert.match(tap, /beginInlineTextEditing\(existing\)/);
  assert.doesNotMatch(tap, /select|presentTextActions/);
});
check('typing/pasting uses zero-inset native UITextView, no JS modal', () => {
  assert.match(native, /tv\.textContainerInset = \.zero/);
  assert.match(native, /tv\.textContainer\.lineFragmentPadding = 0/);
  assert.match(native, /tv\.isScrollEnabled = false/);
  assert.doesNotMatch(screen, /setCreatingTextAt|setEditingTextValue|textEditorCard/);
});
check('new text top anchor is captured once; existing anchor is preserved', () => {
  assert.match(native, /fontSize: fontSize, width: Double\(availableWidth\), anchor: "top-left"/);
  assert.match(native, /fontSize: hit\.fontSize, width: hit\.width, anchor: hit\.anchor/);
});
check('empty new editor creates nothing', () => assert.match(commit, /else if !finalText\.isEmpty/));
check('edit emits only id and text, never coordinates or size', () => {
  const edit = commit.match(/onTextAnnotationAction\(\["action": "edit"[^\n]+/)[0];
  assert.match(edit, /"annotationId": id, "text": finalText/);
  assert.doesNotMatch(edit, /"x"|"y"|"width"/);
});
check('create persists original PDF point, never the editor frame', () => {
  assert.match(commit, /"x": context\.originX, "y": context\.originY/);
  assert.match(commit, /"anchor": "top-left"/);
  assert.doesNotMatch(commit, /inlineTextEditor\.frame|pdfView\.convert/);
});
check('clear context before resign prevents double commit', () => {
  assert.ok(commit.indexOf('inlineTextEditingContext = nil') < commit.indexOf('inlineTextEditor.resignFirstResponder'));
});
check('one create is one history action; fixed document font16', () => {
  assert.match(screen, /kind: 'text-create', pageNumber, annotation: created/);
  assert.match(screen, /event\.width \?\? 180, 16, event\.anchor/);
  assert.match(geometry, /defaultFontSize: CGFloat = 16/);
});
check('edit preserves geometry; empty edit retains delete/undo behavior', () => {
  assert.match(screen, /\.\.\.annotation, text, updatedAt/);
  assert.match(screen, /kind: 'text-edit'/);
  assert.match(screen, /kind: 'text-delete'/);
});
check('text mode does not reset after create/commit or page change', () => {
  assert.doesNotMatch(tap + commit, /annotationMode =(?!=)|onAnnotationModeChanged/);
  const action = screen.slice(screen.indexOf('const handleNativeTextAnnotationAction'), screen.indexOf('const handleNativeModeChange'));
  assert.doesNotMatch(action, /setNativeAnnotationMode|setToolMode/);
});
check('scroll paste also opens same inline editor before persistence', () => {
  assert.match(native, /beginInlineTextCreation\(at: pagePoint, pageNumber: pageNumber, page: page, initialText: clipboard\)/);
  assert.doesNotMatch(native, /"action": "paste"/);
});
console.log('material-inline-text-editing: ' + passed + ' checks passed');
