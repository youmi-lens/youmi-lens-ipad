export const SUPPORTED_CONTENT_LANGUAGES = ['en', 'zh-Hans', 'ja', 'fr', 'es', 'ko'];
export const DEFAULT_SOURCE_LANGUAGE = 'en';
export const DEFAULT_TRANSLATION_LANGUAGE = 'zh-Hans';

export function isContentLanguage(value) {
  return SUPPORTED_CONTENT_LANGUAGES.includes(value);
}

export function resolveContentLanguage(value, fallback) {
  return isContentLanguage(value) ? value : fallback;
}

export function resolveLectureLanguagePair(lecture = {}) {
  return {
    sourceLanguage: resolveContentLanguage(lecture.sourceLanguage, DEFAULT_SOURCE_LANGUAGE),
    translationLanguage: resolveContentLanguage(lecture.translationLanguage, DEFAULT_TRANSLATION_LANGUAGE),
  };
}

export function shouldTranslate(sourceLanguage, translationLanguage) {
  return sourceLanguage !== translationLanguage;
}

export function resolveIncomingTranslation(sourceLanguage, translationLanguage, translatedText, translationZh) {
  if (!shouldTranslate(sourceLanguage, translationLanguage)) return '';
  if (typeof translatedText === 'string' && translatedText.trim()) return translatedText;
  if (translationLanguage === 'zh-Hans' && typeof translationZh === 'string') return translationZh;
  return '';
}

// ── Lecture summary/transcript section labels + content resolution ──────────────
//
// Centralized so screens never hardcode "ENGLISH SUMMARY" / "中文转录" pairs. Each
// label is fixed per content language (English caption for en/ja/fr/es/ko; native
// for zh-Hans), matching the product spec. New languages add one row here.

const SECTION_LABELS = {
  en: { transcript: 'ENGLISH TRANSCRIPT', summary: 'ENGLISH SUMMARY' },
  'zh-Hans': { transcript: '中文转录', summary: '中文摘要' },
  ja: { transcript: 'JAPANESE TRANSCRIPT', summary: 'JAPANESE SUMMARY' },
  fr: { transcript: 'FRENCH TRANSCRIPT', summary: 'FRENCH SUMMARY' },
  es: { transcript: 'SPANISH TRANSCRIPT', summary: 'SPANISH SUMMARY' },
  ko: { transcript: 'KOREAN TRANSCRIPT', summary: 'KOREAN SUMMARY' },
};

export function getTranscriptSectionLabel(language) {
  const lang = resolveContentLanguage(language, DEFAULT_SOURCE_LANGUAGE);
  return SECTION_LABELS[lang]?.transcript ?? `${String(lang).toUpperCase()} TRANSCRIPT`;
}

export function getSummarySectionLabel(language) {
  const lang = resolveContentLanguage(language, DEFAULT_SOURCE_LANGUAGE);
  return SECTION_LABELS[lang]?.summary ?? `${String(lang).toUpperCase()} SUMMARY`;
}

function trimmedOrUndefined(value) {
  const t = typeof value === 'string' ? value.trim() : '';
  return t ? t : undefined;
}

/** Legacy summary column appropriate to a resolved language (en → summaryEn, zh-Hans → summaryZh). */
function legacySummaryByLanguage(lecture, language) {
  if (language === 'en') return trimmedOrUndefined(lecture?.summaryEn);
  if (language === 'zh-Hans') return trimmedOrUndefined(lecture?.summaryZh);
  return undefined;
}

/** Source-language summary: generic authoritative, else language-based legacy fallback. */
export function getSourceSummary(lecture) {
  const generic = trimmedOrUndefined(lecture?.sourceSummary);
  if (generic) return generic;
  const { sourceLanguage } = resolveLectureLanguagePair(lecture ?? {});
  return legacySummaryByLanguage(lecture, sourceLanguage);
}

/** Translated summary: undefined when source === target; generic authoritative, else legacy fallback. */
export function getTranslatedSummary(lecture) {
  const { sourceLanguage, translationLanguage } = resolveLectureLanguagePair(lecture ?? {});
  if (!shouldTranslate(sourceLanguage, translationLanguage)) return undefined;
  const generic = trimmedOrUndefined(lecture?.translatedSummary);
  if (generic) return generic;
  return legacySummaryByLanguage(lecture, translationLanguage);
}

/** Source-language transcript. */
export function getSourceTranscript(lecture) {
  return trimmedOrUndefined(lecture?.transcript);
}

/** Translated transcript: undefined when source === target; generic, else legacy transcriptZh only for zh-Hans. */
export function getTranslatedTranscript(lecture) {
  const { sourceLanguage, translationLanguage } = resolveLectureLanguagePair(lecture ?? {});
  if (!shouldTranslate(sourceLanguage, translationLanguage)) return undefined;
  const generic = trimmedOrUndefined(lecture?.translatedTranscript);
  if (generic) return generic;
  if (translationLanguage === 'zh-Hans') return trimmedOrUndefined(lecture?.transcriptZh);
  return undefined;
}
