/**
 * Pure i18n core for Youmi Lens — dictionary lookup, English fallback and
 * parameter interpolation, with no React or storage dependencies so it can be
 * unit-tested directly and reused by the React provider (lib/i18n.tsx).
 *
 * Scope: UI-chrome strings only. This never touches lecture captions,
 * transcripts, summaries, notes, PDFs or any user/AI content.
 *
 * Adding a language later requires a complete lib/locales/<code>.mjs dictionary,
 * a DICTIONARIES entry and a LANGUAGES entry. Runtime fallback remains defensive,
 * while completeness tests prevent partial UI locales from shipping.
 */
import en from './locales/en.mjs';
import es from './locales/es.mjs';
import fr from './locales/fr.mjs';
import ja from './locales/ja.mjs';
import ko from './locales/ko.mjs';
import zhHans from './locales/zh-Hans.mjs';

export const DEFAULT_LANGUAGE = 'en';

/** All shipped dictionaries, keyed by stable BCP-47-ish language code. */
export const DICTIONARIES = {
  en,
  'zh-Hans': zhHans,
  ja,
  fr,
  es,
  ko,
};

/**
 * Supported languages, in display order. `nativeLabel` is shown in the picker
 * so each option reads in its own language; `label` is the English name.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh-Hans', label: 'Simplified Chinese', nativeLabel: '简体中文' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어' },
];

/** Whether a code names a shipped dictionary. */
export function isSupportedLanguage(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(DICTIONARIES, code);
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] != null ? String(params[name]) : match,
  );
}

/**
 * Translate a key for a language, falling back to English, then to the raw key.
 *
 *   1. exact match in the requested language,
 *   2. else English (the source of truth),
 *   3. else the key itself (so a missing string is visible, never blank).
 *
 * @param {string} language language code
 * @param {string} key dot-namespaced string key
 * @param {Record<string, string|number>} [params] interpolation values for {name} slots
 * @returns {string}
 */
export function translate(language, key, params) {
  const primary = DICTIONARIES[language];
  const fallback = DICTIONARIES[DEFAULT_LANGUAGE];
  const value =
    (primary && primary[key] != null ? primary[key] : undefined) ??
    (fallback && fallback[key] != null ? fallback[key] : undefined);
  if (value == null) return key;
  return interpolate(value, params);
}

/**
 * Resolve the language to start in: a persisted, still-supported preference if
 * present, otherwise English. Device locale is intentionally NOT auto-applied,
 * so existing users are never surprised by a suddenly non-English UI.
 *
 * @param {string|null|undefined} stored persisted preference
 * @returns {string}
 */
export function resolveInitialLanguage(stored) {
  return isSupportedLanguage(stored) ? stored : DEFAULT_LANGUAGE;
}
