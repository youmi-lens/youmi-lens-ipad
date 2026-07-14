import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_SOURCE_LANGUAGE, DEFAULT_TRANSLATION_LANGUAGE, SUPPORTED_CONTENT_LANGUAGES } from '../lib/contentLanguages.mjs';
import { DEFAULT_LANGUAGE, LANGUAGES, resolveInitialLanguage, translate } from '../lib/i18nCore.mjs';

assert.equal(DEFAULT_LANGUAGE, 'en', 'fresh App Language must default to English');
assert.equal(DEFAULT_SOURCE_LANGUAGE, 'en', 'fresh Caption Language must default to English');
assert.equal(DEFAULT_TRANSLATION_LANGUAGE, 'zh-Hans', 'fresh Translation Language must default to Simplified Chinese');
assert.deepEqual(LANGUAGES.map(({ code }) => code), SUPPORTED_CONTENT_LANGUAGES, 'all three language settings must expose the same six languages');

for (const { code } of LANGUAGES) {
  assert.equal(resolveInitialLanguage(code), code, `saved App Language ${code} must survive relaunch`);
  assert.notEqual(translate(code, 'auth.welcomeBack'), 'auth.welcomeBack', `auth copy must resolve in ${code}`);
  if (code !== 'en') assert.notEqual(translate(code, 'auth.welcomeBack'), translate('en', 'auth.welcomeBack'), `${code} pre-login copy must not fall back to English`);
}
assert.equal(resolveInitialLanguage(null), 'en', 'no saved pre-login preference must resolve to English');
assert.equal(resolveInitialLanguage('es'), 'es', 'saved Spanish App Language must survive relaunch');
assert.equal(resolveInitialLanguage('ko'), 'ko', 'saved Korean App Language must survive relaunch');
assert.equal(DEFAULT_SOURCE_LANGUAGE, 'en', 'changing App Language must not change the Caption default');
assert.equal(DEFAULT_TRANSLATION_LANGUAGE, 'zh-Hans', 'changing App Language must not change the Translation default');

const preferenceSource = readFileSync(new URL('../lib/contentLanguagePreferences.ts', import.meta.url), 'utf8');
const sourceKey = preferenceSource.match(/SOURCE_LANGUAGE_STORAGE_KEY\s*=\s*'([^']+)'/)?.[1];
const translationKey = preferenceSource.match(/TRANSLATION_LANGUAGE_STORAGE_KEY\s*=\s*'([^']+)'/)?.[1];
assert.ok(sourceKey && translationKey);
assert.notEqual(sourceKey, translationKey, 'Caption and Translation preferences require independent storage keys');

const i18nSource = readFileSync(new URL('../lib/i18n.tsx', import.meta.url), 'utf8');
const appKey = i18nSource.match(/STORAGE_KEY\s*=\s*'([^']+)'/)?.[1];
assert.ok(appKey);
assert.notEqual(appKey, sourceKey, 'App Language must not share Caption Language storage');
assert.notEqual(appKey, translationKey, 'App Language must not share Translation Language storage');

const settingsSource = readFileSync(new URL('../app/(tabs)/settings.tsx', import.meta.url), 'utf8');
assert.match(settingsSource, /languages\.map\(/, 'App Language selector must render the authoritative six-language registry');

const authSource = readFileSync(new URL('../lib/auth.tsx', import.meta.url), 'utf8');
for (const key of [appKey, sourceKey, translationKey]) {
  assert.equal(authSource.includes(key), false, `logout/auth state must not reset saved preference ${key}`);
}

console.log('default language preference tests passed.');
