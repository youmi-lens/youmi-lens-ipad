import assert from 'node:assert/strict';

import {
  captionsToTranscript,
  hasMeaningfulRecordingContent,
  mergeCaptionLines,
} from '../lib/recordingPersistence.mjs';

// ---- meaningful content detection ----------------------------------------
// Empty failed recording → discardable.
assert.equal(hasMeaningfulRecordingContent({}), false);
assert.equal(
  hasMeaningfulRecordingContent({ durationMillis: 0, hasAudio: false, captionCount: 0, markCount: 0 }),
  false,
);
// Any single signal makes it worth keeping.
assert.equal(hasMeaningfulRecordingContent({ durationMillis: 1500 }), true);
assert.equal(hasMeaningfulRecordingContent({ hasAudio: true }), true);
assert.equal(hasMeaningfulRecordingContent({ captionCount: 1 }), true);
assert.equal(hasMeaningfulRecordingContent({ markCount: 1 }), true);
assert.equal(hasMeaningfulRecordingContent({ transcriptLength: 5 }), true);
assert.equal(hasMeaningfulRecordingContent({ notesLength: 5 }), true);
assert.equal(hasMeaningfulRecordingContent({ strokeCount: 1 }), true);
assert.equal(hasMeaningfulRecordingContent({ imageCount: 1 }), true);
assert.equal(hasMeaningfulRecordingContent({ materialLinkCount: 1 }), true);
assert.equal(hasMeaningfulRecordingContent({ materialAnnotationCount: 1 }), true);

// ---- caption merge (resume append + translation update) ------------------
const prior = [
  { id: 'a', text: 'Hello', translationZh: '你好' },
  { id: 'b', text: 'World' }, // translation not yet arrived
];
const live = [
  { id: 'b', text: 'World', translationZh: '世界' }, // b gains translation
  { id: 'c', text: 'New sentence', translationZh: '新句子' }, // genuinely new
];
const merged = mergeCaptionLines(prior, live);
assert.deepEqual(
  merged.map((l) => l.id),
  ['a', 'b', 'c'],
  'existing order preserved, new appended, no duplicates',
);
assert.equal(merged[1].translationZh, '世界', 'later occurrence adds the translation');
assert.equal(merged.length, 3);
// Defensive against bad input.
assert.deepEqual(mergeCaptionLines(null, undefined), []);

// ---- transcript join ------------------------------------------------------
const { en, zh } = captionsToTranscript(merged);
assert.equal(en, 'Hello\nWorld\nNew sentence');
assert.equal(zh, '你好\n世界\n新句子');
// A line without translation contributes to English only.
const partial = captionsToTranscript([{ id: 'x', text: 'Only English' }]);
assert.equal(partial.en, 'Only English');
assert.equal(partial.zh, '');

console.log('Recording persistence tests passed.');
