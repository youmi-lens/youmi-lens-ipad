/**
 * P0 classroom incident (2026-09-03), part 2: production logs (Railway,
 * service `youmi-lens`) showed a real user's live-caption pipeline opening
 * cleanly on every attempt — connect, auth_ok, Deepgram connects, stream_ready
 * sent to client — but delivering ZERO microphone PCM to the upstream ASR
 * (`upstreamPcmCount: 0`, `closedBeforeAnyPcm: true`) on every single attempt.
 * Deepgram's own "no audio data" timeout (~10-12s, close code 1011) then
 * closed the connection, and the client reconnected — forever, roughly every
 * 13-15 real seconds, for at least a 7+ minute observed window, with no sign
 * of ever giving up.
 *
 * Root cause of the INFINITE loop (lib/liveCaptions.tsx): the reconnect
 * budget (reconnectAttemptsRef, capped at MAX_REALTIME_RECONNECT_ATTEMPTS)
 * was reset to 0 on `stream_ready` — but stream_ready only proves the
 * upstream ASR connection opened, not that any audio is actually reaching
 * it. A pipeline that opens fine but never delivers PCM re-earns a full,
 * fresh retry budget on every single attempt, so it can never exhaust the
 * budget and call giveUp() — it fails the same way forever instead of
 * degrading, once, to the calm "Live captions unavailable. Recording is
 * still active." message.
 *
 * The deeper native root cause (a stale audio-session-active flag inside the
 * vendored react-native-audio-api iOS module — AudioSessionManager.isActive
 * is a local cache that is never invalidated when a different module,
 * expo-audio, reconfigures the same shared AVAudioSession) lives in
 * node_modules and needs a version upgrade + physical-device verification
 * neither of which is safe to do under tonight's time pressure. This fix
 * only closes the resilience gap: whatever the native cause, the client must
 * fail BOUNDED, not loop forever hammering Deepgram/the backend.
 *
 * Fix: only reset the budget on stream_interim / stream_final — actual
 * caption output, i.e. proof PCM is really flowing end-to-end. A genuinely
 * healthy session (captions arriving regularly) still gets a fresh budget for
 * any later transient blip, exactly as before. A session that can never
 * produce a single caption now gives up after MAX_REALTIME_RECONNECT_ATTEMPTS
 * and stops, instead of retrying indefinitely.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const src = read('../lib/liveCaptions.tsx');

console.log('Reconnect budget only resets on proven caption output, not on stream_ready');

check('MAX_REALTIME_RECONNECT_ATTEMPTS is still a small bounded number', () => {
  const match = src.match(/const MAX_REALTIME_RECONNECT_ATTEMPTS = (\d+);/);
  assert.ok(match, 'the budget constant must still exist');
  const n = Number(match[1]);
  assert.ok(n >= 1 && n <= 5, `budget should stay small and bounded, got ${n}`);
});

check('stream_ready no longer resets the reconnect budget', () => {
  const readyBlock = src.slice(
    src.indexOf("if (message.type === 'stream_ready')"),
    src.indexOf("} else if (message.type === 'stream_interim'"),
  );
  assert.doesNotMatch(
    readyBlock,
    /reconnectAttemptsRef\.current = 0/,
    'stream_ready only proves the socket opened, not that PCM is reaching the upstream ASR — resetting here is the regression that let a zero-PCM session reconnect forever',
  );
});

check('stream_interim and stream_final DO reset the reconnect budget (real caption output = proof it works)', () => {
  const interimBlock = src.slice(
    src.indexOf("} else if (message.type === 'stream_interim'"),
    src.indexOf("} else if (message.type === 'stream_final'"),
  );
  const finalBlock = src.slice(
    src.indexOf("} else if (message.type === 'stream_final'"),
    src.indexOf("} else if (message.type === 'stream_translation'"),
  );
  assert.match(interimBlock, /reconnectAttemptsRef\.current = 0/);
  assert.match(finalBlock, /reconnectAttemptsRef\.current = 0/);
});

console.log('\nNumeric proof: a zero-PCM session now fails bounded instead of looping forever');

/**
 * Replays scheduleReconnect's actual attempt-counting logic for N consecutive
 * connect cycles that each reach stream_ready but never produce a caption
 * (the exact production signature). Returns how many cycles run before
 * giveUp() would fire, under each reset policy.
 */
function simulate(resetOnStreamReady, maxAttempts, cyclesToSimulate) {
  let reconnectAttempts = 0;
  let gaveUpAtCycle = null;
  for (let cycle = 1; cycle <= cyclesToSimulate; cycle += 1) {
    // Each cycle: connect, reach stream_ready, then never get a caption
    // (upstreamPcmCount stays 0), so the upstream eventually closes it.
    if (resetOnStreamReady) reconnectAttempts = 0; // the old, buggy behavior
    // no stream_interim/stream_final ever arrives in this failure mode, so
    // under the fix, reconnectAttempts is never reset mid-cycle.

    // onclose -> scheduleReconnect
    if (reconnectAttempts >= maxAttempts) {
      gaveUpAtCycle = cycle;
      break;
    }
    reconnectAttempts += 1; // a reconnect gets scheduled for the next cycle
  }
  return gaveUpAtCycle;
}

check('old policy (reset on stream_ready): never gives up across 50 simulated failing cycles', () => {
  const gaveUpAt = simulate(/* resetOnStreamReady */ true, 2, 50);
  assert.equal(gaveUpAt, null, 'the old policy must never exhaust the budget when every cycle reaches stream_ready');
});

check('fixed policy (reset only on real captions): gives up after exactly maxAttempts+1 cycles', () => {
  const maxAttempts = 2;
  const gaveUpAt = simulate(/* resetOnStreamReady */ false, maxAttempts, 50);
  assert.equal(gaveUpAt, maxAttempts + 1, 'must give up bounded — one initial attempt plus the reconnect budget, then stop');
});

console.log(`\nlive-caption-reconnect-budget: ${passed} checks passed`);
