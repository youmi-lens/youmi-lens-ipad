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
  return distanceFromBottomPx <= threshold;
}
