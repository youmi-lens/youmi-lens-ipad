import { AccessibilityInfo } from 'react-native';
import { useEffect, useState } from 'react';

/**
 * The app's shared motion language.
 *
 * These numbers are not new: they are the values PressableScale already shipped
 * with, lifted here so press feedback, content reveals and skeleton swaps stop
 * inventing their own timings per screen. Reach for a token before writing a
 * literal duration.
 *
 * The rhythm every interaction follows:
 *
 *   touch → immediate acknowledgement → destination → content reveals
 *
 * Motion supports that order; it never stands in for slow work. If a screen
 * feels slow, fix the work — do not lengthen the animation to cover it.
 */
export const motion = {
  /** Resting → pressed scale. Subtle by design; this is tactile, not theatrical. */
  pressScale: 0.98,
  /** Resting → pressed opacity. */
  pressOpacity: 0.94,
  /** Press-in must read as instant. */
  pressInDuration: 70,
  /** Release is slightly longer so the control settles rather than snapping. */
  pressOutDuration: 150,
  /** Opacity half of a release. */
  pressOutFadeDuration: 130,

  /** Container-level content reveal (page body, tab body, loaded card). */
  contentRevealDuration: 180,
  /** Vertical travel on a reveal. Small enough to read as settling, not sliding. */
  contentRevealOffset: 6,

  /**
   * Whole-page-shell settle on tab focus (PageShellTransition). Slightly
   * longer and travels a touch further than contentReveal so the shell reads
   * as one coherent movement carrying the heading with it, not a second,
   * disconnected fade layered on top.
   */
  pageShellDuration: 200,
  /** Vertical travel for the page-shell settle. */
  pageShellOffset: 8,
  /** Selected-tab indicator crossfade (sidebar active bar/tint, bottom tab). */
  tabIndicatorDuration: 160,

  /**
   * Per-card entrance settle (e.g. Course cards on tab focus). Deliberately
   * separate from contentReveal/pageShell: this one has a per-item stagger
   * riding on top of it, so its own duration is kept shorter — the goal is
   * "cards gently settle into place", not "cards animate one-by-one slowly".
   */
  cardEntranceDuration: 160,
  /** Vertical travel for a card's own settle. */
  cardEntranceOffset: 5,
  /** Delay step between consecutive cards' entrances. */
  cardStaggerMs: 20,
  /** Cards beyond this index all share the same (maximum) stagger delay —
   * caps total sequence length regardless of library size. */
  cardStaggerCap: 4,

  /** Skeleton → content crossfade, and other short atomic fades. */
  fastFadeDuration: 140,

  /** Tutorial V2 spotlight dim/cutout fade-in when a real target resolves. */
  tutorialSpotlightDuration: 200,

} as const;

/**
 * Tracks the platform "Reduce Motion" switch.
 *
 * When enabled, callers must drop *translation* and shorten or remove fades —
 * but must never delay or weaken a state change. A reduced-motion user gets the
 * same immediacy, just without the travel.
 */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduceMotion(enabled);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return reduceMotion;
}
