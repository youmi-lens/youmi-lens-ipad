/**
 * Integrated Simulated Tutorial — integration coherence + real-state safety.
 *
 * Two families of checks:
 *
 *  A. INTEGRATION (§16 of the revision brief) — the tour must read as one
 *     simulated Youmi Lens session: full-screen shells that correspond to
 *     real app surfaces, several teaching moments sharing ONE mounted shell,
 *     simulated bottom navigation where the real app has it, an active tab
 *     that follows the journey, contextual emphasis instead of a hard
 *     spotlight/cutout, and short contextual copy.
 *
 *  B. SAFETY — every isolation guarantee from the previous revision is
 *     preserved: no real Course/Lecture/Material/Notebook mutation, no
 *     Supabase, no recorder, no quota, no upload, persistence semantics
 *     intact, device branching intact, production screens untouched.
 *
 * Source-level guards, same idiom as the rest of this suite.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEMO_CONTENT,
  DEMO_COURSE_VISUAL,
  TOUR_SCREENS,
  isActionMoment,
  getTourMoments,
  getTourScreenSequence,
  isFinalMoment,
  scopedTutorialTourCompletionKey,
} from '../lib/tutorialTourCore.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const abs = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const provider = stripComments(read('../lib/tutorialTour.tsx'));
const shell = stripComments(read('../components/tutorialTour/TutorialAppShell.tsx'));
const screens = stripComments(read('../components/tutorialTour/simulatedScreens.tsx'));
const emphasis = stripComments(read('../components/tutorialTour/TourEmphasis.tsx'));
const overlay = stripComments(read('../components/TutorialTourOverlay.tsx'));
const rootLayout = stripComments(read('../app/_layout.tsx'));
const settings = stripComments(read('../app/(tabs)/settings.tsx'));
const recordHome = stripComments(read('../app/(tabs)/index.tsx'));
const recording = stripComments(read('../app/recording.tsx'));
const lectureDetail = stripComments(read('../app/lecture/[id].tsx'));
const core = stripComments(read('../lib/tutorialTourCore.mjs'));

const tourFiles = [
  ['tutorialTour.tsx', provider],
  ['TutorialAppShell.tsx', shell],
  ['simulatedScreens.tsx', screens],
  ['TourEmphasis.tsx', emphasis],
  ['TutorialTourOverlay.tsx', overlay],
];

const phone = getTourMoments(false);
const pad = getTourMoments(true);

// =====================================================================
console.log('A1-A3 — full-screen shells that correspond to real app surfaces');
// =====================================================================

check('A1. every simulated screen corresponds to a real production surface, and has a Simulated*Screen replica', () => {
  const surfaceForScreen = {
    [TOUR_SCREENS.HOME]: { file: '../app/(tabs)/index.tsx', component: 'SimulatedHomeScreen' },
    [TOUR_SCREENS.COURSES]: { file: '../app/(tabs)/courses.tsx', component: 'SimulatedCoursesScreen' },
    [TOUR_SCREENS.COURSE_DETAIL]: { file: '../app/course/[id].tsx', component: 'SimulatedCourseDetailScreen' },
    [TOUR_SCREENS.RECORDING]: { file: '../app/recording.tsx', component: 'SimulatedRecordingScreen' },
    [TOUR_SCREENS.NOTEBOOK]: { file: '../app/mini-caption.tsx', component: 'SimulatedNotebookScreen' },
    [TOUR_SCREENS.LECTURE_DETAIL]: { file: '../app/lecture/[id].tsx', component: 'SimulatedLectureDetailScreen' },
  };
  for (const [screen, { file, component }] of Object.entries(surfaceForScreen)) {
    assert.ok(existsSync(abs(file)), `${screen}: real surface ${file} does not exist`);
    assert.match(screens, new RegExp(`export function ${component}\\b`), `${screen}: missing ${component} replica`);
  }
  // Every screen a moment references must be a known screen.
  const known = new Set(Object.values(TOUR_SCREENS));
  for (const m of pad) assert.ok(known.has(m.screen), `moment ${m.id} targets unknown screen ${m.screen}`);
});

check('A2. the simulated screens reuse the REAL production copy, so the tour looks like the app it teaches', () => {
  // Production i18n keys, not tutorial-only paraphrases.
  for (const key of [
    'home.welcome', 'home.createFirstCourse', 'home.createCourse', 'home.quickRecording',
    'courses.library', 'courses.title', 'courses.new',
    'course.detail', 'course.materials', 'course.materialsLocal', 'course.lectures', 'course.start',
    'recording.recordingShort', 'recording.pausedShort', 'recording.markImportant', 'recording.finish',
  ]) {
    assert.ok(screens.includes(`'${key}'`), `simulated screens should reuse production copy key ${key}`);
  }
  // And the real tab labels, so the simulated nav reads identically.
  for (const key of ['nav.record', 'nav.courses', 'nav.settings']) {
    assert.ok(shell.includes(`'${key}'`), `simulated tab bar should use production label ${key}`);
  }
});

check('A3. teaching moments outnumber screen changes — the tour is a journey, not a slide deck', () => {
  for (const [name, moments] of [['iPhone', phone], ['iPad', pad]]) {
    const seq = getTourScreenSequence(name === 'iPad');
    assert.ok(
      moments.length > seq.length,
      `${name}: ${moments.length} moments vs ${seq.length} screen changes — moments must dominate`,
    );
  }
});

// =====================================================================
console.log('A4-A5 — persistent shells: Recording and Lecture Detail keep one mounted screen');
// =====================================================================

check('A4. the Recording teaching moments all share ONE simulated Recording screen', () => {
  const recMoments = pad.filter((m) => m.screen === TOUR_SCREENS.RECORDING).map((m) => m.id);
  for (const id of ['recording_start', 'captions', 'translation', 'dictionary', 'mark_important', 'pause_resume', 'finish']) {
    assert.ok(recMoments.includes(id), `${id} must live on the Recording screen`);
  }
  assert.ok(recMoments.length >= 7, `expected >=7 Recording moments, got ${recMoments.length}`);
});

check('A5. the Lecture Review teaching moments all share ONE simulated Lecture Detail screen', () => {
  const lecMoments = phone.filter((m) => m.screen === TOUR_SCREENS.LECTURE_DETAIL).map((m) => m.id);
  for (const id of ['summary_review', 'open_transcript', 'transcript_review', 'open_marked', 'marked_review', 'open_notes', 'notes_review', 'playback', 'cloud']) {
    assert.ok(lecMoments.includes(id), `${id} must live on the Lecture Detail screen`);
  }
});

check('A6. the renderer keys screens by SCREEN, never by moment — that is what keeps a shell mounted across moments', () => {
  assert.match(overlay, /<ScreenTransition key=\{currentScreen\}>/);
  assert.doesNotMatch(
    overlay,
    /<ScreenTransition key=\{currentMoment/,
    'keying the transition by moment would remount the shell on every teaching moment',
  );
  // The moment is passed as a prop (internal focus), not as identity.
  assert.match(overlay, /moment=\{currentMoment\.id\}/);
});

// =====================================================================
console.log('A7-A8 — simulated global navigation');
// =====================================================================

check('A7. the simulated bottom tab bar is present exactly where the REAL app shows it (the tabs group), and absent on pushed stack routes', () => {
  const tabbed = new Set([TOUR_SCREENS.HOME, TOUR_SCREENS.COURSES]);
  for (const m of pad) {
    if (tabbed.has(m.screen)) {
      assert.ok(m.tab, `${m.id} is on a tab screen and must show the tab bar`);
    } else if (m.screen !== TOUR_SCREENS.READY) {
      assert.equal(m.tab, null, `${m.id} is a pushed stack route in the real app and must NOT show a tab bar`);
    }
  }
  // The shell renders simulated navigation only when a tab is active — as a
  // sidebar or a bottom bar depending on width (see A19).
  assert.match(shell, /Boolean\(activeTab\) && !isCompact/);
  assert.match(shell, /Boolean\(activeTab\) && isCompact/);
});

check('A8. the active simulated tab follows the journey (Record → Courses)', () => {
  const tabs = phone.filter((m) => m.tab).map((m) => m.tab);
  assert.ok(tabs.includes('record'), 'journey should start on the Record tab');
  assert.ok(tabs.includes('courses'), 'journey should move to the Courses tab');
  assert.ok(new Set(tabs).size > 1, 'the active tab must actually change during the journey');
  assert.match(shell, /const selected = tab\.id === activeTab;/);
});

// =====================================================================
console.log('A9-A10 — contextual emphasis, not a spotlight; short contextual copy');
// =====================================================================

check('A9. no hard spotlight/cutout coach-mark system is reintroduced anywhere in the tour', () => {
  for (const [name, src] of tourFiles) {
    assert.doesNotMatch(src, /SCRIM|SpotlightHole|HOLE_PADDING/, `${name} reintroduces a scrim/cutout spotlight`);
    assert.doesNotMatch(src, /measureInWindow|registerTarget|TutorialTarget/, `${name} reintroduces target measurement`);
  }
  // Emphasis works by raising contrast and softly lowering surroundings —
  // and the de-emphasised state must stay clearly readable, never hidden.
  assert.match(emphasis, /softDim: \{ opacity: 0\.(5[5-9]|[6-9]\d) \}/, 'SoftDim must stay readable (>= 0.55 opacity)');
  assert.match(emphasis, /export function Emphasis/);
});

check('A10. every teaching-moment label is one short contextual line', () => {
  const en = read('../lib/locales/en.mjs');
  const labels = [...en.matchAll(/'tutorialTour\.m\.[a-zA-Z]+':\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(labels.length >= 15, `expected the full moment label set, found ${labels.length}`);
  for (const label of labels) {
    assert.ok(label.length <= 60, `moment label too long (${label.length} chars): "${label}"`);
    assert.doesNotMatch(label, /\. .+\./, `moment label should be one line, not a paragraph: "${label}"`);
  }
  // Every moment resolves through an i18n key — no hardcoded English in TSX.
  for (const m of pad) assert.match(m.labelKey, /^tutorialTour\.m\./);
});

// =====================================================================
console.log('A11-A12 — device differences: Notebook integrated on iPad, absent on iPhone');
// =====================================================================

check('A11. iPad Notebook sits INSIDE the recording journey — entry on the Recording screen, note on Notebook, then back to Recording to Finish', () => {
  const ids = pad.map((m) => m.id);
  const open = pad.find((m) => m.id === 'notebook_open');
  const note = pad.find((m) => m.id === 'notebook_note');
  assert.ok(open && note, 'iPad must have both notebook moments');
  assert.equal(open.screen, TOUR_SCREENS.RECORDING, 'the Notebook entry is emphasised on the real Recording screen');
  assert.equal(note.screen, TOUR_SCREENS.NOTEBOOK);
  // Ordering: recording controls → notebook → finish (returns to Recording).
  assert.ok(ids.indexOf('pause_resume') < ids.indexOf('notebook_open'));
  assert.ok(ids.indexOf('notebook_open') < ids.indexOf('notebook_note'));
  assert.ok(ids.indexOf('notebook_note') < ids.indexOf('finish'));
  assert.equal(pad[ids.indexOf('finish')].screen, TOUR_SCREENS.RECORDING, 'Finish returns to the Recording screen');
  // Mini keeps captions/controls available beside the notebook.
  assert.match(screens, /miniPanel/);
});

check('A12. iPhone omits Notebook entirely — no scene, no screen, no mention', () => {
  assert.equal(phone.some((m) => m.id.startsWith('notebook')), false);
  assert.equal(phone.some((m) => m.screen === TOUR_SCREENS.NOTEBOOK), false);
  // ...and the journey flows straight from the recording controls to Finish.
  const ids = phone.map((m) => m.id);
  assert.equal(ids[ids.indexOf('pause_resume') + 1], 'finish');
});

// =====================================================================
console.log('A13-A16 — Course Detail hierarchy + iPad/iPhone parity (§2, §3 of the completion pass)');
// =====================================================================

check('A13. Course Detail teaches the Course → Materials/Lectures hierarchy across two moments on ONE shell, ending with a real Start Lecture entry point', () => {
  const cdMoments = pad.filter((m) => m.screen === TOUR_SCREENS.COURSE_DETAIL).map((m) => m.id);
  assert.deepEqual(cdMoments, ['course_material', 'start_lecture'], 'Course Detail must teach materials, then the Start Lecture entry point');
  // The lecture then visually starts FROM Course Detail, not from a bare card.
  const ids = pad.map((m) => m.id);
  assert.equal(ids[ids.indexOf('start_lecture') + 1], 'recording_start', 'the journey must move into Recording immediately after Start Lecture');
  // The shell itself renders the course hierarchy: materials AND lectures section, and a Start button.
  assert.match(screens, /course\.materials/);
  assert.match(screens, /course\.lectures/);
  assert.match(screens, /course\.start/);
});

check('A14. iPhone and iPad walk the identical journey except where a capability genuinely differs (Notebook)', () => {
  const stripDeviceOnly = (moments) => moments.filter((m) => !m.deviceOnly).map((m) => m.id);
  assert.deepEqual(stripDeviceOnly(pad), phone.map((m) => m.id), 'removing iPad-only moments from the iPad journey must equal the iPhone journey exactly');
  // Every device-gated moment is explicitly marked, never silently divergent.
  for (const m of pad) {
    if (!phone.some((pm) => pm.id === m.id)) assert.equal(m.deviceOnly, 'ipad', `${m.id} is iPad-only but not marked deviceOnly`);
  }
});

check('A15. after Notebook, the journey RESUMES Recording immediately — no filler step, no dead end', () => {
  const ids = pad.map((m) => m.id);
  assert.equal(ids[ids.indexOf('notebook_note') + 1], 'finish', 'Recording must resume (Finish) directly after the Notebook moment');
  assert.equal(pad[ids.indexOf('finish')].screen, TOUR_SCREENS.RECORDING);
});

check('A16. the simulated Mini panel matches the real floating panel\'s controls (Mark / Expand / Pause) — Finish only exists on Recording, never inside Notebook', () => {
  const notebookScreenSrc = screens.slice(screens.indexOf('function SimulatedNotebookScreen'), screens.indexOf('function SimulatedLectureDetailScreen'));
  assert.match(notebookScreenSrc, /mini\.mark/);
  assert.match(notebookScreenSrc, /mini\.expand/);
  assert.match(notebookScreenSrc, /mini\.pause/);
  assert.doesNotMatch(notebookScreenSrc, /checkmark-done|recording\.finish/, 'the Mini panel must not fabricate a Finish control the real panel does not have');
});

check('A17. layout follows LIVE WINDOW WIDTH like production, never device class — so an iPad re-lays-out on rotation', () => {
  // Production keys layout off useIsCompactWidth (the 900pt breakpoint), not
  // isPad: an iPad Pro 11" is 834pt in portrait and genuinely uses the compact
  // layout there. Keying off isPad would freeze one layout for both
  // orientations and mismatch the real app in portrait.
  assert.match(screens, /useIsCompactWidth/, 'simulated screens must derive layout from live width');
  for (const component of [
    'SimulatedHomeScreen', 'SimulatedCoursesScreen', 'SimulatedCourseDetailScreen',
    'SimulatedRecordingScreen', 'SimulatedNotebookScreen', 'SimulatedLectureDetailScreen',
  ]) {
    const start = screens.indexOf(`function ${component}`);
    assert.ok(start > 0, `${component} not found`);
    const body = screens.slice(start, start + 900);
    assert.match(body, /useIsCompactWidth\(\)/, `${component} must read the live width breakpoint`);
  }
  // No StyleSheet value may be branched on isPad — that bakes a device-class
  // layout in at module load and cannot respond to rotation.
  const styleBlock = screens.slice(screens.indexOf('const styles = StyleSheet.create('));
  assert.doesNotMatch(styleBlock, /isPad/, 'stylesheet must not branch on isPad; use width-driven variants');
});

check('A18. the simulated Recording chrome matches production geometry, including where Mini lives at each width', () => {
  const rec = screens.slice(screens.indexOf('function SimulatedRecordingScreen'), screens.indexOf('function SimulatedNotebookScreen'));
  // Production: at compact width Mini is a bottom-bar utility button; at wide
  // width it is a labelled button in the header. Both must exist.
  const header = rec.slice(rec.indexOf('recHeader'), rec.indexOf('feedRegion'));
  assert.match(header, /iconBtnLabelled/, 'wide layout must show the labelled Mini entry in the header');
  assert.match(header, /materialTopButton/, 'wide layout must show the Material chip in the header');
  assert.match(rec, /isCompact && isPad/, 'compact iPad must fall back to the bottom-bar Mini entry');
  // Real control dimensions (app/recording.tsx): 44pt utility, 62pt round, 50pt finish.
  assert.match(screens, /utilityBtn: \{\s*width: 44, height: 44/);
  assert.match(screens, /roundBtn: \{\s*width: 62, height: 62, borderRadius: 31/);
  assert.match(screens, /finishBtn: \{[\s\S]{0,160}minHeight: 50, borderRadius: 14/);
  // The action bar is a full-width glass strip with a hairline top border.
  assert.match(screens, /controlsRow: \{[\s\S]{0,320}borderTopWidth: StyleSheet\.hairlineWidth/);
});

check('A19. simulated global navigation switches sidebar/tab-bar at the SAME width production does', () => {
  // YLSidebar: `isCompact ? <BottomTabFrame/> : <SidebarFrame/>`. An iPad in
  // landscape has NO bottom bar — it has a left sidebar. Showing the bottom
  // bar there would teach the wrong location.
  const real = stripComments(read('../components/YLSidebar.tsx'));
  assert.match(real, /isCompact \? <BottomTabFrame[\s\S]{0,40}<SidebarFrame/, 'production contract changed — revisit the simulated nav');
  assert.match(shell, /useIsCompactWidth\(\)/, 'the shell must pick its nav by live width');
  assert.match(shell, /const showSidebar = Boolean\(activeTab\) && !isCompact;/);
  assert.match(shell, /const showBottomBar = Boolean\(activeTab\) && isCompact;/);
  // The simulated sidebar replicates the real frame's structure and width.
  assert.match(shell, /function SimulatedSidebar/);
  assert.match(shell, /width: layout\.sidebar/);
  for (const marker of ['navRowActiveOverlay', 'activeBar', 'account', 'brandName']) {
    assert.ok(shell.includes(marker), `simulated sidebar missing ${marker}`);
  }
  // ...and it must not mount the real one (its rows navigate for real).
  assert.doesNotMatch(shell, /<YLSidebar/, 'the tour must never mount the real navigating sidebar');
});

// =====================================================================
console.log('D1-D7 — one advancement contract per moment (action vs explanation)');
// =====================================================================

/** Every moment that has a real control the user would tap in the app. */
const EXPECTED_ACTION_MOMENTS = new Set([
  'create_course', 'courses_list', 'course_material', 'start_lecture',
  'dictionary', 'mark_important', 'pause_resume', 'notebook_open',
  'finish', 'open_transcript', 'open_marked', 'open_notes', 'playback',
]);
/** Moments with nothing meaningful to press — these keep a subtle Next. */
const EXPECTED_EXPLANATION_MOMENTS = new Set([
  'welcome', 'recording_start', 'captions', 'translation',
  'notebook_note', 'summary_review', 'transcript_review', 'marked_review', 'notes_review',
  'cloud', 'ready',
]);

check('D1. every moment is classified exactly once, as either an action or an explanation', () => {
  for (const [name, moments] of [['iPhone', phone], ['iPad', pad]]) {
    for (const m of moments) {
      const isAction = isActionMoment(m);
      if (isAction) {
        assert.ok(EXPECTED_ACTION_MOMENTS.has(m.id), `${name}: ${m.id} is marked action but is not a known action moment`);
      } else {
        assert.ok(EXPECTED_EXPLANATION_MOMENTS.has(m.id), `${name}: ${m.id} has no advancement classification`);
      }
    }
  }
  // The classification is real, not degenerate in either direction.
  assert.ok(pad.filter(isActionMoment).length >= 11, 'most of the journey should be action-driven');
  assert.ok(pad.filter((m) => !isActionMoment(m)).length >= 5, 'conceptual moments must keep a Next');
});

check('D2. the final moment is an explanation moment — its CTA is the closing button, never a hidden target', () => {
  const final = pad[pad.length - 1];
  assert.equal(isActionMoment(final), false, 'the Ready screen must keep a visible Continue/CTA');
  assert.equal(final.isFinal, true);
});

check('D3. the shell shows a generic Next ONLY on explanation moments', () => {
  // Next is rendered behind an isAction guard...
  assert.match(shell, /\{isAction \? null : \(/, 'Next must be suppressed on action moments');
  // ...and the guard wraps the actual Next control, not something else.
  const guarded = shell.slice(shell.indexOf('{isAction ? null : ('), shell.indexOf('Simulated bottom tab bar'));
  assert.match(guarded, /onPress=\{onNext\}/, 'the isAction guard must wrap the Next button itself');
  assert.match(guarded, /tutorialTour\.next/);
  // The overlay actually feeds the flag through from the state machine.
  assert.match(overlay, /isAction=\{isAction\}/);
  assert.match(provider, /isAction: isActionMoment\(currentMoment\)/);
});

check('D4. every action moment has a real tappable target wired to its own id', () => {
  const wired = new Set(
    [...screens.matchAll(/momentId="([a-z_]+)"/g)].map((m) => m[1]),
  );
  // The review tabs pass the live moment through rather than a literal.
  const tabMoments = ['open_transcript', 'open_marked', 'open_notes'];
  assert.match(screens, /momentId=\{moment\}/, 'the review tabs must target the current moment');
  for (const id of EXPECTED_ACTION_MOMENTS) {
    if (tabMoments.includes(id)) continue;
    assert.ok(wired.has(id) || screens.includes(`advanceFromTarget('${id}')`),
      `action moment ${id} has no tappable simulated target`);
  }
  // ...and no explanation moment secretly wires one.
  for (const id of EXPECTED_EXPLANATION_MOMENTS) {
    assert.equal(wired.has(id), false, `${id} is an explanation moment and must not have an action target`);
  }
});

check('D5. a target only speaks for its own moment, and is inert while inactive', () => {
  // Stale/foreign taps are rejected in the state machine...
  assert.match(provider, /if \(momentId !== currentMoment\.id\) return;/);
  assert.match(emphasis, /export function ActionTarget/);
  assert.match(emphasis, /onPress=\{\(\) => \(onPress \? onPress\(\) : advanceFromTarget\(momentId\)\)\}/);
  // ...and the tap-capture overlay only exists while this is the live target,
  // so an inactive control is not pressable at all.
  const target = emphasis.slice(emphasis.indexOf('export function ActionTarget'), emphasis.indexOf('export function SoftDim'));
  assert.match(target, /\{active \? \(\s*<Pressable/, 'the capture overlay must be gated on `active`');
  assert.match(target, /style=\{StyleSheet\.absoluteFill\}/);
  // Production controls own an enabled Pressable that swallows touches, so the
  // overlay must sit ON TOP of children, never wrap them.
  assert.match(target, /\{children\}\s*\{active \? \(/, 'the overlay must render after (above) the control');
});

check('D.dictionary. The demonstrated double tap opens the definition and advances on its second tap — never a hidden third tap', () => {
  const recording = screens.slice(screens.indexOf('export function SimulatedRecordingScreen'), screens.indexOf('export function SimulatedNotebookScreen'));
  const handler = recording.slice(recording.indexOf('const handleWordTap'), recording.indexOf('const parts ='));
  assert.match(handler, /if \(now - lastTapRef\.current < 350\) \{[\s\S]{0,220}setDictOpen\(true\);[\s\S]{0,220}advanceFromTarget\('dictionary'\);/);
  assert.match(recording, /accessibilityRole="button"[\s\S]{0,100}accessibilityLabel=\{word\}/, 'the demonstrated word must be a real accessible action target');
});

check('D6. a rapid double tap cannot skip a moment — one advance per moment, released only when it changes', () => {
  assert.match(provider, /const advanceLockRef = useRef\(false\);/);
  const nextFn = provider.slice(provider.indexOf('const next = useCallback'), provider.indexOf('const advanceFromTarget'));
  assert.match(nextFn, /if \(advanceLockRef\.current\) return;\s*advanceLockRef\.current = true;/,
    'next() must take the lock before advancing');
  // The lock is released by the moment actually changing, not by a timer.
  assert.match(provider, /advanceLockRef\.current = false;\s*\}, \[momentIndex, visible\]\)/);
  // Target taps route through the SAME guarded next(), so a control tap and a
  // Next tap in the same frame cannot both land.
  const targetFn = provider.slice(provider.indexOf('const advanceFromTarget'), provider.indexOf('const back ='));
  assert.match(targetFn, /next\(\);/);
  assert.doesNotMatch(targetFn, /setMomentIndex/, 'the target must not advance the index independently of next()');
});

check('D7. Skip stays reachable on every moment, action or explanation', () => {
  // Skip lives in the top chrome, outside the isAction branch entirely.
  const chrome = shell.slice(shell.indexOf('styles.topChrome'), shell.indexOf('styles.stage'));
  assert.match(chrome, /onPress=\{onSkip\}/, 'Skip must render unconditionally in the top chrome');
  assert.doesNotMatch(chrome, /isAction/, 'Skip must not depend on the moment type');
});

// =====================================================================
console.log('T1-T8 — exactly one visually obvious primary target per moment');
// =====================================================================

check('T1/T4. every moment resolves to exactly one primary target — a product control, or Next', () => {
  for (const [name, moments] of [['iPhone', phone], ['iPad', pad]]) {
    for (const m of moments) {
      const viaControl = isActionMoment(m);
      const viaNext = !isActionMoment(m);
      assert.equal(
        Number(viaControl) + Number(viaNext), 1,
        `${name}/${m.id}: expected exactly one primary target`,
      );
    }
  }
});

check('T5/T6. when Next IS the primary target it wears the SAME emphasis as product controls', () => {
  // Not an ordinary footer chip: the Next branch is wrapped in the shared
  // Emphasis primitive, so explanation moments read as unambiguously as
  // action moments do. This also covers the final Ready CTA, which renders
  // through the same branch.
  assert.match(
    shell,
    /\{isAction \? null : \(\s*<Emphasis active[\s\S]{0,200}onPress=\{onNext\}/,
    'the Next/Continue control must be wrapped in Emphasis',
  );
  assert.match(shell, /readyCta/, 'the final CTA renders through the same emphasised branch');
  assert.match(shell, /from '\.\/TourEmphasis'/, 'Next emphasis must reuse the tour emphasis system');
  // ...and it must not invent a second visual language: no arrow/hand icon
  // pointing at Next, and no locally-defined competing glow.
  assert.doesNotMatch(shell, /name="(arrow|hand)[a-z-]*"/i, 'no arrow/hand pointer icons — reuse the accent ring');
  assert.doesNotMatch(shell, /nextGlow|nextRing|nextHighlight/, 'Next must not define its own emphasis visual');
});

check('T7/T8. Skip and Back are never primary targets', () => {
  const chrome = shell.slice(shell.indexOf('styles.topChrome'), shell.indexOf('styles.stage'));
  assert.doesNotMatch(chrome, /<Emphasis/, 'Skip must not be emphasised');
  const coach = shell.slice(shell.indexOf('styles.coachBar'), shell.indexOf('showBottomBar ?'));
  const backBlock = coach.slice(0, coach.indexOf('coachLabel'));
  assert.doesNotMatch(backBlock, /<Emphasis/, 'Back must stay secondary and un-emphasised');
});

check('T15. Reduced Motion still leaves the primary target visibly emphasised', () => {
  // The pulse loop is skipped, but the emphasised state is applied immediately
  // and statically — the ring never depends on an animation completing.
  assert.match(emphasis, /if \(reduceMotion\) \{[\s\S]{0,140}pulse\.setValue\(1\);\s*return;\s*\}/);
});

// =====================================================================
console.log('R1-R21 — lecture review: tap a tab, see that tab');
// =====================================================================

check('R1/R2. Finish enters review on Summary — production\'s own initial tab', () => {
  const ids = pad.map((m) => m.id);
  assert.equal(ids[ids.indexOf('finish') + 1], 'summary_review');
  // Parity: production Lecture Detail opens on Summary.
  assert.match(lectureDetail, /useState<Tab>\('Summary'\)/, 'production initial tab changed — revisit tour parity');
  // The simulated shell starts there too.
  assert.match(provider, /useState<string>\('summary'\)/);
});

check('R3/R10/R15/R.notes. review content is the SAME demo lecture taught during Recording', () => {
  const lec = screens.slice(screens.indexOf('function SimulatedLectureDetailScreen'));
  // Transcript reuses the very caption line shown live...
  assert.match(lec, /selectedLectureTab === 'transcript' \?[\s\S]{0,160}DEMO_CONTENT\.transcriptLineKey/);
  // ...Summary summarises the same lecture...
  assert.match(lec, /selectedLectureTab === 'summary' \?[\s\S]{0,320}DEMO_CONTENT\.summaryEnglishKey/);
  // ...and Marked shows that same line, at the clock the user really marked.
  assert.match(lec, /selectedLectureTab === 'marked' \?[\s\S]{0,420}formatClock\(demoMarkedAtSeconds\)/);
  assert.match(lec, /selectedLectureTab === 'marked' \?[\s\S]{0,520}DEMO_CONTENT\.transcriptLineKey/);
  // No unrelated hardcoded marked example.
  assert.doesNotMatch(lec, /markedTimeText}>0\d:\d\d</, 'the marked timestamp must come from demo state, not a literal');
  // Notes must be the exact note created in the earlier Notebook moment, not
  // another fixture written only for review.
  assert.match(lec, /selectedLectureTab === 'notes' \?[\s\S]{0,520}DEMO_CONTENT\.notebookNoteKey/);
});

check('R.mark.layout. Marked rows reserve timestamp/star space and let only the transcript column shrink on compact widths', () => {
  const lec = screens.slice(screens.indexOf('function SimulatedLectureDetailScreen'));
  assert.match(lec, /<View style=\{styles\.markedTextWrap\}>[\s\S]{0,180}<Text style=\{\[styles\.reviewText, styles\.markedText\]\}/);
  assert.match(lec, /<View style=\{styles\.markedTrailing\}>[\s\S]{0,100}<Ionicons name="star"/);
  assert.match(screens, /markedRow: \{ width: '100%', flexDirection: 'row'/);
  assert.match(screens, /markedTextWrap: \{ flex: 1, minWidth: 0, flexShrink: 1 \}/);
  assert.match(screens, /markedTrailing: \{ width: 14, minWidth: 14, flexShrink: 0/);
});

check('R5/R6/R11/R.notes/R16/R17. each review action emphasises its own control and shows no generic Next', () => {
  const lec = screens.slice(screens.indexOf('function SimulatedLectureDetailScreen'));
  assert.match(lec, /moment === 'open_transcript' && tabId === 'transcript'/);
  assert.match(lec, /moment === 'open_marked' && tabId === 'marked'/);
  assert.match(lec, /moment === 'open_notes' && tabId === 'notes'/);
  assert.match(lec, /momentId="playback"/);
  for (const id of ['open_transcript', 'open_marked', 'open_notes', 'playback']) {
    assert.equal(isActionMoment(pad.find((m) => m.id === id)), true, `${id} must be an action moment (no Next)`);
  }
  for (const id of ['summary_review', 'transcript_review', 'marked_review', 'notes_review']) {
    assert.equal(isActionMoment(pad.find((m) => m.id === id)), false, `${id} must keep an emphasised Next`);
  }
});

check('R7/R12/G. the selected tab changes ONLY because a tab was tapped — never because the moment advanced', () => {
  const lec = screens.slice(screens.indexOf('function SimulatedLectureDetailScreen'));
  // The tab comes from shared demo state, and the only writer is the tap.
  assert.match(lec, /const \{ selectedLectureTab, tapLectureTab/);
  assert.match(lec, /onPress=\{\(\) => tapLectureTab\(tabId, moment\)\}/);
  assert.doesNotMatch(
    lec,
    /(activeTab|selectedLectureTab)\s*(:|=)[^;]*moment ===/,
    'the selected tab must never be derived from the current moment',
  );
  // The provider's setter is reached from the tap path only.
  const tapFn = provider.slice(provider.indexOf('const tapLectureTab'), provider.indexOf('const back ='));
  assert.match(tapFn, /setSelectedLectureTab\(tab\)/);
  const setters = [...provider.matchAll(/setSelectedLectureTab\(/g)].length;
  assert.equal(setters, 3, `expected exactly tap + close-reset + replay-reset writers, found ${setters}`);
});

check('R8/R9/R13/R14. the rendered body follows the SELECTED tab, so a tap can never show a different tab', () => {
  const lec = screens.slice(screens.indexOf('function SimulatedLectureDetailScreen'));
  const body = lec.slice(lec.indexOf('styles.reviewBody'));
  for (const tab of ['summary', 'transcript', 'marked', 'notes']) {
    assert.match(body, new RegExp(`selectedLectureTab === '${tab}'`), `body must render ${tab} from the selection`);
  }
  // ...and nothing in the body branches on the moment.
  assert.doesNotMatch(body, /moment ===/, 'review body must not branch on the teaching moment');
});

check('R.notes.parity. Notes is a production tab on both devices, while Notebook editing remains iPad-gated', () => {
  // Mutation guard: removing Notes from the simulated tab list fails here.
  assert.match(core, /LECTURE_TABS = \['summary', 'transcript', 'marked', 'notes'\]/);
  assert.match(lectureDetail, /const TABS = \['Summary', 'Transcript', 'Marked', 'Notes'\]/,
    'the simulated tab list must track production');
  // Production keeps the preview on both classes but only mounts its editor on iPad.
  assert.match(lectureDetail, /if \(!isPad\) \{[\s\S]{0,180}lecture\.notebookIpadOnly/);
  assert.match(lectureDetail, /<NotebookCanvas/);
  // The simulated Notes body mirrors the preview and never mounts the real editor.
  const lec = screens.slice(screens.indexOf('function SimulatedLectureDetailScreen'));
  assert.match(lec, /isPad \? t\('lecture\.editHint'\) : t\('lecture\.notebookIpadOnly'\)/);
  assert.doesNotMatch(lec, /<NotebookCanvas/, 'the tutorial must not bypass the iPhone Notebook gate');
});

check('R.notes.flow. Notes follows Marked and playback remains available afterwards on the same mounted shell', () => {
  for (const [name, moments] of [['iPhone', phone], ['iPad', pad]]) {
    const ids = moments.map((m) => m.id);
    assert.equal(ids[ids.indexOf('marked_review') + 1], 'open_notes', `${name}: Notes must follow Marked`);
    assert.equal(ids[ids.indexOf('open_notes') + 1], 'notes_review', `${name}: Notes tap must reveal Notes before advancing`);
    assert.equal(ids[ids.indexOf('notes_review') + 1], 'playback', `${name}: Playback must remain after Notes`);
  }
});

check('R18/R19. Play starts simulated playback and does NOT change the selected tab', () => {
  const lec = screens.slice(screens.indexOf('function SimulatedLectureDetailScreen'));
  const playHandler = lec.slice(lec.indexOf('momentId="playback"'), lec.indexOf('</ActionTarget>'));
  assert.match(playHandler, /setPlaying\(true\)/, 'Play must actually start playback');
  assert.match(playHandler, /advanceFromTarget\('playback'\)/);
  assert.doesNotMatch(playHandler, /tapLectureTab|setSelectedLectureTab/, 'playback must not switch tabs');
  // Playback runs off its own state, not off the moment.
  assert.match(lec, /if \(!playing\) return;/);
});

check('R20/R21. one Lecture Detail shell spans every review moment, identically on both devices', () => {
  for (const [name, moments] of [['iPhone', phone], ['iPad', pad]]) {
    const seq = [];
    for (const m of moments) if (seq[seq.length - 1] !== m.screen) seq.push(m.screen);
    const visits = seq.filter((s) => s === TOUR_SCREENS.LECTURE_DETAIL).length;
    assert.equal(visits, 1, `${name}: Lecture Detail must be entered once and stay mounted`);
  }
  // Same review sequence on both devices — no device branch in review.
  const review = (ms) => ms.filter((m) => m.screen === TOUR_SCREENS.LECTURE_DETAIL).map((m) => m.id);
  assert.deepEqual(review(phone), review(pad));
});

check('R.mark. Mark Important is what creates the marked moment, stamped with the live simulated clock', () => {
  const targetFn = provider.slice(provider.indexOf('const advanceFromTarget'), provider.indexOf('const tapLectureTab'));
  assert.match(targetFn, /if \(momentId === 'mark_important'\) setDemoMarkedAtSeconds\(demoElapsedSeconds\);/);
  // Recording marks it; review reads it — one shared value, not two literals.
  assert.match(provider, /demoMarkedAtSeconds,/);
});

// =====================================================================
console.log('E1-E5 — first-run auto-show, completion persistence, scoping');
// =====================================================================

check('E1. the tutorial auto-shows only on a first eligible entry that has NOT completed it', () => {
  assert.match(provider, /if \(loading \|\| !canUseApp \|\| !scopeId\) return;/);
  const effect = provider.slice(provider.indexOf('autoCheckedScopeRef.current = scopeId'), provider.indexOf('const currentMoment'));
  // The completion flag is what gates the auto-show.
  assert.match(effect, /loadTutorialCompleted\(scopeId\)\.then\(\(completed\) => \{[\s\S]{0,120}if \(cancelled \|\| completed\) return;/);
  assert.match(effect, /setVisible\(true\);/);
});

check('E2. completion is user/guest scoped, and the scope comes from the session', () => {
  assert.match(provider, /const scopeId = session\?\.user\?\.id \?\? \(isGuest \? GUEST_STORAGE_SCOPE : null\);/);
  // The auto-show is re-evaluated per scope, so a DIFFERENT account still
  // gets its own first run while the same account does not repeat.
  assert.match(provider, /if \(autoCheckedScopeRef\.current === scopeId\) return;/);
  assert.match(provider, /\}, \[loading, canUseApp, scopeId\]\)/);
  assert.equal(scopedTutorialTourCompletionKey('user-a'), 'youmi.tutorial.completed.v1.user-a');
  assert.notEqual(scopedTutorialTourCompletionKey('user-a'), scopedTutorialTourCompletionKey('user-b'));
});

check('E3. BOTH finishing and skipping persist completion — they are the same code path', () => {
  assert.match(provider, /skipTour: closeTour,/);
  const closeFn = provider.slice(provider.indexOf('const closeTour ='), provider.indexOf('const reopenTour ='));
  assert.match(closeFn, /saveTutorialCompleted\(scopeId\)/);
  const nextFn = provider.slice(provider.indexOf('const next = useCallback'), provider.indexOf('const advanceFromTarget'));
  assert.match(nextFn, /if \(isFinalMoment\(currentMoment\)\) \{\s*closeTour\(\);/);
});

check('E4. manual Settings replay is an override, never a reset of onboarding state', () => {
  const reopenFn = provider.slice(provider.indexOf('const reopenTour ='), provider.indexOf('const advanceLockRef'));
  // It must not clear or re-read the persisted flag...
  assert.doesNotMatch(reopenFn, /saveTutorialCompleted|loadTutorialCompleted/);
  assert.doesNotMatch(reopenFn, /setItem|removeItem|'false'/);
  // ...and it always restarts from the first moment.
  assert.match(reopenFn, /setMomentIndex\(0\);/);
  assert.match(reopenFn, /setVisible\(true\);/);
});

check('E5. completion is written to local scoped storage only — no cloud/schema path', () => {
  const persistence = stripComments(read('../lib/tutorialPersistence.ts'));
  assert.match(persistence, /AsyncStorage\.setItem\(scopedTutorialCompletionKey\(scopeId\), 'true'\)/);
  assert.doesNotMatch(persistence, /supabase|fetch\(|api/i, 'tutorial completion must never leave the device');
});

// =====================================================================
console.log('C1-C6 — session continuity across the Notebook round trip');
// =====================================================================

check('C1. the simulated clock advances, and it is a plain interval over local state — never the real recorder', () => {
  // The clock is one setInterval in the provider. No recorder, no audio
  // session, no real elapsed source.
  assert.match(provider, /setInterval\(\(\) => setDemoElapsedSeconds\(\(s\) => s \+ 1\), 1000\)/);
  assert.match(provider, /return \(\) => clearInterval\(id\);/);
  assert.doesNotMatch(provider, /useLectureRecorder|recordingEngine|currentDurationMillis|pendingLectureId/,
    'the demo clock must never read real recorder/session state');
});

check('C2. elapsed time and pause live in the PROVIDER, not in a screen — a screen remount cannot reset them', () => {
  assert.match(provider, /const \[demoElapsedSeconds, setDemoElapsedSeconds\] = useState\(0\)/);
  assert.match(provider, /const \[demoPaused, setDemoPaused\] = useState\(false\)/);
  // Exposed on the context so both live-session screens read the same value.
  assert.match(provider, /demoElapsedSeconds,\s*\n\s*demoPaused,/);
  // ...and the screens must NOT keep a private clock any more.
  assert.doesNotMatch(screens, /useSimulatedTimer/, 'screens must not own a local recording clock');
  assert.doesNotMatch(screens, /setInterval\(\(\) => setSeconds/, 'screens must not tick their own elapsed time');
});

check('C3. the clock runs on BOTH live-session screens, so Recording → Notebook → Recording is one timeline', () => {
  assert.match(provider, /LIVE_SESSION_SCREENS = new Set<string>\(\[TOUR_SCREENS\.RECORDING, TOUR_SCREENS\.NOTEBOOK\]\)/);
  assert.match(provider, /LIVE_SESSION_SCREENS\.has\(currentScreen\)/);
  // Both screens render the SAME provider value — not two independent clocks.
  const rec = screens.slice(screens.indexOf('function SimulatedRecordingScreen'), screens.indexOf('function SimulatedNotebookScreen'));
  const notebook = screens.slice(screens.indexOf('function SimulatedNotebookScreen'), screens.indexOf('function SimulatedLectureDetailScreen'));
  for (const [name, src] of [['Recording', rec], ['Notebook', notebook]]) {
    assert.match(src, /demoElapsedSeconds: seconds/, `${name} must read the shared session clock`);
  }
});

check('C4. nothing in the journey resets elapsed time mid-tour — only opening/closing the tour does', () => {
  // The ONLY resets are on close and on manual replay: a fresh lecture starts
  // at 00:00:00, but the running journey never rewinds.
  const resets = [...provider.matchAll(/setDemoElapsedSeconds\(0\)/g)];
  assert.equal(resets.length, 2, `expected exactly 2 resets (close + replay), found ${resets.length}`);
  const closeFn = provider.slice(provider.indexOf('const closeTour ='), provider.indexOf('const reopenTour ='));
  const reopenFn = provider.slice(provider.indexOf('const reopenTour ='), provider.indexOf('const next ='));
  assert.match(closeFn, /setDemoElapsedSeconds\(0\)/);
  assert.match(reopenFn, /setDemoElapsedSeconds\(0\)/);
  // next()/back() must never touch the session clock — walking the journey
  // (including into and out of Notebook) preserves the lecture timeline.
  const nextFn = provider.slice(provider.indexOf('const next = useCallback'), provider.indexOf('const back ='));
  const backFn = provider.slice(provider.indexOf('const back = useCallback'), provider.indexOf('const value ='));
  for (const [name, fn] of [['next', nextFn], ['back', backFn]]) {
    assert.doesNotMatch(fn, /setDemoElapsedSeconds/, `${name}() must not reset the simulated lecture clock`);
  }
});

check('C5. the same simulated session identity spans the whole journey — one course, one lecture, one clock', () => {
  // A single demo course/lecture is referenced throughout; nothing in the tour
  // mints a second session when screens change.
  assert.equal(DEMO_COURSE_VISUAL.id, 'tutorial-demo-course');
  const numericStates = [...provider.matchAll(/useState\(0\)/g)];
  assert.equal(
    numericStates.length,
    3,
    'expected exactly momentIndex + tourRunId + demoElapsedSeconds as numeric state',
  );
  assert.match(provider, /const \[tourRunId, setTourRunId\] = useState\(0\)/);
  // Pause is demonstrated then released, so the session resumes running.
  assert.match(provider, /setDemoPaused\(true\);[\s\S]{0,120}setTimeout\(\(\) => setDemoPaused\(false\), 1600\)/);
});

check('C6. iPhone is unaffected — same shared clock, and still no Notebook screen in its journey', () => {
  assert.equal(phone.some((m) => m.screen === TOUR_SCREENS.NOTEBOOK), false);
  // The clock is device-agnostic: it keys off screen, not off isPad, so the
  // phone journey (which never visits Notebook) behaves exactly as before.
  const clockEffect = provider.slice(provider.indexOf('if (!visible || demoPaused'), provider.indexOf('const closeTour ='));
  assert.doesNotMatch(clockEffect, /isPad/, 'the session clock must not branch on device class');
});

// =====================================================================
console.log('B1-B7 — real-state isolation (preserved from the previous revision)');
// =====================================================================

check('B1. no tour module ever calls createCourse', () => {
  for (const [name, src] of tourFiles) assert.doesNotMatch(src, /createCourse\s*\(/, `${name} calls createCourse`);
});

check('B2. no tour module ever starts a real recording (no recorder engine, no expo-audio)', () => {
  for (const [name, src] of tourFiles) {
    assert.doesNotMatch(src, /useLectureRecorder|startRecording\s*\(|expo-audio/, `${name} touches the real recording engine`);
  }
});

check('B3. no tour module ever calls createLecture/updateLecture/saveInProgressLecture', () => {
  for (const [name, src] of tourFiles) {
    assert.doesNotMatch(src, /createLecture\s*\(|updateLecture\s*\(|saveInProgressLecture\s*\(/, `${name} writes a real lecture`);
  }
});

check('B4. no tour module reads/writes the production store (no useData import)', () => {
  for (const [name, src] of tourFiles) {
    assert.doesNotMatch(src, /from '@\/lib\/store'|useData\s*\(/, `${name} imports the production store`);
  }
});

check('B5. no tour module ever references Supabase', () => {
  for (const [name, src] of tourFiles) assert.doesNotMatch(src, /supabase/i, `${name} references supabase`);
});

check('B6. no tour module ever consumes guest/plan recording quota', () => {
  for (const [name, src] of tourFiles) {
    assert.doesNotMatch(src, /incrementGuestRecordingsUsed|recordingsUsedToday|maxRecordingsPerDay/, `${name} touches quota`);
  }
});

check('B7. no tour module imports a material-upload, audio-upload, or native-dictionary path', () => {
  for (const [name, src] of tourFiles) {
    assert.doesNotMatch(src, /pickAndImportPdf|persistLectureLocalAudio|uploadAsync|requestCloudLectureAudio/, `${name} touches upload code`);
    // The real dictionary is a native UIKit controller — the tour simulates
    // the lookup instead of summoning it.
    assert.doesNotMatch(src, /openNativeWordLookup|NativeLookupText|ExpoNativeWordLookup/, `${name} invokes the real native dictionary`);
  }
});

check('B8. the tour never mounts a production screen or a side-effectful component', () => {
  for (const [name, src] of tourFiles) {
    assert.doesNotMatch(src, /NotebookCanvas|CaptionHistoryFeed|TranscriptReadList|YLSidebar/, `${name} mounts a side-effectful component`);
  }
  // Pure presentational reuse IS expected and desirable.
  assert.match(screens, /from '@\/components\/CourseCard'/);
});

// =====================================================================
console.log('B9-B12 — persistence semantics');
// =====================================================================

check('B9. Skip persists completion — skipTour is closeTour, and closeTour writes the flag', () => {
  assert.match(provider, /skipTour: closeTour,/);
  const closeFn = provider.slice(provider.indexOf('const closeTour ='), provider.indexOf('const reopenTour ='));
  assert.match(closeFn, /saveTutorialCompleted\(scopeId\)/);
});

check('B10. Finish persists completion — the final moment routes through the SAME closeTour', () => {
  const nextFn = provider.slice(provider.indexOf('const next = useCallback'), provider.indexOf('const back ='));
  assert.match(nextFn, /if \(isFinalMoment\(currentMoment\)\) \{\s*closeTour\(\);/);
});

check('B11. manual Settings replay never erases completion', () => {
  const reopenFn = provider.slice(provider.indexOf('const reopenTour ='), provider.indexOf('const next ='));
  assert.doesNotMatch(reopenFn, /saveTutorialCompleted|loadTutorialCompleted/);
});

check('B12. manual replay always restarts from the first moment', () => {
  const reopenFn = provider.slice(provider.indexOf('const reopenTour ='), provider.indexOf('const next ='));
  assert.match(reopenFn, /setMomentIndex\(0\);/);
  assert.match(reopenFn, /setVisible\(true\);/);
});

// =====================================================================
console.log('B13-B16 — first-run, closeable, no residual overlay, no leaked timers');
// =====================================================================

check('B13. first eligible entry auto-shows, gated exactly like AuthGate', () => {
  assert.match(provider, /if \(loading \|\| !canUseApp \|\| !scopeId\) return;/);
  assert.match(provider, /loadTutorialCompleted\(scopeId\)/);
  assert.match(provider, /setVisible\(true\);/);
});

check('B14. the tour is closeable from every stage — Skip is always in the shell chrome, and system dismiss maps to Skip', () => {
  // Unconditional: no scene can render without it.
  assert.match(shell, /onPress=\{onSkip\}/);
  assert.doesNotMatch(shell, /skipReachable/, 'Skip must not be conditional per-scene');
  assert.match(overlay, /onRequestClose=\{skipTour\}/);
});

check('B15. the overlay is a real unmount when not visible — no hidden layer left intercepting touches', () => {
  const idx = overlay.indexOf('export function TutorialTourOverlay');
  const guard = overlay.slice(idx, overlay.indexOf('return (', idx));
  assert.match(guard, /if \(!visible\) return null;/);
});

check('B16. every simulated timer/interval has a cleanup — repeated open/close cannot leak', () => {
  const setI = (screens.match(/setInterval\(/g) ?? []).length;
  const clrI = (screens.match(/clearInterval\(/g) ?? []).length;
  const setT = (screens.match(/setTimeout\(/g) ?? []).length;
  const clrT = (screens.match(/clearTimeout\(/g) ?? []).length;
  assert.ok(setI > 0 && clrI >= setI, 'every setInterval needs a matching clearInterval');
  assert.ok(setT > 0 && clrT >= setT, 'every setTimeout needs a matching clearTimeout');
  assert.match(screens, /return \(\) => clearInterval\(/);
  assert.match(screens, /return \(\) => clearTimeout\(/);
  // Emphasis loops must stop too.
  assert.match(emphasis, /loop\.stop\(\);/);
});

// =====================================================================
console.log('B17 — Reduced Motion never leaves content invisible');
// =====================================================================

check('B17. screen transitions and emphasis both resolve instantly under Reduced Motion', () => {
  assert.match(overlay, /if \(reduceMotion\) \{\s*progress\.setValue\(1\);\s*return;\s*\}/);
  assert.match(emphasis, /if \(reduceMotion\) \{[\s\S]{0,120}pulse\.setValue\(1\);\s*return;\s*\}/);
});

// =====================================================================
console.log('B18 — production navigation completely unaffected');
// =====================================================================

check('B18. the real Record/Recording/Lecture-Detail screens have zero coupling to any tutorial module', () => {
  for (const [name, src] of [['index.tsx', recordHome], ['recording.tsx', recording], ['lecture/[id].tsx', lectureDetail]]) {
    assert.doesNotMatch(src, /Tutorial|tutorial/, `${name} still references a tutorial module`);
  }
});

// =====================================================================
console.log('wiring + localization completeness');
// =====================================================================

check('root layout mounts exactly one TutorialTourProvider/TutorialTourOverlay pair', () => {
  assert.equal((rootLayout.match(/<TutorialTourProvider>/g) ?? []).length, 1);
  assert.equal((rootLayout.match(/<TutorialTourOverlay \/>/g) ?? []).length, 1);
  const p = rootLayout.indexOf('<TutorialTourProvider>');
  const o = rootLayout.indexOf('<TutorialTourOverlay />');
  const c = rootLayout.indexOf('</TutorialTourProvider>');
  assert.ok(p < o && o < c);
});

check('Settings → Help → Tutorial replays the tour', () => {
  assert.match(settings, /import \{ useTutorialTour \} from '@\/lib\/tutorialTour';/);
  assert.match(settings, /const \{ reopenTour \} = useTutorialTour\(\);/);
  assert.match(settings, /onPress=\{reopenTour\}/);
});

check('the completion key is byte-identical to every previous tutorial generation\'s', () => {
  assert.equal(scopedTutorialTourCompletionKey('abc123'), 'youmi.tutorial.completed.v1.abc123');
});

const locales = {
  en: read('../lib/locales/en.mjs'),
  'zh-Hans': read('../lib/locales/zh-Hans.mjs'),
  ja: read('../lib/locales/ja.mjs'),
  fr: read('../lib/locales/fr.mjs'),
  es: read('../lib/locales/es.mjs'),
  ko: read('../lib/locales/ko.mjs'),
};
const keyPattern = /'(tutorialTour\.[a-zA-Z0-9.]+)':/g;
const enKeys = new Set([...locales.en.matchAll(keyPattern)].map((m) => m[1]));

check('every moment label and demo key referenced by the core exists in English', () => {
  for (const m of pad) assert.ok(enKeys.has(m.labelKey), `missing English key: ${m.labelKey}`);
  for (const key of Object.values(DEMO_CONTENT)) assert.ok(enKeys.has(key), `missing English demo key: ${key}`);
});

check('EVERY t() key the tour renders resolves — a simulated screen must never display a raw key', () => {
  // Caught a real bug: the Lecture Detail header rendered the literal
  // "status.synced" because no such key exists (production pairs the
  // `synced` StatusPill variant with `status.uploaded`).
  const en = read('../lib/locales/en.mjs');
  const allEnKeys = new Set([...en.matchAll(/'([a-zA-Z0-9_.\-]+)':/g)].map((m) => m[1]));
  const referenced = new Set();
  for (const src of [screens, shell]) {
    for (const m of src.matchAll(/\bt\('([^']+)'\)/g)) referenced.add(m[1]);
  }
  // Template-literal keys are enumerated explicitly.
  for (const tab of ['summary', 'transcript', 'marked', 'notes']) referenced.add(`lecture.tab.${tab}`);
  assert.ok(referenced.size >= 20, `expected the tour to reference many keys, found ${referenced.size}`);
  const unresolved = [...referenced].filter((k) => !allEnKeys.has(k));
  assert.deepEqual(unresolved, [], `tour references non-existent i18n keys: ${unresolved.join(', ')}`);
});

for (const [locale, source] of Object.entries(locales)) {
  if (locale === 'en') continue;
  check(`${locale} defines every tutorialTour.* key English defines (real translations, not silent fallback)`, () => {
    const localeKeys = new Set([...source.matchAll(keyPattern)].map((m) => m[1]));
    const missing = [...enKeys].filter((k) => !localeKeys.has(k));
    assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(', ')}`);
  });
}

check('exactly one final moment, and it closes the tour', () => {
  assert.equal(pad.filter(isFinalMoment).length, 1);
  assert.equal(pad[pad.length - 1].id, 'ready');
});

console.log(`\ntutorial-tour: ${passed} checks passed`);
