/**
 * Integrated Simulated Tutorial — screens, teaching moments, demo content.
 *
 * No React, no navigation, no store import — directly Node-testable (same
 * .mjs-core / .tsx-wrapper split used across this codebase).
 *
 * The model is deliberately TWO-LEVEL:
 *
 *   SCREEN            a full simulated Youmi Lens surface (Home, Courses,
 *                     Course Detail, Recording, Notebook, Lecture Detail)
 *   TEACHING MOMENT   one thing being taught WITHIN a screen
 *
 * Several consecutive moments share one screen — the Recording screen alone
 * carries start → captions → translation → dictionary → mark → pause →
 * finish. The renderer keys screens by `screen` (never by moment), so the
 * simulated screen STAYS MOUNTED while its internal focus changes. That is
 * what makes the tour read as one continuous app session instead of a deck
 * of unrelated feature cards, and it is asserted by scripts/tutorial-tour.test.mjs.
 *
 * Everything here is presentation only: no scene ever touches the real
 * Course/Lecture store, Supabase, the recording engine, or Notebook
 * persistence. Copy is short and contextual by design (§5) — a single label
 * per moment; the simulated UI itself does the teaching.
 */

/** Reuses the SAME completion-flag prefix every tutorial generation has used
 * — one "has this user completed first-run onboarding" flag on device. */
export function scopedTutorialTourCompletionKey(scopeId) {
  return `youmi.tutorial.completed.v1.${scopeId}`;
}

/** The simulated app surfaces. Each maps 1:1 to a real production screen. */
export const TOUR_SCREENS = {
  HOME: 'home',
  COURSES: 'courses',
  COURSE_DETAIL: 'courseDetail',
  RECORDING: 'recording',
  NOTEBOOK: 'notebook',
  LECTURE_DETAIL: 'lectureDetail',
  READY: 'ready',
};

/**
 * @typedef {{
 *   id: string,
 *   screen: string,
 *   tab: 'record' | 'courses' | 'settings' | null,
 *   labelKey: string,
 *   deviceOnly?: 'ipad',
 *   isFinal?: boolean,
 *   action?: boolean,
 * }} TourMoment
 *
 * `action: true` marks a moment that has ONE clear interactive target — the
 * simulated control the user would really tap. Those moments advance by
 * tapping that control and show NO generic Next, so there is never a question
 * of "do I tap the highlighted button or the Next button?". Moments without a
 * meaningful control (captions appearing, translation appearing, the cloud
 * explanation, the closing screen) are explanation moments and keep a subtle
 * Next/Continue. See isActionMoment below; asserted in tutorial-tour.test.mjs.
 *
 * `tab` is non-null only where the REAL app shows the bottom tab bar (the
 * `(tabs)` group). Course Detail, Recording, Notebook and Lecture Detail are
 * pushed as full-screen stack routes in the real app and therefore have no
 * tab bar here either — matching where things actually live is the whole
 * point of this tour.
 */

/**
 * The one continuous simulated lecture journey.
 *
 * @param {boolean} isPad
 * @returns {TourMoment[]}
 */
export function getTourMoments(isPad) {
  const moments = [
    { id: 'welcome', screen: TOUR_SCREENS.HOME, tab: 'record', labelKey: 'tutorialTour.m.welcome' },
    { id: 'create_course', screen: TOUR_SCREENS.HOME, tab: 'record', labelKey: 'tutorialTour.m.createCourse', action: true },

    { id: 'courses_list', screen: TOUR_SCREENS.COURSES, tab: 'courses', labelKey: 'tutorialTour.m.coursesList', action: true },

    { id: 'course_material', screen: TOUR_SCREENS.COURSE_DETAIL, tab: null, labelKey: 'tutorialTour.m.courseMaterial', action: true },
    // Taught on the SAME Course Detail shell as course_material — the user
    // sees the Start Lecture entry point in its real place (inside the
    // course, next to its materials) before the journey moves into Recording.
    { id: 'start_lecture', screen: TOUR_SCREENS.COURSE_DETAIL, tab: null, labelKey: 'tutorialTour.m.startLecture', action: true },

    // Recording has just begun and the mic is warming up — nothing to tap.
    { id: 'recording_start', screen: TOUR_SCREENS.RECORDING, tab: null, labelKey: 'tutorialTour.m.recordingStart' },
    { id: 'captions', screen: TOUR_SCREENS.RECORDING, tab: null, labelKey: 'tutorialTour.m.captions' },
    { id: 'translation', screen: TOUR_SCREENS.RECORDING, tab: null, labelKey: 'tutorialTour.m.translation' },
    { id: 'dictionary', screen: TOUR_SCREENS.RECORDING, tab: null, labelKey: 'tutorialTour.m.dictionary', action: true },
    { id: 'mark_important', screen: TOUR_SCREENS.RECORDING, tab: null, labelKey: 'tutorialTour.m.markImportant', action: true },
    { id: 'pause_resume', screen: TOUR_SCREENS.RECORDING, tab: null, labelKey: 'tutorialTour.m.pauseResume', action: true },
  ];

  if (isPad) {
    // Notebook belongs INSIDE the recording journey, not bolted on at the
    // end: the entry is emphasised on the real Recording screen, the note is
    // taken on the Notebook screen (with Mini still carrying captions and
    // controls), then the journey returns to Recording to Finish.
    moments.push(
      { id: 'notebook_open', screen: TOUR_SCREENS.RECORDING, tab: null, labelKey: 'tutorialTour.m.notebookOpen', deviceOnly: 'ipad', action: true },
      // Writing on the page — there is no button to press here.
      { id: 'notebook_note', screen: TOUR_SCREENS.NOTEBOOK, tab: null, labelKey: 'tutorialTour.m.notebookNote', deviceOnly: 'ipad' },
    );
  }

  moments.push(
    { id: 'finish', screen: TOUR_SCREENS.RECORDING, tab: null, labelKey: 'tutorialTour.m.finish', action: true },

    // ---- Lecture review, in production's own information order ----
    // Summary (what happened) → Transcript (what was said) → Marked (what I
    // flagged) → Notes (what I captured) → Playback (the source audio). Production's Lecture Detail
    // opens on Summary (app/lecture/[id].tsx), and Finish really does land
    // there, so the tour mirrors it rather than inventing an order.
    //
    // Each tab is opened by TAPPING it, never by the moment advancing: an
    // `open_*` action moment emphasises the tab, the tap selects it, and only
    // then does the tour move to the matching `*_review` explanation moment.
    // That keeps cause and effect intact — you always see what you pressed.
    { id: 'summary_review', screen: TOUR_SCREENS.LECTURE_DETAIL, tab: null, labelKey: 'tutorialTour.m.summaryReview' },
    { id: 'open_transcript', screen: TOUR_SCREENS.LECTURE_DETAIL, tab: null, labelKey: 'tutorialTour.m.openTranscript', action: true },
    { id: 'transcript_review', screen: TOUR_SCREENS.LECTURE_DETAIL, tab: null, labelKey: 'tutorialTour.m.transcriptReview' },
    { id: 'open_marked', screen: TOUR_SCREENS.LECTURE_DETAIL, tab: null, labelKey: 'tutorialTour.m.openMarked', action: true },
    { id: 'marked_review', screen: TOUR_SCREENS.LECTURE_DETAIL, tab: null, labelKey: 'tutorialTour.m.markedReview' },
    { id: 'open_notes', screen: TOUR_SCREENS.LECTURE_DETAIL, tab: null, labelKey: 'tutorialTour.m.openNotes', action: true },
    { id: 'notes_review', screen: TOUR_SCREENS.LECTURE_DETAIL, tab: null, labelKey: 'tutorialTour.m.notesReview' },
    { id: 'playback', screen: TOUR_SCREENS.LECTURE_DETAIL, tab: null, labelKey: 'tutorialTour.m.playback', action: true },
    // Cross-device sync is a property of the lecture, not a control.
    { id: 'cloud', screen: TOUR_SCREENS.LECTURE_DETAIL, tab: null, labelKey: 'tutorialTour.m.cloud' },

    { id: 'ready', screen: TOUR_SCREENS.READY, tab: null, labelKey: 'tutorialTour.m.ready', isFinal: true },
  );

  return moments;
}

export function isFinalMoment(moment) {
  return Boolean(moment.isFinal);
}

/**
 * True when this moment is advanced by tapping its simulated control rather
 * than by a generic Next. The two are mutually exclusive by design — exactly
 * one advancement contract per moment (§4 of the interaction brief).
 */
export function isActionMoment(moment) {
  return Boolean(moment.action);
}

/** Distinct screens the journey visits, in order — used by tests to assert
 * that teaching moments outnumber screen changes. */
export function getTourScreenSequence(isPad) {
  const seq = [];
  for (const moment of getTourMoments(isPad)) {
    if (seq[seq.length - 1] !== moment.screen) seq.push(moment.screen);
  }
  return seq;
}

/**
 * The single fictional workflow, shared by every screen. Never written to
 * any real store. transcriptLine/dictionaryWord intentionally stay English
 * in every locale (the product is demonstrating English lecture
 * transcription); the translated line follows the app's real default
 * translation target.
 */
export const DEMO_CONTENT = {
  courseNameKey: 'tutorialTour.demo.courseName',
  courseMetaKey: 'tutorialTour.demo.courseMeta',
  materialNameKey: 'tutorialTour.demo.materialName',
  materialMetaKey: 'tutorialTour.demo.materialMeta',
  lectureTitleKey: 'tutorialTour.demo.lectureTitle',
  lectureMetaKey: 'tutorialTour.demo.lectureMeta',
  transcriptLineKey: 'tutorialTour.demo.transcriptLine',
  translationLineKey: 'tutorialTour.demo.translationLine',
  dictionaryWordKey: 'tutorialTour.demo.dictionaryWord',
  dictionaryDefinitionKey: 'tutorialTour.demo.dictionaryDefinition',
  summaryEnglishKey: 'tutorialTour.demo.summaryEnglish',
  summaryTranslatedKey: 'tutorialTour.demo.summaryTranslated',
  notebookNoteKey: 'tutorialTour.demo.notebookNote',
};

/**
 * The review tabs the simulated Lecture Detail can show, in production's own
 * order. Notes is a lecture-attached preview on both device classes; its
 * editor remains iPad-gated by the real product and is never mounted here.
 */
export const LECTURE_TABS = ['summary', 'transcript', 'marked', 'notes'];

/** Where the demo lecture's marked moment lands if the user reaches review
 * without having tapped Mark (e.g. after stepping Back past it). The live
 * path records the ACTUAL simulated clock reading at the moment they tapped,
 * so "I marked this in class" and "here it is after class" are the same event. */
export const DEMO_MARKED_FALLBACK_SECONDS = 272;

/** Visual identity for the demo course card — mirrors the shape of a real
 * Course record so the pure production <CourseCard/> can render it directly. */
export const DEMO_COURSE_VISUAL = {
  id: 'tutorial-demo-course',
  icon: 'sparkles-outline',
  tint: 'rgba(11, 31, 58, 0.08)',
  accent: '#0B1F3A',
};
