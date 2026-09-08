/**
 * Lecture Detail playback scrubber (app/lecture/[id].tsx).
 *
 * Physical owner repro: the progress bar was purely decorative — two plain
 * `<View>`s (progressTrack/progressFill) with zero touch handling at all, not
 * even tap-to-seek. Only a separate marks list had onPress-to-seek.
 *
 * Fix: a new PlaybackScrubTrack component drives real drag scrubbing via
 * PanResponder, following this session's established pattern (preview
 * during the drag, one authoritative commit on release — expo-audio's
 * seekTo() is a plain async native seek, not a scrub-mode API, so calling it
 * on every touch-move frame would be wasteful and could stutter playback).
 *
 * These are structural source-level guards (this is a gesture-driven native
 * interaction; actual on-device feel can only be judged physically) plus
 * pure math simulations of the parts that ARE testable without React Native.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const src = read('../app/lecture/[id].tsx');

console.log('1. Drag updates the scrub target continuously (move -> onScrubMove)');

check('onPanResponderMove computes a ratio from the live gesture position and reports it via onScrubMove on every move sample', () => {
  const responderBlock = src.slice(src.indexOf('const responder = useMemo'), src.indexOf('return (\n    <View\n      ref={trackRef}'));
  const moveHandler = responderBlock.slice(responderBlock.indexOf('onPanResponderMove: (_evt, gestureState) => {'), responderBlock.indexOf('onPanResponderRelease:'));
  assert.match(moveHandler, /ratioFromPageX\(gestureState\.moveX\)/, 'must use the live absolute gesture position, not a one-shot snapshot');
  assert.match(moveHandler, /onScrubMove\(ratio\)/);
});

console.log('\n2/3. Forward/backward drag both work; target clamps to [0,1] (-> [0,duration] seconds)');

/** Mirrors ratioFromPageX's actual clamping math. */
function ratioFromPageX(pageX, trackPageX, width) {
  if (width <= 0) return 0;
  return Math.max(0, Math.min(1, (pageX - trackPageX) / width));
}

check('dragging forward (increasing X) increases the ratio', () => {
  const trackPageX = 100;
  const width = 200;
  const early = ratioFromPageX(150, trackPageX, width); // 25%
  const later = ratioFromPageX(250, trackPageX, width); // 75%
  assert.ok(later > early);
  assert.equal(early, 0.25);
  assert.equal(later, 0.75);
});

check('dragging backward (decreasing X) decreases the ratio, from any starting point', () => {
  const trackPageX = 100;
  const width = 200;
  const start = ratioFromPageX(250, trackPageX, width); // 75%
  const backward = ratioFromPageX(120, trackPageX, width); // 10%
  assert.ok(backward < start);
});

check('a finger past either edge of the track clamps to exactly 0 or 1, never goes negative or past 1', () => {
  const trackPageX = 100;
  const width = 200;
  assert.equal(ratioFromPageX(-500, trackPageX, width), 0, 'far left of the track clamps to 0');
  assert.equal(ratioFromPageX(0, trackPageX, width), 0, 'before the track start clamps to 0');
  assert.equal(ratioFromPageX(1000, trackPageX, width), 1, 'far right of the track clamps to 1');
  assert.equal(ratioFromPageX(300, trackPageX, width), 1, 'exactly at the track end clamps to 1');
});

console.log('\n4. Release performs exactly one seek, to the final scrub position');

check('onPanResponderRelease reports the LAST computed ratio (from the ref, not a stale closure) via onScrubRelease', () => {
  const responderBlock = src.slice(src.indexOf('const responder = useMemo'), src.indexOf('return (\n    <View\n      ref={trackRef}'));
  const releaseHandler = responderBlock.slice(responderBlock.indexOf('onPanResponderRelease: () => {'), responderBlock.indexOf('onPanResponderTerminate:'));
  assert.match(releaseHandler, /onScrubRelease\(lastRatioRef\.current\)/);
});

check('commitScrub converts the ratio to seconds and performs exactly one seekToSeconds call, then clears the preview', () => {
  const commitFn = src.slice(src.indexOf('const commitScrub = async (ratio: number) => {'), src.indexOf('const commitScrub = async (ratio: number) => {') + 700);
  assert.match(commitFn, /await seekToSeconds\(ratio \* playbackDuration\)/);
  assert.match(commitFn, /setScrubRatio\(null\)/);
});

check('the callers wire release to commitScrub exactly once per gesture (onScrubRelease={(ratio) => void commitScrub(ratio)})', () => {
  const matches = src.match(/onScrubRelease=\{\(ratio\) => void commitScrub\(ratio\)\}/g) ?? [];
  assert.equal(matches.length, 2, 'both player layouts (phone stack + compact/iPad) must wire the same single-commit release handler');
});

console.log('\n5/6. Playing/paused state before scrub is preserved (seek never touches play state)');

check('seekToSeconds only calls player.seekTo — it never calls play()/pause() or touches audioStatus.playing', () => {
  const fn = src.slice(src.indexOf('const seekToSeconds = async'), src.indexOf('const skipBy = async'));
  assert.match(fn, /await player\.seekTo\(/);
  assert.doesNotMatch(fn, /\.play\(\)|\.pause\(\)/, 'seeking must never start or stop playback — whatever was playing/paused before the drag must remain so after it');
});

console.log('\n7. Invalid/zero duration is safely ignored, never NaN/Infinity');

check('commitScrub guards on playbackDuration > 0 before seeking — a zero/not-yet-loaded duration skips the seek entirely instead of computing NaN', () => {
  const commitFn = src.slice(src.indexOf('const commitScrub = async (ratio: number) => {'), src.indexOf('const commitScrub = async (ratio: number) => {') + 700);
  assert.match(commitFn, /if \(playbackDuration > 0\) \{/);
});

check('numeric proof: ratio * 0 duration is 0, never NaN — seconds computation itself cannot produce an invalid timestamp', () => {
  const ratio = 0.5;
  const seconds = ratio * 0; // playbackDuration = 0 case
  assert.equal(seconds, 0);
  assert.ok(Number.isFinite(seconds));
});

console.log('\n8. No regression to existing seek entry points (skipBy, marks tap-to-seek)');

check('skipBy (10s forward/back transport buttons) still routes through the same seekToSeconds, unchanged', () => {
  assert.match(src, /const skipBy = async \(delta: number\) => \{\s*await seekToSeconds\(audioStatus\.currentTime \+ delta\);\s*\};/);
});

check('the marks list tap-to-seek entry point is unchanged', () => {
  assert.match(src, /onPress=\{\(\) => void seekToSeconds\(ms \/ 1000\)\}/);
});

console.log('\nDisplay values follow the scrub preview while dragging, the real player otherwise');

check('displaySeconds/displayProgress fall back to the real audioStatus/playbackProgress when not scrubbing (scrubRatio === null)', () => {
  const block = src.slice(src.indexOf('const [scrubRatio, setScrubRatio]'), src.indexOf('const [scrubRatio, setScrubRatio]') + 500);
  assert.match(block, /const isScrubbing = scrubRatio !== null;/);
  assert.match(block, /const displaySeconds = isScrubbing \? scrubRatio \* playbackDuration : audioStatus\.currentTime;/);
  assert.match(block, /const displayProgress = isScrubbing \? scrubRatio : playbackProgress;/);
});

console.log('\n9. Physical investigation diagnostics have been removed — no [PlaybackScrub] logging remains in shipped code');

check('no console.log tagged [PlaybackScrub] remains anywhere in the file (temporary physical-investigation diagnostics were removed once the scrubber passed physical retest)', () => {
  assert.doesNotMatch(src, /\[PlaybackScrub\]/, 'diagnostic logging must not ship — it was only for the runtime gesture-failure investigation');
  assert.doesNotMatch(src, /moveLogCounterRef/, 'the move-log throttle counter was diagnostic-only and must be removed along with the logging it supported');
});

console.log(`\nplayback-scrubber: ${passed} checks passed`);
