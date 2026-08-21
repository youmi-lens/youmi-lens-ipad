/**
 * "Quick Overview" (formerly first-run Tutorial V1).
 *
 * First-run onboarding is now owned by Interactive Tutorial V2 (see
 * tutorial-v2.test.mjs) — this module is Settings-only now: no auto-show,
 * no persistence read/write of any kind. Covers: Back/Next bounds, the
 * final CTA closing instead of advancing, device-adaptive Notebook wording,
 * no cloud/persistence writes, a real overlay unmount (not a hidden
 * opacity-0 layer), Reduced Motion safety via the existing ContentReveal
 * primitive, both Settings rows being wired to their own distinct
 * provider, and localization completeness across all six locales.
 *
 * Source-level guards, same idiom as every other test in this suite: these
 * are React/native modules, not portable to plain Node, so assertions read
 * the file as text and check patterns against sliced sections.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getTutorialSteps, scopedTutorialCompletionKey } from '../lib/tutorialCore.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const provider = stripComments(read('../lib/tutorial.tsx'));
const persistence = stripComments(read('../lib/tutorialPersistence.ts'));
const overlay = stripComments(read('../components/TutorialOverlay.tsx'));
const settings = stripComments(read('../app/(tabs)/settings.tsx'));
const rootLayout = stripComments(read('../app/_layout.tsx'));
const locales = {
  en: read('../lib/locales/en.mjs'),
  'zh-Hans': read('../lib/locales/zh-Hans.mjs'),
  ja: read('../lib/locales/ja.mjs'),
  fr: read('../lib/locales/fr.mjs'),
  es: read('../lib/locales/es.mjs'),
  ko: read('../lib/locales/ko.mjs'),
};

console.log('step definitions — pure, device-adaptive, i18n-keyed');

check('exactly 6-8 steps, and the shape stays the same on both device idioms', () => {
  const phoneSteps = getTutorialSteps(false);
  const padSteps = getTutorialSteps(true);
  assert.ok(phoneSteps.length >= 6 && phoneSteps.length <= 8, `expected 6-8 steps, got ${phoneSteps.length}`);
  assert.equal(phoneSteps.length, padSteps.length, 'one adaptive step definition — no separate iPhone/iPad step counts');
});

check('no literal English copy in the step definitions — every step resolves through an i18n key', () => {
  for (const step of getTutorialSteps(false)) {
    assert.match(step.titleKey, /^tutorial\./, `${step.id} titleKey is not an i18n key`);
    assert.match(step.bodyKey, /^tutorial\./, `${step.id} bodyKey is not an i18n key`);
  }
});

check('the last step is marked final', () => {
  const steps = getTutorialSteps(false);
  assert.equal(steps[steps.length - 1].isFinal, true);
});

check('the completion key is scoped per user/guest, mirroring the store.tsx scoped-key convention', () => {
  assert.equal(scopedTutorialCompletionKey('abc123'), 'youmi.tutorial.completed.v1.abc123');
  assert.notEqual(scopedTutorialCompletionKey('abc123'), scopedTutorialCompletionKey('def456'));
});

console.log('device-specific wording — the Notebook gate rule applies to tutorial copy too');

check('iPhone step content never advertises Notebook editing', () => {
  const phoneSteps = getTutorialSteps(false);
  const controlsStep = phoneSteps.find((s) => s.id === 'controls');
  assert.equal(controlsStep.bodyKey, 'tutorial.controls.bodyPhone');
  assert.doesNotMatch(locales.en.match(/'tutorial\.controls\.bodyPhone':\s*'([^']*)'/)[1], /Notebook/i);
});

check('iPad step content may mention Notebook as a study tool', () => {
  const padSteps = getTutorialSteps(true);
  const controlsStep = padSteps.find((s) => s.id === 'controls');
  assert.equal(controlsStep.bodyKey, 'tutorial.controls.bodyPad');
  assert.match(locales.en.match(/'tutorial\.controls\.bodyPad':\s*'([^']*)'/)[1], /Notebook/);
});

console.log('provider — Settings-only now, no auto-show, no persistence, Back/Next bounds');

check('the provider never auto-shows — no useEffect, no scope tracking, no completion read at all', () => {
  assert.doesNotMatch(provider, /useEffect/, 'Quick Overview must not run any effect — Settings-triggered only');
  assert.doesNotMatch(provider, /autoCheckedScopeRef/);
  assert.doesNotMatch(provider, /loadTutorialCompleted/);
});

check('closeTutorial only hides the overlay — it never writes the completion flag (that is V2\'s job now)', () => {
  const closeFn = provider.slice(provider.indexOf('const closeTutorial ='), provider.indexOf('const next ='));
  assert.match(closeFn, /setVisible\(false\);/);
  assert.doesNotMatch(closeFn, /saveTutorialCompleted/, 'V1 closing must not touch the shared completion flag');
  // Both the Skip control and the final-step CTA call the same function.
  assert.match(overlay, /onPress=\{closeTutorial\}/);
  assert.match(overlay, /onPress=\{isLast \? closeTutorial : next\}/);
});

check('openTutorial never touches persistence either — the whole module is a pure, session-local presentation toggle', () => {
  const openFn = provider.slice(provider.indexOf('const openTutorial ='), provider.indexOf('const closeTutorial ='));
  assert.doesNotMatch(openFn, /saveTutorialCompleted|loadTutorialCompleted/);
});

check('next/back are clamped — cannot advance past the last step or retreat before the first', () => {
  assert.match(provider, /Math\.min\(index \+ 1, steps\.length - 1\)/);
  assert.match(provider, /Math\.max\(index - 1, 0\)/);
});

check('no Supabase, Course/Lecture, or completion-persistence write path is reachable from any Quick Overview module', () => {
  for (const [name, source] of [['tutorial.tsx', provider], ['TutorialOverlay.tsx', overlay]]) {
    assert.doesNotMatch(source, /supabase/i, `${name} references supabase`);
    assert.doesNotMatch(source, /createCourse|createLecture|deleteCourse|deleteLecture|writeCourseDeletion/, `${name} touches Course/Lecture mutation APIs`);
    assert.doesNotMatch(source, /saveTutorialCompleted|loadTutorialCompleted/, `${name} touches the shared completion flag — only Tutorial V2 may`);
  }
});

check('tutorialPersistence.ts itself is untouched (still local AsyncStorage only) — V1 simply stopped calling it', () => {
  assert.match(persistence, /AsyncStorage/, 'persistence must be local AsyncStorage only');
  assert.doesNotMatch(persistence, /supabase/i);
});

console.log('Settings — two distinct Help rows, Quick Overview and the Simulated Product Tour');

check('Settings wires the Quick Overview row to V1\'s openTutorial', () => {
  assert.match(settings, /import \{ useTutorial \} from '@\/lib\/tutorial';/);
  assert.match(settings, /const \{ openTutorial \} = useTutorial\(\);/);
  assert.match(settings, /onPress=\{openTutorial\}/);
});

check('Settings ALSO wires a separate Interactive Tutorial row to the tour\'s reopenTour — two distinct entry points, not a shared one', () => {
  assert.match(settings, /import \{ useTutorialTour \} from '@\/lib\/tutorialTour';/);
  assert.match(settings, /const \{ reopenTour \} = useTutorialTour\(\);/);
  assert.match(settings, /onPress=\{reopenTour\}/);
});

check('the root layout mounts exactly one TutorialProvider/TutorialOverlay pair, above the app Stack', () => {
  assert.equal((rootLayout.match(/<TutorialProvider>/g) ?? []).length, 1);
  assert.equal((rootLayout.match(/<TutorialOverlay \/>/g) ?? []).length, 1);
  const providerIdx = rootLayout.indexOf('<TutorialProvider>');
  const overlayIdx = rootLayout.indexOf('<TutorialOverlay />');
  const providerCloseIdx = rootLayout.indexOf('</TutorialProvider>');
  assert.ok(providerIdx < overlayIdx && overlayIdx < providerCloseIdx, 'TutorialOverlay must be mounted inside TutorialProvider');
});

console.log('overlay — real unmount, no residual pointer-blocking layer, Reduced-Motion-safe');

check('the overlay returns null (a real unmount) when not visible — not a hidden/opacity-0 layer that could still intercept touches', () => {
  const idx = overlay.indexOf('export function TutorialOverlay');
  const bodyStart = overlay.indexOf('{', idx);
  const guardRegion = overlay.slice(bodyStart, overlay.indexOf('return (', bodyStart));
  assert.match(guardRegion, /if \(!visible\) return null;/);
});

check('the overlay is driven by a native Modal whose `visible` prop is tied to the same context flag — closing it is a real dismissal, not a style change', () => {
  assert.match(overlay, /<Modal visible=\{visible\}/);
  assert.match(overlay, /transparent/);
});

check('per-step content transitions go through the existing, already-Reduced-Motion-safe ContentReveal — no bespoke animation was hand-rolled', () => {
  assert.match(overlay, /<ContentReveal revealKey=\{stepIndex\}/);
  assert.doesNotMatch(overlay, /Animated\.(Value|timing|spring)/, 'TutorialOverlay should not hand-roll its own animation');
});

console.log('localization completeness — real translations, not just English-with-fallback');

const tutorialKeyPattern = /'(tutorial\.[a-zA-Z.]+|settings\.help\.[a-zA-Z]+)':/g;
const enKeys = new Set([...locales.en.matchAll(tutorialKeyPattern)].map((m) => m[1]));

check('at least the expected tutorial.*/settings.help.* keys exist in English', () => {
  for (const key of [
    'tutorial.skip', 'tutorial.back', 'tutorial.next', 'tutorial.finishCta',
    'tutorial.welcome.title', 'tutorial.welcome.body',
    'tutorial.courses.title', 'tutorial.courses.body',
    'tutorial.recording.title', 'tutorial.recording.body',
    'tutorial.captions.title', 'tutorial.captions.body',
    'tutorial.controls.title', 'tutorial.controls.bodyPhone', 'tutorial.controls.bodyPad',
    'tutorial.library.title', 'tutorial.library.body',
    'tutorial.detail.title', 'tutorial.detail.body',
    'tutorial.finish.title', 'tutorial.finish.body',
    'settings.help.heading', 'settings.help.tutorial', 'settings.help.tutorialDetail',
  ]) {
    assert.ok(enKeys.has(key), `missing English key: ${key}`);
  }
  assert.ok(enKeys.size >= 23, `expected at least 23 tutorial/help keys, found ${enKeys.size}`);
});

for (const [locale, source] of Object.entries(locales)) {
  if (locale === 'en') continue;
  check(`${locale} defines every tutorial.*/settings.help.* key English defines (real translations, not silent fallback)`, () => {
    const localeKeys = new Set([...source.matchAll(tutorialKeyPattern)].map((m) => m[1]));
    const missing = [...enKeys].filter((k) => !localeKeys.has(k));
    assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(', ')}`);
  });
}

console.log(`\ntutorial: ${passed} checks passed`);
