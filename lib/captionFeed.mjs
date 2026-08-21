/**
 * Pure helpers for the live caption history feed (main recording screen).
 *
 * The feed auto-follows new captions ONLY while the user is already parked near
 * the bottom. Once they scroll up to review earlier lecture content, we stop
 * force-scrolling and surface a "Back to live" control instead. Keeping the
 * near-bottom decision here (pure, no React) makes it directly unit-testable.
 */

/** How close (px) to the bottom still counts as "following the live edge". */
export const NEAR_BOTTOM_THRESHOLD_PX = 96;

export const CAPTION_FOLLOW_MODE = Object.freeze({
  FOLLOWING: 'FOLLOWING',
  BROWSING_HISTORY: 'BROWSING_HISTORY',
});

export const CAPTION_SCROLL_ORIGIN = Object.freeze({
  NONE: 'NONE',
  USER: 'USER',
  PROGRAMMATIC: 'PROGRAMMATIC',
});

/**
 * True when the scroll position is close enough to the bottom that the feed
 * should keep auto-scrolling as new captions arrive.
 *
 * @param {number} distanceFromBottomPx  contentHeight - layoutHeight - scrollY
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function isNearBottom(distanceFromBottomPx, threshold = NEAR_BOTTOM_THRESHOLD_PX) {
  if (!Number.isFinite(distanceFromBottomPx)) return true; // no metrics yet → follow
  return Math.max(0, distanceFromBottomPx) <= threshold;
}

/**
 * Follow state may only be derived from scroll geometry while a user gesture is
 * active. Native onScroll also fires for scrollToEnd, layout corrections and
 * virtualization, none of which expresses user intent.
 */
export function followModeAfterScroll({ mode, origin, distanceFromBottomPx }) {
  if (origin !== CAPTION_SCROLL_ORIGIN.USER) return mode;
  return isNearBottom(distanceFromBottomPx)
    ? CAPTION_FOLLOW_MODE.FOLLOWING
    : CAPTION_FOLLOW_MODE.BROWSING_HISTORY;
}

/** Legal events that can create a new automatic-scroll request. */
export function shouldRequestCaptionAutoScroll({ mode, reason }) {
  if (reason === 'jump-to-latest') return true;
  if (mode !== CAPTION_FOLLOW_MODE.FOLLOWING) return false;
  return reason === 'final-caption' || reason === 'interim-caption';
}

/**
 * How many finalized caption lines belong in the SCROLLABLE history area, given
 * the total finalized count and whether a sentence is currently being spoken.
 *
 * The current caption is rendered separately as a FIXED block, so it must be
 * excluded from the scroll list:
 *   - while speaking (hasLive) the live partial is the fixed current → every
 *     finalized line is history;
 *   - otherwise the newest finalized line is the fixed current → history is all
 *     but that last line.
 *
 * @param {number} finalizedCount
 * @param {boolean} hasLive
 * @returns {number}
 */
export function historyLineCount(finalizedCount, hasLive) {
  const n = Number.isFinite(finalizedCount) ? Math.max(0, Math.floor(finalizedCount)) : 0;
  if (hasLive) return n;
  return Math.max(0, n - 1);
}
