/**
 * Release-blocking physical-device UI regression contract.
 *
 * These checks intentionally pin the failure boundaries proven on physical
 * iPhone/iPad hardware: iPhone Modal's portrait default, animation-gated
 * Course visibility, and animation-gated Tutorial screen bodies.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  getTourMoments,
  isActionMoment,
  TOUR_SCREENS,
} from '../lib/tutorialTourCore.mjs';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

const rename = stripComments(read('../components/RenameModal.tsx'));
const move = stripComments(read('../components/MoveLectureToCourseModal.tsx'));
const modalContract = stripComments(read('../constants/modal.ts'));
const entrance = stripComments(read('../components/StaggeredCardEntrance.tsx'));
const provider = stripComments(read('../lib/tutorialTour.tsx'));
const overlay = stripComments(read('../components/TutorialTourOverlay.tsx'));
const shell = stripComments(read('../components/tutorialTour/TutorialAppShell.tsx'));
const screenCases = new Map([
  [TOUR_SCREENS.HOME, ['HOME', 'SimulatedHomeScreen']],
  [TOUR_SCREENS.COURSES, ['COURSES', 'SimulatedCoursesScreen']],
  [TOUR_SCREENS.COURSE_DETAIL, ['COURSE_DETAIL', 'SimulatedCourseDetailScreen']],
  [TOUR_SCREENS.RECORDING, ['RECORDING', 'SimulatedRecordingScreen']],
  [TOUR_SCREENS.NOTEBOOK, ['NOTEBOOK', 'SimulatedNotebookScreen']],
  [TOUR_SCREENS.LECTURE_DETAIL, ['LECTURE_DETAIL', 'SimulatedLectureDetailScreen']],
  [TOUR_SCREENS.READY, ['READY', 'SimulatedReadyScreen']],
]);

const validateRenameOrientation = (source) => {
  assert.match(source, /supportedOrientations=\{RESPONSIVE_MODAL_ORIENTATIONS\}/);
  assert.match(source, /presentationStyle="overFullScreen"/);
};

const validateMoveLandscape = (source) => {
  assert.match(source, /supportedOrientations=\{RESPONSIVE_MODAL_ORIENTATIONS\}/);
  assert.match(source, /isLandscape && styles\.rootLandscape/);
  assert.match(source, /isLandscape && styles\.sheetLandscape/);
  assert.match(source, /sheetLandscape:\s*\{[^}]*maxHeight:\s*'94%'/s);
  const scrollEnd = source.indexOf('</ScrollView>');
  const cancel = source.indexOf('style={styles.cancelButton}');
  assert.ok(scrollEnd > -1 && cancel > scrollEnd, 'Cancel must remain outside the bounded scrolling list');
};

const validateCourseVisibility = (source) => {
  assert.doesNotMatch(source, /opacity\s*:/, 'Course visibility must never depend on entrance progress');
  assert.match(source, /translateY:\s*progress\.interpolate/);
  assert.match(source, /if \(!finished\) progress\.setValue\(1\)/);
};

const replayBlock = (source) => source.slice(
  source.indexOf('const reopenTour ='),
  source.indexOf('// One advancement per moment'),
);

const validateReplayReset = (source) => {
  const block = replayBlock(source);
  for (const reset of [
    /setMomentIndex\(0\)/,
    /setDemoElapsedSeconds\(0\)/,
    /setDemoPaused\(false\)/,
    /setSelectedLectureTab\('summary'\)/,
    /setDemoMarkedAtSeconds\(DEMO_MARKED_FALLBACK_SECONDS\)/,
    /setTourRunId\(\(runId\) => runId \+ 1\)/,
  ]) assert.match(block, reset);
  assert.doesNotMatch(block, /saveTutorialCompleted|loadTutorialCompleted/);
};

const validateTutorialBody = (source) => {
  assert.doesNotMatch(source, /opacity\s*:\s*progress/, 'Tutorial screen content must be visible before animation runs');
  assert.match(source, /supportedOrientations=\{RESPONSIVE_MODAL_ORIENTATIONS\}/);
  assert.match(source, /key=\{tourRunId\}/);
  for (const [screenKey, component] of screenCases.values()) {
    assert.match(source, new RegExp(`case TOUR_SCREENS\\.${screenKey}:[\\s\\S]{0,80}return <${component}`));
  }
};

console.log('physical-device UI release blockers');

check('R1 Rename explicitly supports iPhone portrait and both landscape orientations', () => {
  assert.match(modalContract, /'portrait'/);
  assert.match(modalContract, /'landscape-left'/);
  assert.match(modalContract, /'landscape-right'/);
  validateRenameOrientation(rename);
});

check('R2 Move uses the same responsive orientation contract', () => validateMoveLandscape(move));

check('R3 short-height Move keeps a bounded list and reachable Cancel action', () => {
  assert.match(move, /<ScrollView/);
  assert.match(move, /rootLandscape:\s*\{[^}]*justifyContent:\s*'center'/s);
  validateMoveLandscape(move);
});

check('R4 an active synced Course is never rendered through card opacity', () => validateCourseVisibility(entrance));
check('R5 Realtime insertion settle has an interruption completion fallback', () => {
  assert.match(entrance, /animation\.start\(\(\{ finished \}\) =>/);
  assert.match(entrance, /if \(!finished\) progress\.setValue\(1\)/);
});
check('R6 focus/rotation reruns can move a card only; they cannot fade it', () => validateCourseVisibility(entrance));

check('R7 Settings replay resets every provider-owned demo state and run key', () => validateReplayReset(provider));
check('R8 manual replay first frame maps to a visible Home shell', () => {
  assert.match(provider, /const currentMoment = moments\[momentIndex\] \?\? moments\[0\]/);
  assert.match(provider, /const currentScreen = currentMoment\.screen/);
  assert.match(overlay, /case TOUR_SCREENS\.HOME:[\s\S]*?return <SimulatedHomeScreen/);
  validateTutorialBody(overlay);
});
check('R9 every action moment maps to a concrete rendered screen', () => {
  const actionScreens = new Set([
    ...getTourMoments(false),
    ...getTourMoments(true),
  ].filter(isActionMoment).map((moment) => moment.screen));
  for (const screen of actionScreens) {
    const [screenKey, component] = screenCases.get(screen);
    assert.match(overlay, new RegExp(`case TOUR_SCREENS\\.${screenKey}:[\\s\\S]{0,80}return <${component}`));
  }
  validateTutorialBody(overlay);
});
check('R10 iPad compact/wide shells always retain a nonzero stage body', () => {
  assert.match(shell, /const isCompact = useIsCompactWidth\(\)/);
  assert.match(shell, /stage:\s*\{\s*flex:\s*1,\s*minHeight:\s*0\s*\}/);
  validateTutorialBody(overlay);
});
check('R11 replay never changes tutorial completion persistence', () => validateReplayReset(provider));
check('R12 rotation cannot blank a Tutorial screen through opacity or portrait-only Modal policy', () => validateTutorialBody(overlay));

console.log('mutation guards');
check('A portrait-only Modal mutation fails', () => {
  assert.throws(() => validateRenameOrientation(rename.replace(/supportedOrientations=\{RESPONSIVE_MODAL_ORIENTATIONS\}/, '')));
});
check('B partial-opacity Course entrance mutation fails', () => {
  assert.throws(() => validateCourseVisibility(entrance.replace('transform: [', 'opacity: progress, transform: [')));
});
check('C stale replay demo-state mutation fails', () => {
  assert.throws(() => validateReplayReset(provider.replaceAll("setSelectedLectureTab('summary');", '')));
});
check('D null Tutorial action-screen body mutation fails', () => {
  assert.throws(() => validateTutorialBody(overlay.replace('return <SimulatedCoursesScreen moment={moment} />;', 'return null;')));
});

console.log(`\nphysical-device UI regressions: ${passed} checks passed`);
