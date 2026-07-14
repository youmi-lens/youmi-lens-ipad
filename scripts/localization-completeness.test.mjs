import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SUPPORTED_CONTENT_LANGUAGES } from '../lib/contentLanguages.mjs';
import { DICTIONARIES, LANGUAGES, translate } from '../lib/i18nCore.mjs';

const registryCodes = LANGUAGES.map(({ code }) => code);
assert.equal(new Set(registryCodes).size, registryCodes.length, 'App Language registry contains duplicates');
assert.deepEqual(registryCodes, ['en', 'zh-Hans', 'ja', 'fr', 'es', 'ko'], 'App Language must match the six content languages');
assert.deepEqual(registryCodes, SUPPORTED_CONTENT_LANGUAGES, 'App, Caption and Translation language sets must match');

const englishKeys = Object.keys(DICTIONARIES.en).sort();
const screenGroups = {
  Auth: ['auth.'],
  Home: ['home.'],
  Courses: ['courses.', 'createCourse.', 'course.'],
  'Lecture Detail': ['lecture.'],
  Processing: ['processing.'],
  Settings: ['settings.'],
  Recording: ['recording.'],
  Materials: ['material.', 'tools.'],
  'Mini Caption': ['mini.', 'captions.'],
  Plans: ['plans.'],
  'Recently Deleted': ['deleted.'],
  Shared: ['common.', 'status.', 'deleted.', 'rename.'],
};

for (const { code } of LANGUAGES) {
  const dictionary = DICTIONARIES[code];
  assert.deepEqual(Object.keys(dictionary).sort(), englishKeys, `${code} must not rely on English fallback keys`);
  for (const [group, prefixes] of Object.entries(screenGroups)) {
    const keys = englishKeys.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
    assert.ok(keys.length > 0, `${group} must contain locale keys`);
    for (const key of keys) {
      assert.equal(typeof dictionary[key], 'string', `${group}/${code} missing ${key}`);
      assert.ok(dictionary[key].trim(), `${group}/${code} has blank ${key}`);
    }
  }
}

for (const code of ['es', 'ko']) {
  assert.ok(DICTIONARIES[code], `${code} locale module must exist`);
  for (const key of englishKeys) {
    assert.equal(translate(code, key), DICTIONARIES[code][key], `${code}/${key} must resolve without English fallback`);
  }
}

for (const code of ['es', 'ko']) {
  const dictionary = DICTIONARIES[code];
  assert.match(dictionary['auth.newHere'], /Youmi Lens/u, `${code} must preserve Youmi Lens`);
  assert.match(dictionary['auth.continueApple'], /Apple/u, `${code} must preserve Apple`);
  assert.match(dictionary['auth.continueGoogle'], /Google/u, `${code} must preserve Google`);
  assert.match(dictionary['auth.brandDescription'], /AI/u, `${code} must preserve AI`);
  assert.match(dictionary['auth.brandDescription'], /iPad/u, `${code} must preserve iPad`);
  assert.match(dictionary['auth.brandDescription'], /Mac/u, `${code} must preserve Mac`);
}

const koreanSourceValues = Object.values(DICTIONARIES.ko).join('\n');
assert.deepEqual([DICTIONARIES.es['home.title'], DICTIONARIES.ko['processing.title'], DICTIONARIES.ko['lecture.tab.marked']], ['Tus clases, grabadas y listas para repasar', '수업 내용을 정리하고 있어요', '중요 표시'], 'high-risk Spanish/Korean product copy must stay native and unambiguous');
for (const transliteration of [/유미/u, /애플/u, /구글/u, /아이패드/u]) {
  assert.equal(transliteration.test(koreanSourceValues), false, `Korean locale transliterates protected proper noun ${transliteration}`);
}

const forbiddenBrandVariants = [/有米镜头/u, /ユーミー?レンズ/u, /Youmi\s+レンズ/u, /유미\s*렌즈/u];
for (const { code } of LANGUAGES) {
  for (const [key, value] of Object.entries(DICTIONARIES[code])) {
    for (const pattern of forbiddenBrandVariants) {
      assert.equal(pattern.test(value), false, `${code}/${key} translates the Youmi Lens brand`);
    }
    if (/Youmi/u.test(value)) {
      assert.ok(value.includes('Youmi Lens'), `${code}/${key} must spell the full product name as Youmi Lens`);
    }
  }
}

const lectureCriticalKeys = [
  'lecture.tab.summary', 'lecture.tab.transcript', 'lecture.tab.marked', 'lecture.tab.notes',
  'lecture.skipBack', 'lecture.skipForward', 'lecture.handwritingCount',
  'lecture.transcriptPending', 'lecture.summaryPending', 'lecture.audioUnavailable',
  'processing.viewLecture', 'processing.backToLectures',
];
for (const { code } of LANGUAGES) {
  for (const key of lectureCriticalKeys) assert.ok(DICTIONARIES[code][key]?.trim(), `${code} missing ${key}`);
}

for (const { code } of LANGUAGES) {
  const source = readFileSync(new URL(`../lib/locales/${code}.mjs`, import.meta.url), 'utf8');
  const keys = [...source.matchAll(/['\"]([^'\"\n]+)['\"]\s*:/g)].map((match) => match[1]);
  assert.equal(keys.length, new Set(keys).size, `locale ${code} contains duplicate translation keys`);
}

console.log(`localization completeness tests passed for ${registryCodes.length} App UI languages.`);
