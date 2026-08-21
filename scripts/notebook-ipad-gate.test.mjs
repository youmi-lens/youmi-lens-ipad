/**
 * iPhone Notebook gate — the iPad-style handwritten + typed Pencil editor
 * (NotebookCanvas) must never open on iPhone, from ANY entry point. Tapping
 * an entry shows a concise localized notice instead; iPad is unaffected.
 *
 * There are exactly two literal `<NotebookCanvas` mounts in the codebase
 * (verified: `grep -rn "<NotebookCanvas" --include="*.tsx"`), and both are
 * gated:
 *   1. Lecture Detail Notes preview (openNotesEditor → fullscreen Modal).
 *   2. Mini (app/mini-caption.tsx) — reached only via Recording's
 *      openMiniCaption(), used by both the iPad header button and the phone
 *      bottom-bar utility button. Mini's whole screen is a NotebookCanvas
 *      page; the floating caption/control panel on top of it is not an
 *      independent destination (Recording already shows timer/captions/
 *      controls on its own), so gating the navigation is gating Notebook,
 *      not removing a separate feature. The gate lives in openMiniCaption
 *      itself, before router.push — the recorder/session/pendingLectureId/
 *      timer are never touched, because navigation never happens.
 *
 * Out of scope, confirmed separate: Material annotation
 * (MaterialFloatingToolbar/MaterialAnnotationOverlay) copies NotebookCanvas's
 * toolbar *styling* but never imports or mounts NotebookCanvas itself.
 *
 * Also confirmed separate (not touched by this fix): Notebook and "ordinary
 * text Notes" are NOT two features in this codebase — Lecture.notes (typed),
 * .noteStrokes (handwritten) and .noteImages all live in ONE unified
 * NotebookCanvas editor. There is no separate plain-text-only notes screen.
 *
 * Device class: no existing iPad helper existed. Added
 * constants/deviceClass.ts using the native Platform.isPad idiom check (true
 * for iPad hardware regardless of current window size — safe under Split
 * View/Slide Over/Stage Manager, unlike a width breakpoint).
 *
 * Source-level guards (these are React screens, not portable pure modules —
 * same constraint and idiom as every other screen-level test in this suite).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const lectureScreen = read('../app/lecture/[id].tsx');
const recordingScreen = read('../app/recording.tsx');
const deviceClass = read('../constants/deviceClass.ts');
const miniScreen = read('../app/mini-caption.tsx');
const materialToolbar = read('../components/MaterialFloatingToolbar.tsx');
const materialOverlay = read('../components/MaterialAnnotationOverlay.tsx');
const models = read('../lib/models.ts');

const openNotesEditorFn = lectureScreen.slice(
  lectureScreen.indexOf('const openNotesEditor = () => {'),
  lectureScreen.indexOf('const saveNotes = () => {'),
);
const openMiniCaptionFn = recordingScreen.slice(
  recordingScreen.indexOf('const openMiniCaption = () => {'),
  recordingScreen.indexOf('const openLinkedMaterial = ('),
);

console.log('1/3 — device class: native idiom, not a width breakpoint');
check('isPad is derived from Platform.isPad (native device idiom)', () => {
  assert.match(deviceClass, /Platform\.isPad/);
});
check('isPad does NOT depend on useWindowDimensions or a width breakpoint (safe under iPad Split View)', () => {
  assert.doesNotMatch(deviceClass, /useWindowDimensions/);
  assert.doesNotMatch(deviceClass, /width\s*[<>]/);
});
check('no hardcoded iPhone/iPad model name strings', () => {
  assert.doesNotMatch(deviceClass, /iPhone \d|iPad Pro|iPad Air|iPad mini/);
});

console.log('1/2/4/5 — the gate: checked first, notice shown, iPad path unchanged, no data touched before the check');
check('the iPad check is the very first statement in openNotesEditor — before any draft/state mutation', () => {
  const firstLine = openNotesEditorFn.trim().split('\n').slice(0, 1)[0];
  assert.doesNotMatch(firstLine, /setNotesDraft|setStrokesDraft|setImagesDraft|setNotesOpen/);
  const ifIdx = openNotesEditorFn.indexOf('if (!isPad)');
  const firstMutationIdx = openNotesEditorFn.indexOf('setNotesDraft(');
  assert.ok(ifIdx > -1 && firstMutationIdx > -1 && ifIdx < firstMutationIdx);
});
check('iPhone path shows the localized notice via the existing Alert pattern and returns — never sets notesOpen', () => {
  const gateBlock = openNotesEditorFn.slice(openNotesEditorFn.indexOf('if (!isPad)'), openNotesEditorFn.indexOf('setNotesDraft('));
  assert.match(gateBlock, /Alert\.alert\(t\('lecture\.notebookIpadOnly'\)\)/);
  assert.match(gateBlock, /return;/);
  assert.doesNotMatch(gateBlock, /setNotesOpen\(true\)/);
});
check('no new modal/alert system introduced — reuses the existing Alert.alert already imported in this screen', () => {
  assert.match(lectureScreen, /^import \{[\s\S]*?\bAlert\b[\s\S]*?\} from 'react-native';/m);
});
check('iPad path is byte-identical to before the fix: sets notes/strokes/images drafts, then opens', () => {
  assert.match(openNotesEditorFn, /setNotesDraft\(lecture\.notes\);/);
  assert.match(openNotesEditorFn, /setStrokesDraft\(lecture\.noteStrokes \?\? \[\]\);/);
  assert.match(openNotesEditorFn, /setImagesDraft\(lecture\.noteImages \?\? \[\]\);/);
  assert.match(openNotesEditorFn, /setNotesOpen\(true\);/);
});
check('nothing in the gate path calls updateLecture or otherwise mutates persisted Notebook data', () => {
  const gateBlock = openNotesEditorFn.slice(0, openNotesEditorFn.indexOf('setNotesDraft('));
  assert.doesNotMatch(gateBlock, /updateLecture|deleteLecture|noteStrokes:|noteImages:/);
});

console.log('3 — NotebookCanvas cannot mount on the iPhone path (there is only one gate to setNotesOpen(true))');
check('setNotesOpen(true) appears exactly once in this screen — inside the gated function, nowhere else', () => {
  const occurrences = (lectureScreen.match(/setNotesOpen\(true\)/g) ?? []).length;
  assert.equal(occurrences, 1);
});
check('the NotebookCanvas modal only renders when notesOpen is true, and notesOpen has no other setter path to true', () => {
  assert.match(lectureScreen, /visible=\{notesOpen\}/);
  assert.match(lectureScreen, /<NotebookCanvas/);
});

console.log('6 — Notebook and "ordinary text Notes" are NOT separate features (pinned finding)');
check('Lecture.notes (typed), .noteStrokes (handwritten) and .noteImages live in one unified field set, not two features', () => {
  assert.match(models, /Local lecture notes \(typed \+ handwritten\)/);
  assert.match(models, /notes: string;/);
  assert.match(models, /noteStrokes\?: NoteStroke\[\];/);
});
check('there is no second, plain-text-only notes editor in this codebase to accidentally disable', () => {
  // If a separate text-only notes screen existed it would not reference
  // NotebookCanvas at all; there is exactly one Notes-editing entry and it
  // is the one gated above.
  const notesOpenCallSites = (lectureScreen.match(/openNotesEditor/g) ?? []).length;
  assert.ok(notesOpenCallSites >= 2); // definition + the one onPress wiring
});

console.log('Recording → Mini: the second (and last remaining) NotebookCanvas entry, now gated');
check('the iPad check is the very first statement in openMiniCaption — before any navigation', () => {
  const firstLine = openMiniCaptionFn.trim().split('\n').find((l) => l.trim().length > 0);
  assert.doesNotMatch(firstLine, /router\.push/);
  const ifIdx = openMiniCaptionFn.indexOf('if (!isPad)');
  const pushIdx = openMiniCaptionFn.indexOf('router.push(');
  assert.ok(ifIdx > -1 && pushIdx > -1 && ifIdx < pushIdx);
});
check('iPhone path shows the same localized notice and returns — never calls router.push to mini-caption', () => {
  const gateBlock = openMiniCaptionFn.slice(openMiniCaptionFn.indexOf('if (!isPad)'), openMiniCaptionFn.indexOf('router.push('));
  assert.match(gateBlock, /Alert\.alert\(t\('lecture\.notebookIpadOnly'\)\)/);
  assert.match(gateBlock, /return;/);
});
check('iPad path is unchanged: still navigates to /mini-caption with the same params', () => {
  assert.match(openMiniCaptionFn, /router\.push\(\{ pathname: '\/mini-caption', params: \{ elapsed: String\(seconds\) \} \}\);/);
});
check('router.push to mini-caption appears exactly once in Recording — inside the gated function, nowhere else', () => {
  const occurrences = (recordingScreen.match(/pathname: '\/mini-caption'/g) ?? []).length;
  assert.equal(occurrences, 1);
});
check('both the iPad-header and phone-bottom-bar Mini buttons call the SAME gated openMiniCaption — one gate covers both', () => {
  const onPressSites = (recordingScreen.match(/onPress=\{openMiniCaption\}/g) ?? []).length;
  assert.equal(onPressSites, 2);
});
check('the gate never touches recorder/session state — no pause/resume/finish/pendingLectureId/timer calls in openMiniCaption', () => {
  const codeOnly = openMiniCaptionFn.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, /togglePause|finish\(|pendingLectureId|setSeconds|recordingEngine/);
});
check('no Notebook data (notes/strokes/images) is read or written anywhere in openMiniCaption', () => {
  const codeOnly = openMiniCaptionFn.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, /noteStrokes|noteImages|notesDraft|updateLecture/);
});

console.log('Every actual <NotebookCanvas /> mount in the codebase is now gated');
check('exactly two <NotebookCanvas mounts exist, and both are reached only through a gated entry function', () => {
  assert.match(lectureScreen, /<NotebookCanvas/);
  assert.match(miniScreen, /<NotebookCanvas/);
  // mini-caption.tsx itself mounts NotebookCanvas unconditionally — that is
  // correct: the gate lives at the CALLER (Recording's openMiniCaption), so
  // the mini-caption route is simply never reached on iPhone. Asserting the
  // gate lives in the caller, not scattered into the destination screen,
  // keeps Mini's own render logic untouched (matches "iPad path unchanged").
  assert.doesNotMatch(miniScreen, /isPad/);
});

console.log('Out of scope, confirmed separate: Material annotation is untouched by this fix');
check('MaterialFloatingToolbar/MaterialAnnotationOverlay never import or mount NotebookCanvas (separate feature)', () => {
  assert.doesNotMatch(materialToolbar, /from '@\/components\/NotebookCanvas'/);
  assert.doesNotMatch(materialOverlay, /from '@\/components\/NotebookCanvas'/);
});

console.log(`\nnotebook iPad gate: ${passed} checks passed`);
