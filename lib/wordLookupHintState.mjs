/**
 * Pure decision for the double-tap word-lookup discoverability hint.
 *
 * The native dictionary lookup uses a double-tap on an English word (safer than
 * a single tap, but less discoverable). This decides whether to show a subtle
 * one-line hint. Kept pure so it is directly unit-testable and the recording
 * screen wiring stays tiny.
 *
 * Show the hint only when ALL hold:
 *   - English captions are currently visible (there is a word to double-tap),
 *   - native lookup is actually available (no point hinting a feature the
 *     device can't perform — and this is why an unavailable module never marks
 *     the hint as "seen"),
 *   - the user hasn't already seen/dismissed it.
 *
 * @param {{ seen?: boolean, lookupAvailable?: boolean, captionsVisible?: boolean }} input
 * @returns {boolean}
 */
export function shouldShowWordLookupHint(input = {}) {
  return (
    Boolean(input.captionsVisible) &&
    Boolean(input.lookupAvailable) &&
    !input.seen
  );
}
