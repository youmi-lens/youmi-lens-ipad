import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DICTIONARIES, LANGUAGES } from '../lib/i18nCore.mjs';

const formatSource = readFileSync(new URL('../lib/format.ts', import.meta.url), 'utf8');
const localeMap = Object.fromEntries(
  [...formatSource.matchAll(/^\s*(?:'([^']+)'|(\w+)):\s*'([^']+-[^']+)',?$/gm)]
    .map((match) => [match[1] ?? match[2], match[3]]),
);

assert.equal(localeMap.es, 'es-ES', 'Spanish App Language requires Spanish date formatting');
assert.equal(localeMap.ko, 'ko-KR', 'Korean App Language requires Korean date formatting');

for (const { code } of LANGUAGES) {
  assert.ok(localeMap[code], `${code} requires an explicit date locale`);
  const dictionary = DICTIONARIES[code];
  for (const key of [
    'courses.lectureCount', 'courses.lectureCountOther',
    'course.pageCount', 'course.pageCountOne',
    'lecture.handwritingCount', 'lecture.handwritingCountOne',
    'settings.storage.clearDetail',
  ]) assert.ok(dictionary[key]?.trim(), `${code} missing count format ${key}`);
}

const sample = new Date('2026-07-14T12:00:00Z');
assert.notEqual(
  new Intl.DateTimeFormat(localeMap.es, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(sample),
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(sample),
);
assert.match(new Intl.DateTimeFormat(localeMap.ko, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(sample), /2026/);

console.log('six-language date and count formatting tests passed.');
