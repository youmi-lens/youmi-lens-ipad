/**
 * Language-aware access to a lecture's transcript and summary.
 *
 * Youmi Lens V1 is English lecture audio + English live captions, with Chinese
 * as translation / study support. After post-class processing the backend
 * provides:
 *   - `transcript`    — English transcript
 *   - `transcriptZh`  — Chinese transcript, translated from the English one
 *   - `summaryEn` / `summaryZh` — English + Chinese summaries
 *
 * These helpers read whichever language a screen asks for, keyed by
 * `LanguageCode`, and return `undefined` when that language has no content
 * yet — so the UI shows an honest placeholder instead of faking content.
 *
 * The `LanguageCode` type and the label table are kept general so more
 * languages can be added later without reworking call sites; V1 only ever
 * uses 'en' and 'zh', and language order is fixed (English first).
 */
import type { Lecture } from './models';

export type LanguageCode = 'en' | 'zh';

/** Trimmed transcript text for a language, or undefined when unavailable. */
export function getLectureTranscriptByLanguage(
  lecture: Lecture,
  lang: LanguageCode,
): string | undefined {
  const raw = lang === 'zh' ? lecture.transcriptZh : lecture.transcript;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Trimmed summary text for a language, or undefined when unavailable. */
export function getLectureSummaryByLanguage(
  lecture: Lecture,
  lang: LanguageCode,
): string | undefined {
  const raw = lang === 'zh' ? lecture.summaryZh : lecture.summaryEn;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Section headers per language. New languages add a row here — screens never
 * hardcode "ENGLISH TRANSCRIPT" / "中文转录" pairs directly in JSX.
 */
const SECTION_LABELS: Record<LanguageCode, { transcript: string; summary: string }> = {
  en: { transcript: 'ENGLISH TRANSCRIPT', summary: 'ENGLISH SUMMARY' },
  zh: { transcript: '中文转录', summary: '中文总结' },
};

export function getTranscriptSectionLabel(lang: LanguageCode): string {
  return SECTION_LABELS[lang]?.transcript ?? `${lang.toUpperCase()} TRANSCRIPT`;
}

export function getSummarySectionLabel(lang: LanguageCode): string {
  return SECTION_LABELS[lang]?.summary ?? `${lang.toUpperCase()} SUMMARY`;
}
