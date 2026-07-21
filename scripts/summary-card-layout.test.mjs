import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SUMMARY_CARD_STYLE,
  SUMMARY_PAGE_SCROLL_STYLE,
  SUMMARY_STACK_STYLE,
} from '../lib/summaryLayout.mjs';

const source = readFileSync(new URL('../app/lecture/[id].tsx', import.meta.url), 'utf8');

assert.match(
  source,
  /<GlassCard\s+style=\{styles\.summaryCard\}/,
  'source summary remains a full-width GlassCard',
);
assert.match(
  source,
  /\{hasTranslation \? \(\s*<GlassCard\s+style=\{styles\.summaryCard\}/,
  'translated summary card mounts when languages differ',
);
assert.doesNotMatch(
  source,
  /hasTranslation && translatedSummary \?/,
  'translated summary card must mount before translated content is ready',
);
assert.deepEqual(SUMMARY_STACK_STYLE, {
  flexDirection: 'column',
  alignItems: 'stretch',
  width: '100%',
});
assert.deepEqual(
  SUMMARY_PAGE_SCROLL_STYLE,
  { flex: 1 },
  'the existing page-level ScrollView must be bounded so long summaries scroll',
);
assert.match(
  source,
  /<ScrollView\s+style=\{styles\.pageScroll\}\s+contentContainerStyle=\{styles\.scroll\}/,
  'summary content must remain inside the bounded page-level ScrollView',
);
assert.deepEqual(SUMMARY_CARD_STYLE, { width: '100%', minHeight: 112 });
assert.doesNotMatch(source, /summaryGrid|summaryGridCompact/);
assert.equal('height' in SUMMARY_CARD_STYLE, false);
assert.equal('maxHeight' in SUMMARY_CARD_STYLE, false);
assert.equal('overflow' in SUMMARY_CARD_STYLE, false);
assert.match(
  source,
  /openSummaryEditor\('source'\)/,
  'English/source summary card opens the dedicated editor',
);
assert.match(
  source,
  /openSummaryEditor\('translated'\)/,
  'Chinese/translated summary card opens the dedicated editor',
);

const sourceCardIndex = source.indexOf('getSummarySectionLabel(sourceLanguage)');
const translatedCardIndex = source.indexOf('getSummarySectionLabel(translationLanguage)');
assert.ok(sourceCardIndex >= 0 && translatedCardIndex > sourceCardIndex, 'source card must render first');
assert.match(
  source.slice(sourceCardIndex, translatedCardIndex + 200),
  /\{hasTranslation \? \(/,
  'translated card exists only when the saved languages differ',
);

console.log('Summary card layout regression tests passed.');
