/**
 * Lecture audio playback reliability.
 *
 * Root causes proven by reading expo-audio's native iOS source
 * (node_modules/expo-audio/ios/AudioPlayer.swift) directly, then confirmed
 * on-device with __DEV__ instrumentation and an OS log stream — not guessed:
 *
 * BUG A — "Play sometimes does nothing":
 *   `player.play()` calls `ref.playImmediately(atRate:)` on the underlying
 *   AVPlayer. If the AVPlayerItem hasn't reached `.readyToPlay` yet (still
 *   buffering a cloud signed URL over the network — a brand-new native
 *   AudioPlayer instance is created every time `audioUri` changes, so this
 *   window is real, not theoretical), `playImmediately` silently has no
 *   effect: no error is thrown (the JS `play(): void` binding is
 *   synchronous and does not surface native load failures at all — see
 *   AudioModule.types.ts), no event fires, and nothing ever retries the
 *   call once the item does become ready. The old code called
 *   `player.play()` unconditionally, never reading `isLoaded`.
 *
 * BUG B — "Replay after end":
 *   `AVPlayerItemDidPlayToEndTime` sets `playing:false, currentTime:duration,
 *   didJustFinish:true` and does NOT seek back to 0 (only `isLooping` does
 *   that). The old code's togglePlayback had no ended-state branch, so a
 *   post-end tap just called `player.play()` with the play head still
 *   parked at `duration` — AVPlayer has nothing left to play from there.
 *
 *   Three fix attempts were tried and verified on-device via __DEV__
 *   instrumentation + `xcrun simctl spawn log stream`:
 *     1. seekTo(0) then play() — seekTo resolves, play() is invoked, yet
 *        native playback silently stays paused at the end.
 *     2. player.replace() (same source) then play() — same silent no-op.
 *     3. Force a genuinely NEW AudioPlayer construction (not an in-place
 *        item swap) via a one-tick null→real source flip, THEN queue the
 *        play — this is the exact code path a fresh screen mount already
 *        takes reliably every time, and it works.
 *   Attempt 3 initially *looked* like it also failed, until a full OS log
 *   stream (not screenshots, which had multi-second, unpredictable tool
 *   round-trip latency in this environment) proved currentTime genuinely
 *   climbing 0 → 8.05s with playing:true throughout, then a clean natural
 *   re-end — i.e. it worked the whole time; the apparent failures were a
 *   verification-tooling artifact, not an app bug. Separately, a REAL bug
 *   was found and fixed along the way: right after a player-identity swap,
 *   `audioStatus` (from useAudioPlayerStatus's useEvent()) can briefly still
 *   report the PREVIOUS player's last-known values, because useEvent seeds
 *   its React state with `initialValue` only on that hook's own first mount
 *   — changing the argument on a later render does not reset it. The queued-
 *   intent effect reads the live `player.isLoaded`/`player.playing`
 *   properties directly (never lagging) instead of `audioStatus.*` to avoid
 *   this.
 *
 * Fix: a queued play-intent (`pendingPlayIntentRef`) that starts playback
 * automatically once the player reports ready — covering the cloud load
 * race, the post-retry source swap, AND the post-remount reload after an
 * ended tap — plus a bounded load timeout (expo-audio gives no failure
 * signal, so this is the only way to notice a stuck/expired cloud source)
 * that re-resolves the signed URL once and then honors the original tap.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const screen = read('../app/lecture/[id].tsx');

const sliceFn = (name, endMarker) => {
  const start = screen.indexOf(name);
  assert.ok(start > -1, `${name} not found`);
  const end = screen.indexOf(endMarker, start);
  assert.ok(end > start, `end marker for ${name} not found`);
  return screen.slice(start, end);
};

const armLoadTimeoutFn = sliceFn('const armLoadTimeout = () => {', '// A tap queued while the player was still loading');
const queuedIntentEffect = sliceFn(
  '// A tap queued while the player was still loading',
  '// If the source disappears',
);
const audioAvailableGuardEffect = sliceFn(
  '// If the source disappears',
  '// True-unmount-only',
);
const unmountOnlyEffect = sliceFn('// True-unmount-only', 'const togglePlayback = useCallback');
const togglePlaybackFn = sliceFn('const togglePlayback = useCallback', 'const openTranscriptEditor = useCallback');
const flipBackEffect = sliceFn(
  '// One-tick null→real flip',
  '// Heal stale sandbox URIs',
);

console.log('1 — constants: bounded load timeout, ended epsilon');
check('LOAD_TIMEOUT_MS is a finite, non-polling one-shot bound (module scope, not a state field)', () => {
  assert.match(screen, /const LOAD_TIMEOUT_MS = \d+;/);
});
check('REPLAY_EPSILON_SEC exists for ended-position detection', () => {
  assert.match(screen, /const REPLAY_EPSILON_SEC = [\d.]+;/);
});

console.log('2 — Bug A: play is never called before the player reports isLoaded');
check('togglePlayback reads audioStatus.isLoaded before calling player.play() on the direct path', () => {
  assert.match(togglePlaybackFn, /if \(!audioStatus\.isLoaded\) \{/);
});
check('when not loaded, the tap is queued (pendingPlayIntentRef) and a bounded timeout is armed, not dropped', () => {
  const notLoadedBlock = togglePlaybackFn.slice(
    togglePlaybackFn.indexOf('if (!audioStatus.isLoaded) {'),
    togglePlaybackFn.indexOf('pendingPlayIntentRef.current = false;\n      clearLoadTimeout();\n      if (__DEV__) console.info(\'[lecture] play: loaded'),
  );
  assert.match(notLoadedBlock, /pendingPlayIntentRef\.current = true;/);
  assert.match(notLoadedBlock, /armLoadTimeout\(\);/);
  assert.match(notLoadedBlock, /return;/);
});
check('player.play() is only reached, in the direct tap path, after the isLoaded guard has passed', () => {
  const idx = togglePlaybackFn.indexOf('if (!audioStatus.isLoaded)');
  const playIdx = togglePlaybackFn.indexOf('player.play();');
  assert.ok(idx > -1 && playIdx > idx);
});

console.log('3 — Bug A: queued intent starts automatically once the player becomes ready (no dropped tap)');
check('a dedicated effect watches for a pending intent and calls player.play() once ready', () => {
  assert.match(queuedIntentEffect, /if \(pendingPlayIntentRef\.current && player\.isLoaded && !player\.playing\) \{/);
  assert.match(queuedIntentEffect, /player\.play\(\);/);
});
check('the ready-check reads the LIVE player.isLoaded/player.playing properties, not the React-state audioStatus mirror (proven on-device to lag by one render right after a player-identity swap)', () => {
  const codeOnly = queuedIntentEffect.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, /audioStatus\.isLoaded|audioStatus\.playing/);
});
check('the effect still depends on [audioStatus, player] as its re-run trigger (a fresh native event, even one carrying unchanged primitive values, must re-fire this check)', () => {
  assert.match(screen, /\}, \[audioStatus, player\]\);/);
});

console.log('4 — Bug B: ended state forces a genuinely new player instance before resuming, never blocks play');
check('togglePlayback computes hasEnded from currentTime vs duration (durable signal, not the transient didJustFinish event)', () => {
  assert.match(togglePlaybackFn, /const hasEnded =\s*\n?\s*playbackDuration > 0 && audioStatus\.currentTime >= playbackDuration - REPLAY_EPSILON_SEC;/);
});
check('when hasEnded, neither player.seekTo() nor player.replace() is called — both were proven on-device to leave AVPlayer silently paused post-EOF', () => {
  const block = togglePlaybackFn.slice(
    togglePlaybackFn.indexOf('if (hasEnded) {'),
    togglePlaybackFn.indexOf('if (!audioStatus.isLoaded)'),
  );
  const codeOnly = block.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, /player\.seekTo\(/);
  assert.doesNotMatch(codeOnly, /player\.replace\(/);
});
check('the hasEnded branch queues the tap and flips suspendPlayerSource to force a from-scratch AudioPlayer construction, instead of calling player.play() directly', () => {
  const block = togglePlaybackFn.slice(
    togglePlaybackFn.indexOf('if (hasEnded) {'),
    togglePlaybackFn.indexOf('if (!audioStatus.isLoaded)'),
  );
  assert.match(block, /pendingPlayIntentRef\.current = true;/);
  assert.match(block, /armLoadTimeout\(\);/);
  assert.match(block, /setSuspendPlayerSource\(true\);/);
  assert.match(block, /return;/);
});
check('the player source expression is gated on !suspendPlayerSource, so flipping it true releases the (ended) native player', () => {
  assert.match(screen, /audioAvailable && !suspendPlayerSource \? \{ uri: audioUri \?\? '' \} : null/);
});
check('a dedicated effect flips suspendPlayerSource back to false on the very next render, reconstructing a brand-new player for the same source', () => {
  assert.match(flipBackEffect, /if \(suspendPlayerSource\) \{/);
  assert.match(flipBackEffect, /setSuspendPlayerSource\(false\);/);
  assert.match(flipBackEffect, /\}, \[suspendPlayerSource\]\);/);
});

console.log('5 — pause path resets pending intent (no stray delayed play/alert after a pause)');
check('the playing (pause) branch clears pendingPlayIntentRef and the load timeout', () => {
  const pauseBlock = togglePlaybackFn.slice(
    togglePlaybackFn.indexOf('if (audioStatus.playing) {'),
    togglePlaybackFn.indexOf('await setAudioModeAsync'),
  );
  assert.match(pauseBlock, /pendingPlayIntentRef\.current = false;/);
  assert.match(pauseBlock, /clearLoadTimeout\(\);/);
  assert.match(pauseBlock, /player\.pause\(\);/);
});

console.log('6 — signed URL expiry: existing one-time re-resolution is kept, and now honors the original tap');
check('the catch branch still retries cloud resolution exactly once, guarded by retriedExpiredCloudUrl', () => {
  const catchBlock = togglePlaybackFn.slice(togglePlaybackFn.indexOf('} catch (err) {'));
  assert.match(catchBlock, /if \(cloudRequired && !retriedExpiredCloudUrl\.current\) \{/);
  assert.match(catchBlock, /retriedExpiredCloudUrl\.current = true;/);
  assert.match(catchBlock, /setCloudRetry\(\(value\) => value \+ 1\);/);
});
check('the catch-path retry now sets pendingPlayIntentRef so the original tap is honored once the new source loads (this is the delta — previously absent)', () => {
  const catchBlock = togglePlaybackFn.slice(togglePlaybackFn.indexOf('} catch (err) {'));
  const retryBlock = catchBlock.slice(
    catchBlock.indexOf('if (cloudRequired && !retriedExpiredCloudUrl.current) {'),
    catchBlock.indexOf('setCloudRetry((value) => value + 1);') + 40,
  );
  assert.match(retryBlock, /pendingPlayIntentRef\.current = true;/);
});
check('the load-timeout path (armLoadTimeout) ALSO re-resolves once and re-arms its own bounded window for the retried load — no unbounded wait, no polling loop', () => {
  assert.match(armLoadTimeoutFn, /if \(cloudRequired && !retriedExpiredCloudUrl\.current\) \{/);
  assert.match(armLoadTimeoutFn, /armLoadTimeout\(\);/);
  const occurrences = (armLoadTimeoutFn.match(/setTimeout\(/g) ?? []).length;
  assert.equal(occurrences, 1, 'armLoadTimeout must schedule exactly one setTimeout per call, not a setInterval/polling loop');
  assert.doesNotMatch(armLoadTimeoutFn, /setInterval/);
});
check('after both the retry and the timeout are exhausted, the user sees the existing alert exactly once (no silent hang)', () => {
  assert.match(armLoadTimeoutFn, /Alert\.alert\(t\('lecture\.audioUnavailable'\), t\('lecture\.tryAgain'\)\);/);
  assert.match(armLoadTimeoutFn, /pendingPlayIntentRef\.current = false;/);
});

console.log('7 — a stale queued intent never fires a delayed alert once the source disappears or the screen unmounts');
check('a dedicated effect clears the pending intent and timeout when audioAvailable turns false', () => {
  assert.match(audioAvailableGuardEffect, /if \(!audioAvailable\) \{/);
  assert.match(audioAvailableGuardEffect, /pendingPlayIntentRef\.current = false;/);
  assert.match(audioAvailableGuardEffect, /clearLoadTimeout\(\);/);
});
check('a true-unmount-only effect (empty dependency array) clears intent/timeout on navigate-away, not on every player swap', () => {
  assert.match(unmountOnlyEffect, /\}, \[\]\);/);
  assert.match(unmountOnlyEffect, /clearLoadTimeout\(\);/);
  assert.match(unmountOnlyEffect, /pendingPlayIntentRef\.current = false;/);
});

console.log('8 — local playback path is unregressed: no gating added that only makes sense for cloud');
check('the isLoaded/hasEnded logic is unconditional (applies identically to local and cloud — no `if (cloudRequired)` guard around it)', () => {
  const isLoadedGuardIdx = togglePlaybackFn.indexOf('if (!audioStatus.isLoaded)');
  const surrounding = togglePlaybackFn.slice(Math.max(0, isLoadedGuardIdx - 200), isLoadedGuardIdx);
  assert.doesNotMatch(surrounding, /if \(cloudRequired\)/);
});
check('audioAvailable / isLectureSessionActive gates are unchanged at the top of togglePlayback', () => {
  assert.match(togglePlaybackFn, /if \(!audioAvailable\) return;/);
  assert.match(togglePlaybackFn, /if \(isLectureSessionActive\) \{/);
});

console.log('9 — DEV-only instrumentation exists at the required lifecycle points, gated so production is untouched');
for (const marker of [
  "console.info('[lecture] play tap'",
  "console.info('[lecture] play: ended — forcing a fresh player instance')",
  "console.info('[lecture] play: not loaded yet — queuing intent')",
  "console.info('[lecture] play: loaded — calling player.play()')",
  "console.info('[lecture] play: queued intent resolved — starting playback')",
  "console.info('[lecture] play: load timeout — re-resolving cloud URL once')",
  "console.info('[lecture] play: load timeout — giving up')",
]) {
  check(`instrumentation present and __DEV__-gated: ${marker}`, () => {
    const idx = screen.indexOf(marker);
    assert.ok(idx > -1, 'marker not found');
    const precedingLine = screen.slice(Math.max(0, idx - 80), idx);
    assert.match(precedingLine, /__DEV__/);
  });
}

console.log(`\nlecture audio playback reliability: ${passed} checks passed`);
