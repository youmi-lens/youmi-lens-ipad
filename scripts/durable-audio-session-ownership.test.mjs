import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { nativeSources, readSources, runSwiftHarness } from './lib/swift-harness.mjs';

await runSwiftHarness({
  sources: [
    nativeSources.core,
    nativeSources.store,
    nativeSources.recorder,
    'scripts/durable-audio-session-ownership-core.test.swift',
  ],
  expect: /native audio-session ownership tests passed/,
  tmpPrefix: 'durable-audio-session-ownership-',
});

const recorder = await readSources(nativeSources.recorder);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const slice = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = to ? text.indexOf(to, start + from.length) : text.length;
  assert.ok(end > start, `missing end: ${to}`);
  return text.slice(start, end);
};

console.log('Audio-session ownership: structure');
check('the checkpoint rollover reuses the held session; only Start/Resume and a session-level retry reassert', () => {
  const retry = slice(recorder, 'private func beginCheckpointSegment(', 'private func emitEnteredPaused(');
  assert.match(retry, /attempt: 1, reassertAudioSession: false/);
  assert.match(retry, /reassertAudioSession: first\.stageId\.hasPrefix\("audio_session"\)/);
  const manager = slice(recorder, 'final class SystemDurableAudioSessionManager', '#else');
  assert.match(manager, /if !reassertConfiguration, heldActiveByRecorder, currentConfigurationSupportsRecording \{/);
  assert.match(manager, /private var currentConfigurationSupportsRecording: Bool \{\s*\n\s*\(session\.category == \.record \|\| session\.category == \.playAndRecord\) && session\.mode == \.default/);
  // the reuse path must not call setCategory/setActive
  const reuse = slice(manager, 'if !reassertConfiguration, heldActiveByRecorder', 'lastActivationStage = "set_category"');
  assert.doesNotMatch(reuse, /setCategory|setActive\(true\)/);
});
check('heldActiveByRecorder is cleared on every deactivate, so Resume after a pause always does the full sequence', () => {
  const manager = slice(recorder, 'final class SystemDurableAudioSessionManager', '#else');
  assert.match(manager, /func deactivate\(\) \{\s*\n\s*heldActiveByRecorder = false/);
});
check('route loss recovers only when iOS still provides a usable input; otherwise the forced pause is unchanged', () => {
  const fn = slice(recorder, 'private func recoverOrPauseAfterRouteLoss(', 'private func attemptAutomaticRecoveryAfterProtectivePause()');
  assert.match(fn, /guard isOldDeviceUnavailable,\s*\n\s*audioSession\.hasSuitableInput,\s*\n\s*runtimeState == \.recording,\s*\n\s*!isCheckpointInProgress/);
  assert.match(fn, /handleForcedPause\(reason: "route_\\\(name\)", runtimeAfter: \.paused\)/);
  assert.match(fn, /failureInterruption: "route_recovery_failed"/);
});
check('auto-recovery is one bounded attempt and is only armed by the recorder\'s own protective pause', () => {
  const fn = slice(recorder, 'private func attemptAutomaticRecoveryAfterProtectivePause()', '#if os(iOS)\n  private func handleInterruption');
  assert.match(fn, /pendingAutoRecovery = nil\s*\n\s*guard \(try\? store\.getSession/);
  assert.equal((recorder.match(/pendingAutoRecovery = failureInterruption/g) ?? []).length, 1, 'armed in exactly one place');
  for (const anchor of ['emitLifecycle("pause_transition", ["caller": "user_pause_request"])\n      pendingAutoRecovery = nil', 'emitLifecycle("stop_requested")\n      pendingAutoRecovery = nil']) {
    assert.ok(recorder.includes(anchor), `cleared on: ${anchor.split('\n')[0]}`);
  }
});
check('live caption keeps a recording-compatible configuration (PlayAndRecord, default mode)', () => {
  const mic = read('lib/liveMicStream.ts');
  assert.match(mic, /iosCategory: 'playAndRecord',\s*\n\s*iosMode: 'default'/);
});

console.log('Durable audio-session ownership tests passed.');
