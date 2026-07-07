import assert from 'node:assert/strict';

import { historyLineCount, isNearBottom, NEAR_BOTTOM_THRESHOLD_PX } from '../lib/captionFeed.mjs';

// At the very bottom → keep following.
assert.equal(isNearBottom(0), true);
// Just within the threshold → still following (small layout jitter shouldn't drop follow).
assert.equal(isNearBottom(NEAR_BOTTOM_THRESHOLD_PX), true);
// Clearly scrolled up → stop following so the user isn't yanked back to live.
assert.equal(isNearBottom(NEAR_BOTTOM_THRESHOLD_PX + 1), false);
assert.equal(isNearBottom(600), false);
// No metrics yet (NaN) → default to following the live edge.
assert.equal(isNearBottom(Number.NaN), true);
// Custom threshold is honoured.
assert.equal(isNearBottom(40, 30), false);
assert.equal(isNearBottom(20, 30), true);

// History excludes the fixed current caption.
// While speaking, the live partial is the current block → all finalized are history.
assert.equal(historyLineCount(5, true), 5);
assert.equal(historyLineCount(0, true), 0);
// Between sentences, the newest finalized line is the fixed current → excluded.
assert.equal(historyLineCount(5, false), 4);
assert.equal(historyLineCount(1, false), 0);
assert.equal(historyLineCount(0, false), 0);
// Defensive against bad input.
assert.equal(historyLineCount(Number.NaN, false), 0);

console.log('Caption feed tests passed.');
