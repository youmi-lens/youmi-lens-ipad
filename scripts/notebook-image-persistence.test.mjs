/**
 * Notes image data-loss fixes (Build 50 post-release Notes reliability loop).
 *
 * Root cause 1 (proven by reading lib/store.tsx): mergeRemoteRecordingsIntoStore's
 * returned Lecture object carried `noteStrokes: local?.noteStrokes ?? []` but
 * had no `noteImages` line at all — an inserted image survived saveNotes()
 * locally, then vanished on the next remote-merge cycle (screen focus/nav
 * fires this constantly), since the field was silently omitted from the
 * merged object every time.
 *
 * Root cause 2 (proven by reading components/NotebookCanvas.tsx + lib/models.ts):
 * NoteImage.uri was the raw expo-image-picker asset.uri — a transient
 * picker-owned temp/cache path, never copied into durable app storage. The
 * type's own doc comment said as much. Fixed by copying into
 * Documents/YoumiLens/NoteImages/{imageId}.ext (lib/notebookImageStorage.ts)
 * before the image ever becomes canonical state.
 *
 * Root cause 3 (proven by reading app/lecture/[id].tsx): the Notes editor's
 * "Cancel" button and the Modal's onRequestClose (system dismiss gesture)
 * both called setNotesOpen(false) directly — silently discarding the entire
 * unsaved draft (notes/strokes/images) with no confirmation. Fixed with a
 * dirty-check + confirmation alert shared by both paths.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const store = read('lib/store.tsx');
const canvas = read('components/NotebookCanvas.tsx');
const imageStorage = read('lib/notebookImageStorage.ts');
const lectureDetail = read('app/lecture/[id].tsx');
const localeEn = read('lib/locales/en.mjs');
const localeEs = read('lib/locales/es.mjs');
const localeFr = read('lib/locales/fr.mjs');
const localeJa = read('lib/locales/ja.mjs');
const localeKo = read('lib/locales/ko.mjs');
const localeZh = read('lib/locales/zh-Hans.mjs');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('Root cause 1 — noteImages preserved across every remote-merge cycle');

check('mergeRemoteRecordingsIntoStore carries noteImages forward from local, same as noteStrokes right above it', () => {
  const strokesIdx = store.indexOf('noteStrokes: local?.noteStrokes ?? [],');
  assert.ok(strokesIdx > 0, 'anchor line must exist');
  const nearby = store.slice(strokesIdx, strokesIdx + 700);
  assert.match(nearby, /noteImages: local\?\.noteImages \?\? \[\],/, 'noteImages must be carried forward from local in the same merged-lecture object literal');
});

check('the merge function does not compute noteImages from any remote/row field (there is no cloud column for it)', () => {
  const strokesIdx = store.indexOf('noteStrokes: local?.noteStrokes ?? [],');
  const nearby = store.slice(strokesIdx, strokesIdx + 700);
  const imagesLineMatch = nearby.match(/noteImages: [^\n]+/);
  assert.ok(imagesLineMatch, 'noteImages line must exist');
  assert.doesNotMatch(imagesLineMatch[0], /row\./, 'must not read from the remote row — there is no cloud column for note images');
});

console.log('\nRoot cause 2 — picked images are copied into durable Youmi Lens-owned storage');

check('lib/notebookImageStorage.ts exists and copies (never moves/deletes) the source into Documents/YoumiLens/NoteImages', () => {
  assert.match(imageStorage, /export async function persistNotebookImage\(/);
  assert.match(imageStorage, /new FileSystemNS\.Directory\(FileSystemNS\.Paths\.document, 'YoumiLens', 'NoteImages'\)/);
  assert.match(imageStorage, /sourceFile\.copy\(target\)/, 'must copy, not move — source photo must remain untouched');
  assert.doesNotMatch(imageStorage, /sourceFile\.(delete|move)\(/, 'must never delete or move the picker-provided source asset');
});

check('persistNotebookImage returns null (not a fallback URI) on any failure — the caller decides, it never silently substitutes the transient URI itself', () => {
  const fnBody = imageStorage.slice(imageStorage.indexOf('export async function persistNotebookImage('));
  assert.match(fnBody, /if \(!FileSystemNS\?\.File\) return null;/);
  assert.match(fnBody, /if \(!dir\) return null;/);
  assert.match(fnBody, /return null;\s*\n\s*\} catch \(err\) \{/);
});

check('pickImage awaits the durable copy BEFORE the image object is created, using the same id for both', () => {
  const start = canvas.indexOf('const pickImage = useCallback(async () => {');
  const end = canvas.indexOf('const canClear =', start);
  const body = canvas.slice(start, end);
  assert.match(body, /const imageId = makeImageId\(\);/);
  assert.match(body, /const durableUri = await persistNotebookImage\(asset\.uri, imageId\);/);
  const durableIdx = body.indexOf('await persistNotebookImage');
  const imgObjIdx = body.indexOf('const img: NoteImage = clampImageGeometry(');
  assert.ok(durableIdx > 0 && durableIdx < imgObjIdx, 'the durable copy must be awaited before the NoteImage object is built');
  assert.match(body, /id: imageId,/);
  assert.match(body, /uri: durableUri \?\? asset\.uri,/, 'falls back to the transient URI only if the durable copy failed, never blocking the insert entirely');
});

console.log('\nRoot cause 3 — closing the Notes editor with unsaved changes requires confirmation');

check('both Cancel and the system dismiss gesture (onRequestClose) route through the same guarded handler, not a bare setNotesOpen(false)', () => {
  const modalStart = lectureDetail.indexOf('<Modal\n        visible={notesOpen}');
  const modalEnd = lectureDetail.indexOf('</Modal>', modalStart);
  const modalBody = lectureDetail.slice(modalStart, modalEnd);
  assert.match(modalBody, /onRequestClose=\{requestCloseNotesEditor\}/);
  assert.match(modalBody, /onPress=\{requestCloseNotesEditor\}/);
  assert.doesNotMatch(modalBody, /onPress=\{\(\) => setNotesOpen\(false\)\}/, 'no path in the modal may discard silently anymore');
});

check('requestCloseNotesEditor only prompts when the draft actually differs from the persisted lecture (reference-equality dirty check)', () => {
  const fnStart = lectureDetail.indexOf('const requestCloseNotesEditor = () => {');
  const fnEnd = lectureDetail.indexOf('};', fnStart) + 2;
  const body = lectureDetail.slice(fnStart, fnEnd);
  assert.match(body, /if \(!notesEditorDirty\) \{\s*setNotesOpen\(false\);\s*return;\s*\}/, 'a clean/untouched draft closes immediately, no unnecessary prompt');
  assert.match(body, /Alert\.alert\(/, 'a dirty draft prompts before discarding');
});

check('the dirty check covers notes text, strokes, AND images — not just images', () => {
  const start = lectureDetail.indexOf('const notesEditorDirty =');
  const end = lectureDetail.indexOf(';', start);
  const body = lectureDetail.slice(start, end);
  assert.match(body, /notesDraft !== \(lecture\.notes \?\? ''\)/);
  assert.match(body, /strokesDraft !== \(lecture\.noteStrokes \?\? \[\]\)/);
  assert.match(body, /imagesDraft !== \(lecture\.noteImages \?\? \[\]\)/);
});

check('the discard confirmation is destructive-styled and offers an explicit cancel-the-cancel path back into editing', () => {
  const start = lectureDetail.indexOf('const requestCloseNotesEditor');
  const body = lectureDetail.slice(start, start + 600);
  assert.match(body, /style: 'cancel'/);
  assert.match(body, /style: 'destructive'/);
});

check('all 6 shipped locales define the 3 new discard-confirmation strings', () => {
  for (const [name, src] of [['en', localeEn], ['es', localeEs], ['fr', localeFr], ['ja', localeJa], ['ko', localeKo], ['zh-Hans', localeZh]]) {
    for (const key of ['lecture.notesDiscardTitle', 'lecture.notesDiscardMessage', 'lecture.notesDiscardConfirm']) {
      assert.match(src, new RegExp(key.replace(/\./g, '\\.')), `${name} must define ${key}`);
    }
  }
});

console.log(`\nnotebook-image-persistence: ${passed} checks passed`);
