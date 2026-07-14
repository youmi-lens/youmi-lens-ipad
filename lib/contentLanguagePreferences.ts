import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TRANSLATION_LANGUAGE,
  resolveContentLanguage,
} from './contentLanguages.mjs';
import type { ContentLanguage } from './models';

export const SOURCE_LANGUAGE_STORAGE_KEY = 'youmi.captionLanguage';
export const TRANSLATION_LANGUAGE_STORAGE_KEY = 'youmi.translationLanguage';

export async function loadContentLanguagePreferences(): Promise<{
  sourceLanguage: ContentLanguage;
  translationLanguage: ContentLanguage;
}> {
  const [source, translation] = await Promise.all([
    AsyncStorage.getItem(SOURCE_LANGUAGE_STORAGE_KEY),
    AsyncStorage.getItem(TRANSLATION_LANGUAGE_STORAGE_KEY),
  ]);
  return {
    sourceLanguage: resolveContentLanguage(source, DEFAULT_SOURCE_LANGUAGE) as ContentLanguage,
    translationLanguage: resolveContentLanguage(translation, DEFAULT_TRANSLATION_LANGUAGE) as ContentLanguage,
  };
}

export async function saveSourceLanguage(value: ContentLanguage) {
  await AsyncStorage.setItem(SOURCE_LANGUAGE_STORAGE_KEY, value);
}

export async function saveTranslationLanguage(value: ContentLanguage) {
  await AsyncStorage.setItem(TRANSLATION_LANGUAGE_STORAGE_KEY, value);
}
