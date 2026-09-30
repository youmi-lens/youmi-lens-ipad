/**
 * Bounded checkpoint-rollover recovery — structural contract.
 *
 * Behavior is proven natively in durable-checkpoint-retry-core.test.swift. This file locks the SHAPE that keeps the
 * mitigation small and safe: exactly one retry, no loop/recursion, retry only inside a checkpoint rollover, a fixed
 * eligibility set decided from structured stage values (never error text), and everything the mitigation must NOT touch.
 *
 * Run: node scripts/durable-checkpoint-retry-contract.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const slice = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = to ? text.indexOf(to, start + from.length) : text.length;
  assert.ok(end > start, `missing end: ${to}`);
  return text.slice(start, end);
};
const stripComments = (text) => text.replace(/\/\/.*$/gm, '');

const recorder = read('modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift');
const store = read('modules/expo-durable-recorder/ios/DurableRecorderStore.swift');
const stageEnum = slice(recorder, 'enum DurableBeginStage', 'struct DurableBeginAttemptFailure');
const policyStruct = slice(recorder, 'struct DurableCheckpointRetryPolicy', 'final class DurableForegroundRecorder');
const retryFn = stripComments(slice(recorder, 'private func beginCheckpointSegment(', 'private func emitEnteredPaused(')).split('\n').slice(1).join('\n'); // body only, not the declaration
const decisionFn = stripComments(slice(recorder, 'private func checkpointRetryDecision(', 'private func recordBeginFailure('));
const rollover = slice(recorder, 'private func performCheckpointRollover(recordingSessionId: String) throws {', 'private func failCheckpointCapture(');

console.log('Exactly one retry, no loop, no recursion, only inside a checkpoint rollover');
check('the retry policy runs one first attempt and at most one second attempt', () => {
  assert.equal((retryFn.match(/performBeginAttempt\(/g) ?? []).length, 2, 'exactly two attempt call sites');
  assert.match(retryFn, /attempt: 1\)/);
  assert.match(retryFn, /attempt: 2\)/);
  assert.doesNotMatch(retryFn, /\bfor\b|\bwhile\b|repeat\s*\{|asyncAfter|Task\s*\{|DispatchQueue/, 'no loop, no scheduled retry');
  assert.doesNotMatch(retryFn, /beginCheckpointSegment\(|beginSegment\(/, 'no recursion and no re-entry through the entry point');
});
check('only the checkpoint rollover reaches the policy; Start and Resume call the non-retrying entry point', () => {
  assert.equal((recorder.match(/try beginCheckpointSegment\(/g) ?? []).length, 1);
  assert.match(rollover, /try beginCheckpointSegment\(recordingSessionId: recordingSessionId, previousCommitted: previousCommitted\)\s*\n\s*scheduleCheckpoint\(\)/);
  assert.equal((recorder.match(/try beginSegment\(recordingSessionId: recordingSessionId, resuming: (true|false)\)/g) ?? []).length, 2);
});
check('the retry only follows a COMMITTED old segment (the commit failure path is unchanged and never retries)', () => {
  const commitCatch = slice(rollover, 'diagnostics.emit(sessionId: recordingSessionId, [\n        "kind": "commit_failed"', 'do {\n      // Keep the audio session active');
  assert.match(commitCatch, /failCheckpointCapture\(/);
  assert.match(commitCatch, /throw error/);
  assert.doesNotMatch(commitCatch, /beginCheckpointSegment|performBeginAttempt/);
});

console.log('\nEligibility comes from the structured stage, never from error text')
check('eligible: exactly the transient audio-session / recorder stages', () => {
  const eligible = slice(stageEnum, 'var isCheckpointRetryEligible: Bool {', 'var mayHaveCreatedPartialFile');
  const yes = slice(eligible, 'case .audioSessionSetCategory', 'return true');
  for (const c of ['audioSessionSetCategory', 'audioSessionSetActive', 'audioSessionInputAvailability', 'inputAvailabilityRecheck', 'recorderInit', 'prepareToRecord', '.record']) {
    assert.ok(yes.includes(c), `${c} must be retryable`);
  }
  const no = slice(eligible, 'case .permissionCheck', 'return false');
  for (const c of ['permissionCheck', 'audioSessionUnclassified', 'segmentPlanCreate', 'sessionTransition']) {
    assert.ok(no.includes(c), `${c} must NOT be retryable`);
  }
});
check('the decision never inspects localized text, and covers every required precondition', () => {
  assert.doesNotMatch(decisionFn + retryFn, /localizedDescription|localizedFailureReason|\.contains\("|String\(describing: (first|second)\.error\)/);
  for (const marker of [
    'first.stage.isCheckpointRetryEligible', 'elapsedBudget', 'runtimeState == .recording', 'ownedSessionId == recordingSessionId',
    'activeCapture == nil, activePlan == nil', '!hasPendingSystemEvents', 'session.state == .recording', 'previous.segmentId',
  ]) assert.ok(decisionFn.includes(marker), `missing precondition: ${marker}`);
  assert.match(retryFn, /checkpointRetryDecision\([\s\S]*?\)\s*\{[\s\S]*?after_delay:/, 'preconditions are re-verified after the pause');
});
check('stage ids and the audio-session sub-stage come from the session manager, not from message parsing', () => {
  assert.match(recorder, /stageId = "audio_session\." \+ audioSession\.lastActivationStage/);
  assert.match(stageEnum, /case "audio_session\.set_category": self = \.audioSessionSetCategory/);
  assert.match(stageEnum, /default: self = \.audioSessionUnclassified\(stageId\)/);
});

console.log('\nSequence, ownership and audio session');
check('the retry never touches sequence state and never deactivates the audio session between attempts', () => {
  assert.doesNotMatch(retryFn, /diagNextSequence\s*=|sequence\s*\+=|sequence\s*=/, 'the sequence is derived from the manifest (createSegmentPlan), never set here');
  assert.doesNotMatch(retryFn, /audioSession\.deactivate\(\)/, 'no deactivate between attempt 1 and 2 (only in abandonFailedBegin)');
  assert.doesNotMatch(retryFn, /setCategory|setActive|activateForRecording/, 'the retry does not reconfigure the session itself; attempt 2 re-runs the same activation');
  assert.match(store, /let sequence = \(session\.segments\.map\(\\\.sequence\)\.max\(\) \?\? 0\) \+ 1/);
  assert.match(recorder, /try session\.setCategory\(\.record, mode: \.default, options: \[\.allowBluetoothHFP\]\)/);
  assert.match(recorder, /try session\.setActive\(true\)/);
});
check('the failed partial is quarantined by exact path, never deleted, and never a directory sweep', () => {
  const q = slice(store, 'func quarantineFailedPartial(', 'func segmentFileURL(');
  assert.doesNotMatch(q, /removeItem|contentsOfDirectory|enumerator|\*/, 'no delete, no sweep');
  assert.match(q, /moveItem\(at: plan\.activeURL, to: destination\)/);
  assert.match(q, /refused_referenced/);
  assert.match(q, /uniqueQuarantineURL/);
  assert.match(retryFn, /first\.stage\.mayHaveCreatedPartialFile/);
});

console.log('\nBounded parameters');
check('delay and time budget are named, bounded, injectable mitigation parameters', () => {
  assert.match(policyStruct, /static let maxDelay: TimeInterval = 0\.15/);
  assert.match(policyStruct, /static let productionDelay: TimeInterval = 0\.05/);
  assert.match(policyStruct, /static let productionElapsedBudget: TimeInterval = 1\.0/);
  assert.match(policyStruct, /self\.delay = min\(max\(delay, 0\), Self\.maxDelay\)/);
  assert.match(policyStruct, /let sleep: \(TimeInterval\) -> Void/);
  assert.match(policyStruct, /let uptime: \(\) -> TimeInterval/);
  assert.match(policyStruct, /NOT a measured recovery time/, 'documented as a mitigation parameter, not a measurement');
  assert.doesNotMatch(policyStruct, /DispatchQueue\.main|RunLoop\.main/, 'never waits on the main thread');
});

console.log('\nUnchanged behavior');
check('paused fallback, JS contract, interval, caption and legacy code are untouched', () => {
  assert.match(rollover, /lastInterruption = "checkpoint_begin_segment_failed"/);
  assert.match(rollover, /_ = try\? store\.transitionSession\(recordingSessionId: recordingSessionId, to: \.paused\)/);
  assert.match(recorder, /static let defaultCheckpointInterval: TimeInterval = 60/);
  const js = read('lib/recording/useNativeDurableLectureRecorder.ts');
  assert.match(js, /status\.interruptionState === 'checkpoint_begin_segment_failed'/);
  assert.doesNotMatch(js, /retry_started|retry_succeeded|checkpoint_retry/, 'JS is not involved in the retry');
  const mic = read('lib/liveMicStream.ts');
  assert.match(mic, /iosCategory: 'playAndRecord'/);
  assert.doesNotMatch(recorder + store, /telemetry|analytics|moov|M4A repair|reconstruct.*atom|UIBackgroundModes/i);
});
check('recovered failures stay visible: dedicated events, preferred by the bounded log', () => {
  for (const kindName of ['retry_decision', 'retry_started', 'retry_succeeded', 'retry_failed', 'entered_paused_state']) {
    assert.ok(retryFn.includes(`"kind": "${kindName}"`) || recorder.includes(`"kind": "${kindName}"`), `missing event ${kindName}`);
  }
  const failureKinds = slice(recorder, 'static func isFailureLine', 'static func uptimeMilliseconds');
  for (const kindName of ['retry_started', 'retry_succeeded', 'retry_failed', 'entered_paused_state', 'begin_failed']) {
    assert.ok(failureKinds.includes(kindName), `${kindName} is kept preferentially when the log is trimmed`);
  }
});

console.log('\ndurable-checkpoint-retry-contract: PASS');
