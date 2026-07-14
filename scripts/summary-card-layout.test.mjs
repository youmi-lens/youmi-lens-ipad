import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app/lecture/[id].tsx', import.meta.url), 'utf8');

assert.match(source, /<GlassCard style=\{styles\.summaryCard\}>/);
assert.match(source, /\{hasTranslation \? \(\s*<GlassCard style=\{styles\.summaryCard\}>/);
assert.doesNotMatch(
  source,
  /hasTranslation && translatedSummary \?/,
  'translated summary card must mount before translated content is ready',
);
assert.match(source, /summaryCard: \{ flex: 1 \}/, 'side-by-side cards must have equal width');

console.log('Summary card layout regression tests passed.');
