/**
 * Language-aware access to a lecture's transcript and summary, driven by the
 * lecture's persisted `sourceLanguage` / `translationLanguage` pair.
 *
 * The pure label + resolution logic lives in `contentLanguages.mjs` (so it is
 * unit-testable and shared); this module is the typed surface screens import.
 * Generic `sourceSummary`/`translatedSummary` + `transcript`/`translatedTranscript`
 * are authoritative; legacy `summaryEn`/`summaryZh`/`transcriptZh` are used only
 * as language-appropriate fallbacks for older lectures.
 */
import {
  getSourceSummary as getSourceSummaryImpl,
  getTranslatedSummary as getTranslatedSummaryImpl,
  getSourceTranscript as getSourceTranscriptImpl,
  getTranslatedTranscript as getTranslatedTranscriptImpl,
  getSummarySectionLabel as getSummarySectionLabelImpl,
  getTranscriptSectionLabel as getTranscriptSectionLabelImpl,
} from './contentLanguages.mjs';
import type { ContentLanguage, Lecture } from './models';

/** Section header for the given content language (e.g. 'JAPANESE TRANSCRIPT', '中文转录'). */
export function getTranscriptSectionLabel(language: ContentLanguage): string {
  return getTranscriptSectionLabelImpl(language);
}

export function getSummarySectionLabel(language: ContentLanguage): string {
  return getSummarySectionLabelImpl(language);
}

/** Summary in the lecture's source language, or undefined when unavailable. */
export function getSourceSummary(lecture: Lecture): string | undefined {
  return getSourceSummaryImpl(lecture);
}

/** Translated summary, or undefined when source === target or unavailable. */
export function getTranslatedSummary(lecture: Lecture): string | undefined {
  return getTranslatedSummaryImpl(lecture);
}

/** Transcript in the lecture's source language, or undefined when unavailable. */
export function getSourceTranscript(lecture: Lecture): string | undefined {
  return getSourceTranscriptImpl(lecture);
}

/** Translated transcript, or undefined when source === target or unavailable. */
export function getTranslatedTranscript(lecture: Lecture): string | undefined {
  return getTranslatedTranscriptImpl(lecture);
}
