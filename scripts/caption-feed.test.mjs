import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTION_FOLLOW_MODE,
  CAPTION_SCROLL_ORIGIN,
  followModeAfterScroll,
  historyLineCount,
  isNearBottom,
  NEAR_BOTTOM_THRESHOLD_PX,
  shouldRequestCaptionAutoScroll,
} from '../lib/captionFeed.mjs';

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
assert.equal(isNearBottom(-500), true);

// Only user-originated geometry can change follow intent.
assert.equal(followModeAfterScroll({
  mode: CAPTION_FOLLOW_MODE.FOLLOWING,
  origin: CAPTION_SCROLL_ORIGIN.PROGRAMMATIC,
  distanceFromBottomPx: 10_000,
}), CAPTION_FOLLOW_MODE.FOLLOWING);
assert.equal(followModeAfterScroll({
  mode: CAPTION_FOLLOW_MODE.FOLLOWING,
  origin: CAPTION_SCROLL_ORIGIN.NONE,
  distanceFromBottomPx: 10_000,
}), CAPTION_FOLLOW_MODE.FOLLOWING);
assert.equal(followModeAfterScroll({
  mode: CAPTION_FOLLOW_MODE.FOLLOWING,
  origin: CAPTION_SCROLL_ORIGIN.USER,
  distanceFromBottomPx: 400,
}), CAPTION_FOLLOW_MODE.BROWSING_HISTORY);
assert.equal(followModeAfterScroll({
  mode: CAPTION_FOLLOW_MODE.BROWSING_HISTORY,
  origin: CAPTION_SCROLL_ORIGIN.USER,
  distanceFromBottomPx: 0,
}), CAPTION_FOLLOW_MODE.FOLLOWING);

assert.equal(shouldRequestCaptionAutoScroll({ mode: CAPTION_FOLLOW_MODE.FOLLOWING, reason: 'final-caption' }), true);
assert.equal(shouldRequestCaptionAutoScroll({ mode: CAPTION_FOLLOW_MODE.FOLLOWING, reason: 'interim-caption' }), true);
assert.equal(shouldRequestCaptionAutoScroll({ mode: CAPTION_FOLLOW_MODE.FOLLOWING, reason: 'translation' }), false);
assert.equal(shouldRequestCaptionAutoScroll({ mode: CAPTION_FOLLOW_MODE.BROWSING_HISTORY, reason: 'final-caption' }), false);
assert.equal(shouldRequestCaptionAutoScroll({ mode: CAPTION_FOLLOW_MODE.BROWSING_HISTORY, reason: 'jump-to-latest' }), true);

// 20/40/60-minute deterministic models: delayed translations, layout and
// programmatic callbacks never change FOLLOWING.
for (const minutes of [20, 40, 60]) {
  let mode = CAPTION_FOLLOW_MODE.FOLLOWING;
  let logicalRequests = 0;
  for (let second = 0; second < minutes * 60; second += 1) {
    for (const reason of ['interim-caption', 'final-caption']) {
      if (shouldRequestCaptionAutoScroll({ mode, reason })) logicalRequests += 1;
      mode = followModeAfterScroll({
        mode,
        origin: CAPTION_SCROLL_ORIGIN.PROGRAMMATIC,
        distanceFromBottomPx: second * 37,
      });
    }
    mode = followModeAfterScroll({
      mode,
      origin: CAPTION_SCROLL_ORIGIN.NONE,
      distanceFromBottomPx: second * 41,
    });
  }
  assert.equal(mode, CAPTION_FOLLOW_MODE.FOLLOWING);
  assert.equal(logicalRequests, minutes * 60 * 2);
}

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveCaptionsSource = fs.readFileSync(path.join(root, 'lib/liveCaptions.tsx'), 'utf8');
const feedSource = fs.readFileSync(path.join(root, 'components/CaptionHistoryFeed.tsx'), 'utf8');
const miniSource = fs.readFileSync(path.join(root, 'app/mini-caption.tsx'), 'utf8');
const floatingSource = fs.readFileSync(path.join(root, 'components/FloatingMiniCaption.tsx'), 'utf8');
assert.doesNotMatch(liveCaptionsSource, /RECENT_FINAL_CAPTION_LIMIT|slice\(-200\)/);
assert.match(liveCaptionsSource, /captionSequenceRef\.current\+\+/);
assert.match(feedSource, /keyExtractor=\{\(item\) => item\.id\}/);
assert.match(feedSource, /maintainVisibleContentPosition/);
for (const compactSource of [miniSource, floatingSource]) {
  assert.match(compactSource, /feedUserScrollingRef\.current/);
  assert.match(compactSource, /feedAutoScrollPendingRef\.current/);
  assert.match(compactSource, /captionLines\.length,\s*partialCaption/);
  assert.doesNotMatch(compactSource, /if \(autoFollowFeed\) feedScrollRef\.current\?\.scrollToEnd/);
}

console.log('Caption feed tests passed.');
