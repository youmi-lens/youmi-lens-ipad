/**
 * Pure first-run tutorial logic — step list + persistence key. No React, no
 * AsyncStorage import here, so this is directly Node-testable (mirrors the
 * .mjs-core / .ts-wrapper split already used by contentLanguages.mjs vs
 * contentLanguagePreferences.ts).
 *
 * Every step's copy is an i18n KEY, never a literal string — translation
 * happens at render time via `t(step.titleKey)` / `t(step.bodyKey)`. Every
 * key referenced here must exist in every locale file (enforced by
 * scripts/i18n.test.mjs).
 */

/** Storage key prefix — one persisted flag per user/guest scope, mirroring
 * the `scopedCoursesKey`-style convention already used in lib/store.tsx. */
export const TUTORIAL_COMPLETION_KEY_PREFIX = 'youmi.tutorial.completed.v1.';

/** @param {string} scopeId */
export function scopedTutorialCompletionKey(scopeId) {
  return `${TUTORIAL_COMPLETION_KEY_PREFIX}${scopeId}`;
}

/**
 * @typedef {{
 *   id: string,
 *   titleKey: string,
 *   bodyKey: string,
 *   isFinal?: boolean,
 * }} TutorialStep
 */

/**
 * Ordered tutorial steps, adapted for the current device idiom.
 *
 * Only the "Recording controls" step differs by device: iPhone must never
 * advertise Notebook editing (it is gated to iPad elsewhere in the app —
 * see the Notebook iPad gate), so it gets its own body key that never
 * mentions it. iPad's body key may mention Notebook as a study tool.
 *
 * @param {boolean} isPad
 * @returns {TutorialStep[]}
 */
export function getTutorialSteps(isPad) {
  return [
    { id: 'welcome', titleKey: 'tutorial.welcome.title', bodyKey: 'tutorial.welcome.body' },
    { id: 'courses', titleKey: 'tutorial.courses.title', bodyKey: 'tutorial.courses.body' },
    { id: 'recording', titleKey: 'tutorial.recording.title', bodyKey: 'tutorial.recording.body' },
    { id: 'captions', titleKey: 'tutorial.captions.title', bodyKey: 'tutorial.captions.body' },
    {
      id: 'controls',
      titleKey: 'tutorial.controls.title',
      bodyKey: isPad ? 'tutorial.controls.bodyPad' : 'tutorial.controls.bodyPhone',
    },
    { id: 'library', titleKey: 'tutorial.library.title', bodyKey: 'tutorial.library.body' },
    { id: 'detail', titleKey: 'tutorial.detail.title', bodyKey: 'tutorial.detail.body' },
    { id: 'finish', titleKey: 'tutorial.finish.title', bodyKey: 'tutorial.finish.body', isFinal: true },
  ];
}
