/**
 * Tests for render-time localization of system-generated default names.
 *
 * Guarantees:
 *   - each known English sentinel localizes per active UI language,
 *   - genuine user-entered / user-renamed titles pass through UNCHANGED,
 *   - matching is exact + trimmed (no fuzzy / substring / case-insensitive
 *     matches that could catch a real user title), and
 *   - non-string inputs pass through so `?? fallback` render logic still works.
 *
 * This is a display-only concern — it never touches stored data or identity.
 */
import assert from 'node:assert/strict';

import { translate } from '../lib/i18nCore.mjs';
import {
  SYSTEM_DEFAULT_TITLE_KEYS,
  localizeSystemDefaultTitle,
} from '../lib/systemDefaultTitles.mjs';

/** Bind a language-specific `t`, exactly as the app's provider does. */
const tFor = (lang) => (key) => translate(lang, key);

// ---- Every sentinel maps to a key that exists in English (source of truth) ----
for (const [sentinel, key] of Object.entries(SYSTEM_DEFAULT_TITLE_KEYS)) {
  assert.equal(
    translate('en', key),
    sentinel,
    `English value for ${key} must equal its stored sentinel "${sentinel}"`,
  );
}

// ---- System defaults localize per language ----
const t_en = tFor('en');
const t_zh = tFor('zh-Hans');
const t_ja = tFor('ja');
const t_fr = tFor('fr');

// English display is a visual no-op (equals the stored value).
assert.equal(localizeSystemDefaultTitle(t_en, 'General Lectures'), 'General Lectures');
assert.equal(localizeSystemDefaultTitle(t_en, 'Untitled Lecture'), 'Untitled Lecture');
assert.equal(localizeSystemDefaultTitle(t_en, 'Untitled material'), 'Untitled material');

// Non-English UI shows the localized label and never the raw English.
for (const [t, lang] of [[t_zh, 'zh-Hans'], [t_ja, 'ja'], [t_fr, 'fr']]) {
  for (const sentinel of Object.keys(SYSTEM_DEFAULT_TITLE_KEYS)) {
    const localized = localizeSystemDefaultTitle(t, sentinel);
    assert.equal(typeof localized, 'string');
    assert.notEqual(localized, sentinel, `${lang} must localize "${sentinel}", got raw English`);
    assert.equal(localized, translate(lang, SYSTEM_DEFAULT_TITLE_KEYS[sentinel]));
  }
}

// ---- User-created / user-renamed titles pass through UNCHANGED ----
for (const t of [t_en, t_zh, t_ja, t_fr]) {
  assert.equal(localizeSystemDefaultTitle(t, 'Biology 101'), 'Biology 101');
  assert.equal(localizeSystemDefaultTitle(t, 'My General Lectures'), 'My General Lectures');
  assert.equal(localizeSystemDefaultTitle(t, 'General Lectures 2'), 'General Lectures 2');
  // Case-sensitive: a differently-cased title is a real user title, left as-is.
  assert.equal(localizeSystemDefaultTitle(t, 'general lectures'), 'general lectures');
  assert.equal(localizeSystemDefaultTitle(t, '常规讲座'), '常规讲座');
  assert.equal(localizeSystemDefaultTitle(t, ''), '');
}

// ---- Matching is trimmed (our stored sentinels are clean, but be defensive) ----
assert.equal(localizeSystemDefaultTitle(t_zh, '  General Lectures  '), translate('zh-Hans', 'systemDefault.generalLectures'));

// ---- Non-string inputs pass straight through (keeps `?? fallback` working) ----
assert.equal(localizeSystemDefaultTitle(t_zh, undefined), undefined);
assert.equal(localizeSystemDefaultTitle(t_zh, null), null);
assert.equal(localizeSystemDefaultTitle(t_zh, 42), 42);

console.log('system-default-titles tests passed.');
