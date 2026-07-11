import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_LANGUAGE,
  DICTIONARIES,
  LANGUAGES,
  isSupportedLanguage,
  resolveInitialLanguage,
  translate,
} from '../lib/i18nCore.mjs';

// ---- Basic translation per language ----
assert.equal(translate('en', 'settings.title'), 'Settings');
assert.equal(translate('zh-Hans', 'settings.title'), '设置');
assert.equal(translate('ja', 'settings.title'), '設定');
assert.equal(translate('fr', 'settings.title'), 'Réglages');

// ---- Fallback to English ----
// Unknown language code → English source of truth.
assert.equal(translate('pt', 'settings.title'), 'Settings', 'unsupported language falls back to English');
// Missing key everywhere → the raw key (visible, never blank).
assert.equal(translate('en', 'does.not.exist'), 'does.not.exist');
assert.equal(translate('ja', 'does.not.exist'), 'does.not.exist');

// Per-key fallback: a key absent from a non-English dict resolves to English.
const enOnlyKey = '__test.enOnly';
const originalEn = DICTIONARIES.en[enOnlyKey];
DICTIONARIES.en[enOnlyKey] = 'English only';
try {
  assert.equal(translate('fr', enOnlyKey), 'English only', 'missing French key falls back to English');
} finally {
  if (originalEn === undefined) delete DICTIONARIES.en[enOnlyKey];
  else DICTIONARIES.en[enOnlyKey] = originalEn;
}

// ---- Interpolation ----
assert.equal(
  translate('en', 'settings.storage.clearDetail', { courses: 2, lectures: 5 }),
  '2 courses · 5 lectures on this device',
);
// Missing params are left as-is rather than throwing.
assert.equal(
  translate('en', 'settings.storage.clearDetail', { courses: 2 }),
  '2 courses · {lectures} lectures on this device',
);

// ---- Support checks + initial language resolution (persistence helper) ----
assert.equal(isSupportedLanguage('zh-Hans'), true);
assert.equal(isSupportedLanguage('xx'), false);
assert.equal(isSupportedLanguage(null), false);
assert.equal(resolveInitialLanguage('ja'), 'ja', 'a stored supported language is kept');
assert.equal(resolveInitialLanguage('xx'), DEFAULT_LANGUAGE, 'an unsupported stored value defaults to English');
assert.equal(resolveInitialLanguage(null), DEFAULT_LANGUAGE, 'no stored value defaults to English');

// ---- Structural guard: every non-English dict only uses keys that exist in
// English (no orphaned keys that could never fall back). ----
const enKeys = new Set(Object.keys(DICTIONARIES.en));
for (const { code } of LANGUAGES) {
  if (code === 'en') continue;
  assert.deepEqual(
    Object.keys(DICTIONARIES[code]).sort(),
    Object.keys(DICTIONARIES.en).sort(),
    `locale ${code} must have exactly the same key set as English`,
  );
  for (const key of Object.keys(DICTIONARIES[code])) {
    assert.ok(enKeys.has(key), `locale ${code} has orphan key not in English: ${key}`);
  }
}

// Acceptance-critical chrome must be explicitly translated in every shipped
// non-English locale (never silently relying on the English fallback).
const highPriorityKeys = [
  'nav.record',
  'nav.courses',
  'nav.settings',
  'settings.title',
  'settings.account.editUsername',
  'settings.account.signOut',
  'settings.plan.heading',
  'settings.plan.studentBasicRow',
  'settings.plan.refresh',
  'settings.language.app',
  'settings.storage.heading',
  'settings.delete.label',
  'settings.footer',
  'recording.wordLookupHint',
  'recording.permissionTitle',
  'recording.markImportant',
  'recording.pause',
  'recording.finish',
  'processing.title',
  'processing.step.readyTitle',
  'processing.viewLecture',
  'course.detail',
  'lecture.notesTitle',
  'material.goToPage',
  'tools.clearPage',
  'tools.moveMaterial',
];
for (const key of highPriorityKeys) {
  assert.equal(typeof DICTIONARIES.en[key], 'string', `English source key is missing: ${key}`);
  for (const { code } of LANGUAGES) {
    if (code === 'en') continue;
    assert.equal(typeof DICTIONARIES[code][key], 'string', `locale ${code} is missing high-priority key: ${key}`);
  }
}

// System-generated default names + high-frequency error fallbacks must be
// explicitly translated (not silently English) in every shipped non-English
// locale, and the English source must equal the exact stored sentinel so
// English rendering stays a visual no-op.
assert.equal(DICTIONARIES.en['systemDefault.generalLectures'], 'General Lectures');
assert.equal(DICTIONARIES.en['systemDefault.untitledLecture'], 'Untitled Lecture');
assert.equal(DICTIONARIES.en['systemDefault.untitledMaterial'], 'Untitled material');
const explicitlyTranslatedKeys = [
  'systemDefault.generalLectures',
  'systemDefault.untitledLecture',
  'systemDefault.untitledMaterial',
  'auth.existingAccount',
  'auth.resendWait',
];
for (const key of explicitlyTranslatedKeys) {
  assert.equal(typeof DICTIONARIES.en[key], 'string', `English source key is missing: ${key}`);
  for (const { code } of LANGUAGES) {
    if (code === 'en') continue;
    assert.equal(typeof DICTIONARIES[code][key], 'string', `locale ${code} is missing key: ${key}`);
    assert.notEqual(
      DICTIONARIES[code][key],
      DICTIONARIES.en[key],
      `locale ${code} must actually translate ${key}, not echo English`,
    );
  }
}

// Object literals silently overwrite duplicate properties at runtime, so scan
// each source dictionary as text to catch duplicates before import evaluation.
for (const { code } of LANGUAGES) {
  const source = readFileSync(new URL(`../lib/locales/${code}.mjs`, import.meta.url), 'utf8');
  const keys = [...source.matchAll(/^\s*'([^']+)'\s*:/gm)].map((match) => match[1]);
  assert.equal(keys.length, new Set(keys).size, `locale ${code} contains duplicate translation keys`);
}

console.log('i18n core tests passed.');
