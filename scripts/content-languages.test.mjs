import assert from 'node:assert/strict';

import {
  SUPPORTED_CONTENT_LANGUAGES,
  resolveLectureLanguagePair,
  resolveIncomingTranslation,
  shouldTranslate,
} from '../lib/contentLanguages.mjs';
import { captionsToTranscript } from '../lib/recordingPersistence.mjs';

assert.deepEqual(SUPPORTED_CONTENT_LANGUAGES, ['en', 'zh-Hans', 'ja', 'fr', 'es', 'ko']);
assert.deepEqual(resolveLectureLanguagePair({}), { sourceLanguage: 'en', translationLanguage: 'zh-Hans' });
assert.deepEqual(resolveLectureLanguagePair({ sourceLanguage: 'ja', translationLanguage: 'fr' }), {
  sourceLanguage: 'ja', translationLanguage: 'fr',
});
assert.equal(shouldTranslate('ko', 'ko'), false);
assert.equal(shouldTranslate('ko', 'en'), true);
assert.equal(resolveIncomingTranslation('ja', 'ja', 'duplicate', '旧中文'), '');
assert.equal(resolveIncomingTranslation('ja', 'en', undefined, '旧中文'), '');
assert.equal(resolveIncomingTranslation('en', 'zh-Hans', undefined, '你好'), '你好');
assert.equal(resolveIncomingTranslation('fr', 'es', 'Hola', '旧中文'), 'Hola');

const generic = captionsToTranscript([{ id: '1', text: 'Bonjour', translatedText: 'Hello' }]);
assert.equal(generic.translated, 'Hello');
assert.equal(generic.zh, '');
const legacy = captionsToTranscript([{ id: '1', text: 'Hello', translationZh: '你好' }]);
assert.equal(legacy.translated, '你好');
assert.equal(legacy.zh, '你好');

console.log('content language tests passed');
