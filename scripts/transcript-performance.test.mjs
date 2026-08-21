import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTranscriptReadItems,
  chunkTranscript,
  clearTranscriptReadItemsCache,
  getCachedTranscriptReadItems,
  prepareTranscriptReadItems,
  TRANSCRIPT_CHUNK_TARGET_CHARS,
} from '../lib/transcriptChunks.mjs';

function fixture(minutes) {
  const sentence = 'This is a realistic lecture sentence with terminology, examples, and explanatory context. ';
  return Array.from({ length: Math.ceil(minutes * 160 / 12) }, (_, index) =>
    `${index % 6 === 0 ? '\n\n' : ''}${sentence}`,
  ).join('');
}

const counts = [];
for (const minutes of [10, 20, 40, 60, 90]) {
  const text = fixture(minutes);
  const chunks = chunkTranscript(text);
  assert.equal(chunks.join(''), text, `${minutes}-minute fixture is lossless`);
  assert.ok(chunks.every((chunk) => chunk.length <= TRANSCRIPT_CHUNK_TARGET_CHARS + 100));
  const repeat = chunkTranscript(text);
  assert.deepEqual(repeat, chunks, `${minutes}-minute chunking is deterministic`);
  const items = buildTranscriptReadItems([{ side: 'source', language: 'en', label: 'ENGLISH TRANSCRIPT', text }]);
  assert.deepEqual(items.map((item) => item.key), buildTranscriptReadItems([{ side: 'source', language: 'en', label: 'ENGLISH TRANSCRIPT', text }]).map((item) => item.key));
  counts.push({ minutes, chars: text.length, chunks: chunks.length });
}
assert.ok(counts[4].chunks < counts[0].chunks * 10, 'chunk count scales approximately linearly');

const bilingual = buildTranscriptReadItems([
  { side: 'source', language: 'en', label: 'ENGLISH TRANSCRIPT', text: fixture(40) },
  { side: 'translated', language: 'zh-Hans', label: '中文转录', text: fixture(40) },
]);
assert.equal(new Set(bilingual.map((item) => item.key)).size, bilingual.length);

clearTranscriptReadItemsCache();
const cacheSections = [{ side: 'source', language: 'en', label: 'ENGLISH TRANSCRIPT', text: fixture(40) }];
assert.equal(getCachedTranscriptReadItems('lecture-1:version-1'), undefined, 'cold cache reports a MISS before prewarm');
const prepared = prepareTranscriptReadItems('lecture-1:version-1', cacheSections);
assert.equal(getCachedTranscriptReadItems('lecture-1:version-1'), prepared, 'completed prewarm turns the next lookup into a HIT');
assert.equal(prepareTranscriptReadItems('lecture-1:version-1', cacheSections), prepared, 'repeat tab opens do not regenerate rows');
assert.equal(getCachedTranscriptReadItems('lecture-1:version-1').find((item) => item.type === 'chunk'), prepared.find((item) => item.type === 'chunk'), 'source chunk identity stays stable');
const changedSections = [{ ...cacheSections[0], text: `${cacheSections[0].text}!` }];
const changed = prepareTranscriptReadItems('lecture-1:version-2', changedSections);
assert.notEqual(changed, prepared, 'content/version changes invalidate prepared row identity');
const cachedBilingual = prepareTranscriptReadItems('lecture-2:version-1', [
  { side: 'source', language: 'en', label: 'ENGLISH TRANSCRIPT', text: fixture(40) },
  { side: 'translated', language: 'zh-Hans', label: '中文转录', text: fixture(40) },
]);
assert.equal(prepareTranscriptReadItems('lecture-2:version-1', [
  { side: 'source', language: 'en', label: 'ENGLISH TRANSCRIPT', text: fixture(40) },
  { side: 'translated', language: 'zh-Hans', label: '中文转录', text: fixture(40) },
]).find((item) => item.side === 'translated' && item.type === 'chunk'), cachedBilingual.find((item) => item.side === 'translated' && item.type === 'chunk'), 'translated chunk identity stays stable');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screen = fs.readFileSync(path.join(root, 'app/lecture/[id].tsx'), 'utf8');
const list = fs.readFileSync(path.join(root, 'components/TranscriptReadList.tsx'), 'utf8');
assert.match(screen, /<TranscriptReadList/);
assert.doesNotMatch(screen, /<NativeLookupText style=\{styles\.bodyText\}>\{sourceTranscript\}/);
assert.match(list, /export const TranscriptReadList = memo/);
assert.match(list, /<FlatList/);
// Product Polish V1 (Phase 8) deliberately raised this from 2.
//
// At 2 the list committed a header plus a single paragraph, so an iPad-height
// viewport opened mostly empty and the remainder visibly trickled in batch by
// batch — the product owner's "header, one paragraph, blank region" report.
// The invariant this assertion protects was never "exactly 2"; it was "the
// first batch is BOUNDED and the document is not mounted synchronously". That
// invariant is asserted directly below, and by scripts/navigation-polish.test.mjs.
const initialRows = Number(list.match(/const INITIAL_VIEWPORT_ROWS = (\d+)/)[1]);
assert.ok(initialRows >= 6, `first paint must fill a viewport, saw ${initialRows} rows`);
assert.ok(initialRows <= 12, `first paint must stay a bounded batch, saw ${initialRows} rows`);
assert.match(list, /initialNumToRender=\{INITIAL_VIEWPORT_ROWS\}/, 'first batch is the named viewport constant');
assert.match(list, /maxToRenderPerBatch=\{8\}/, 'normal virtualized batching remains bounded');
assert.match(list, /windowSize=\{7\}/, 'virtualization window is unchanged by the first-viewport fix');
assert.match(list, /selectable/);
assert.doesNotMatch(list, /InteractionManager\.runAfterInteractions/, 'warm cache never waits behind the global interaction queue');
assert.match(list, /requestAnimationFrame\(\(\) => setListMountReady\(true\)\)/, 'warm cache mounts on the frame after the shell commit');
assert.match(list, /requestAnimationFrame\(\(\) => \{\s*prepareTranscriptReadItems/, 'Lecture-detail prewarm starts after its first frame');
assert.match(list, /if \(!listMountReady \|\| !items\)/, 'every Transcript open commits a shell before native list cells mount');
assert.match(list, /styles\.skeletonBody/, 'cold cache has a subtle first-content placeholder');
assert.match(screen, /<TranscriptReadPrewarmer/);
assert.doesNotMatch(
  screen,
  /transcriptDocumentVersion\s*=[\s\S]{0,180}lecture\.uploadedAt/,
  'row-wide metadata updates do not invalidate an unchanged Transcript read model',
);
assert.doesNotMatch(list, /buildTranscriptReadItems\(sections\)/, 'Transcript mount does not synchronously build all rows');
assert.doesNotMatch(fs.readFileSync(path.join(root, 'lib/transcriptChunks.mjs'), 'utf8'), /sectionsMatch|section\.text === candidate\.text/, 'cache hits do not validate full document strings');
const header = fs.readFileSync(path.join(root, 'components/LectureSectionHeader.tsx'), 'utf8');
assert.equal((screen.match(/<LectureSectionHeader/g) ?? []).length, 4, 'Summary, translated Summary, Marked, and Notes use canonical header');
assert.match(list, /<LectureSectionHeader/);
assert.match(header, /minHeight: 30/);
assert.match(header, /fontSize: fontSize\.xs/);
assert.match(header, /lineHeight: 15/);
assert.match(header, /width: 30/);
assert.match(header, /height: 30/);
assert.match(list, /accessibilityLabel=\{label\}/);
assert.doesNotMatch(list, /gap: 1/, 'Transcript does not insert a divider gap between header and body');
assert.doesNotMatch(list, /borderBottomWidth[^\n]*styles\.header/, 'Transcript header does not own a bottom divider');
assert.match(list, /firstChunk: \{ paddingTop: 0 \}/, 'Transcript uses the shared header-to-body gap without extra padding');
assert.match(screen, /hitSlop=\{7\}[\s\S]*styles\.noteExportBtn/);
assert.match(screen, /noteExportBtn: \{[\s\S]*minHeight: 30/);

console.log('Transcript performance fixtures passed:', JSON.stringify(counts));
