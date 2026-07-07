import assert from 'node:assert/strict';

import { isNearBottom, NEAR_BOTTOM_THRESHOLD_PX } from '../lib/captionFeed.mjs';

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

console.log('Caption feed tests passed.');
