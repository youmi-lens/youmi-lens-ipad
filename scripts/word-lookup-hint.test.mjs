import assert from 'node:assert/strict';

import { shouldShowWordLookupHint } from '../lib/wordLookupHintState.mjs';

const base = { seen: false, lookupAvailable: true, captionsVisible: true };

// Happy path: unseen, lookup available, captions on screen → show.
assert.equal(shouldShowWordLookupHint({ ...base }), true);

// Already seen → never show again.
assert.equal(shouldShowWordLookupHint({ ...base, seen: true }), false);

// Native lookup unavailable → do not show (and, upstream, do not mark seen).
assert.equal(shouldShowWordLookupHint({ ...base, lookupAvailable: false }), false);

// No captions visible → nothing to double-tap, so no hint.
assert.equal(shouldShowWordLookupHint({ ...base, captionsVisible: false }), false);

// Defensive defaults: empty input never shows.
assert.equal(shouldShowWordLookupHint({}), false);
assert.equal(shouldShowWordLookupHint(), false);

console.log('Word lookup hint tests passed.');
