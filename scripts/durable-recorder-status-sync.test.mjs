import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { evaluateNativeStatusUpdate } from '../lib/recording/statusSync.mjs';

const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function pausedStatus(sequence, sessionId = sessionA) {
  return {
    recordingSessionId: sessionId,
    statusSequence: sequence,
    session: { recordingSessionId: sessionId, state: 'paused' },
  };
}

// Test 1 / 2 / 3 conceptual: forced-pause status is accepted while recording.
{
  const decision = evaluateNativeStatusUpdate({
    currentSessionId: sessionA,
    currentState: 'recording',
    finishing: false,
    lastSequence: 1,
    status: pausedStatus(2),
  });
  assert.equal(decision.accept, true);
  assert.equal(decision.reason, 'apply');
  assert.equal(decision.nextSequence, 2);
}

// Test 5: stale paused event after a newer resume sequence is ignored.
{
  const decision = evaluateNativeStatusUpdate({
    currentSessionId: sessionA,
    currentState: 'recording',
    finishing: false,
    lastSequence: 5,
    status: pausedStatus(4),
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.reason, 'stale_sequence');
}

// Test 6: Finish/terminal wins over in-flight pause.
{
  const decision = evaluateNativeStatusUpdate({
    currentSessionId: sessionA,
    currentState: 'finalized',
    finishing: false,
    lastSequence: 3,
    status: pausedStatus(4),
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.reason, 'terminal_or_finishing');
  assert.equal(decision.nextSequence, 4, 'newer rejected events still advance sequence tracking');
}

{
  const decision = evaluateNativeStatusUpdate({
    currentSessionId: sessionA,
    currentState: 'paused',
    finishing: true,
    lastSequence: 3,
    status: pausedStatus(4),
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.reason, 'terminal_or_finishing');
}

// Test 7: session identity isolation.
{
  const decision = evaluateNativeStatusUpdate({
    currentSessionId: sessionB,
    currentState: 'recording',
    finishing: false,
    lastSequence: 1,
    status: pausedStatus(2, sessionA),
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.reason, 'session_mismatch');
}

// Explicit pause while already paused is still a valid apply for sequence catch-up.
{
  const decision = evaluateNativeStatusUpdate({
    currentSessionId: sessionA,
    currentState: 'paused',
    finishing: false,
    lastSequence: 2,
    status: pausedStatus(3),
  });
  assert.equal(decision.accept, true);
}

// Adapter must subscribe to native status events (listener lifecycle source).
const adapter = await readFile(new URL('../lib/recording/useNativeDurableLectureRecorder.ts', import.meta.url), 'utf8');
assert.match(adapter, /addRecordingStatusListener/);
assert.match(adapter, /evaluateNativeStatusUpdate/);
assert.match(adapter, /AppState\.addEventListener/);
assert.match(adapter, /getRecordingStatus/);
assert.doesNotMatch(adapter, /setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*getRecordingStatus/, 'no status polling interval');

const nativeModule = await readFile(new URL('../modules/expo-durable-recorder/ios/ExpoDurableRecorderModule.swift', import.meta.url), 'utf8');
assert.match(nativeModule, /Events\("onRecordingStatusChange"\)/);
assert.match(nativeModule, /sendEvent\("onRecordingStatusChange"/);

const engine = await readFile(new URL('../modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift', import.meta.url), 'utf8');
assert.match(engine, /publishStatus/);
assert.match(engine, /handleForcedPause[\s\S]*publishStatus/);

console.log('Durable recorder forced-pause status sync tests passed.');
