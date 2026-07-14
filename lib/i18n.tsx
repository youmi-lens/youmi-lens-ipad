/**
 * App-language (UI localization) provider for Youmi Lens.
 *
 * Wraps the pure core (lib/i18nCore.mjs) with React state + persistence:
 *   - `language`     — the active UI language code.
 *   - `setLanguage`  — switch language; persisted to AsyncStorage so it
 *                      survives restarts.
 *   - `t(key, params?)` — translate with English fallback + interpolation.
 *   - `languages`    — the picker list (code + English/native labels).
 *
 * UI chrome only. This setting never affects lecture caption language,
 * transcript/translation content, PDFs, notes, or any backend/purchase logic.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  isSupportedLanguage,
  resolveInitialLanguage,
  translate,
} from './i18nCore.mjs';

export type AppLanguage = 'en' | 'zh-Hans' | 'ja' | 'fr' | 'es' | 'ko';

export type LanguageOption = { code: AppLanguage; label: string; nativeLabel: string };

type TranslateParams = Record<string, string | number>;

type I18nContextValue = {
  language: AppLanguage;
  setLanguage: (next: AppLanguage) => void;
  t: (key: string, params?: TranslateParams) => string;
  languages: LanguageOption[];
};

const STORAGE_KEY = 'youmi.appLanguage';

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage>(DEFAULT_LANGUAGE as AppLanguage);

  // Hydrate the saved preference once. Until it resolves we render English,
  // which is the correct default anyway, so there is no visible flash.
  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (mounted) setLanguageState(resolveInitialLanguage(stored) as AppLanguage);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const setLanguage = useCallback((next: AppLanguage) => {
    if (!isSupportedLanguage(next)) return;
    setLanguageState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, []);

  const t = useCallback(
    (key: string, params?: TranslateParams) => translate(language, key, params) as string,
    [language],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ language, setLanguage, t, languages: LANGUAGES as LanguageOption[] }),
    [language, setLanguage, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Access the i18n context. Must be used within an I18nProvider. */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider');
  return ctx;
}

/** Convenience: just the translate function. */
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}

import { localizeSystemDefaultTitle as localizeSystemDefaultTitleCore } from './systemDefaultTitles.mjs';

/**
 * Render-time localization for system-generated default course/lecture/material
 * names. Thin typed wrapper over the pure core (lib/systemDefaultTitles.mjs) so
 * screens import it alongside `useT`. Display-only and non-destructive: a stored
 * name that is a known English system-default sentinel renders localized;
 * everything else (real user titles) is returned unchanged.
 */
export function localizeSystemDefaultTitle(
  translate: (key: string) => string,
  name: string,
): string;
export function localizeSystemDefaultTitle(
  translate: (key: string) => string,
  name: string | null | undefined,
): string | null | undefined;
export function localizeSystemDefaultTitle(
  translate: (key: string) => string,
  name: string | null | undefined,
): string | null | undefined {
  return localizeSystemDefaultTitleCore(translate, name) as string | null | undefined;
}
