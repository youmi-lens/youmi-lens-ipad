/**
 * Recording Release B — rollover DIAGNOSTIC instrumentation contract.
 *
 * Behavioral proof lives in durable-recorder-audio-core.test.swift (stage ids, NSError survival, bounded log,
 * persistence failure isolation, default-off). This file locks what must NOT change (recording semantics).
 *
 * Run: node --experimental-strip-types scripts/durable-rollover-diagnostics.test.mjs
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

const recorder = read('modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift');
const store = read('modules/expo-durable-recorder/ios/DurableRecorderStore.swift');
const begin = slice(recorder, 'private func performBeginAttempt(', 'private func abandonFailedBegin(');
const beginEntry = slice(recorder, 'private func beginSegment(recordingSessionId: String, resuming: Bool) throws', 'private func performBeginAttempt(');
const abandon = slice(recorder, 'private func abandonFailedBegin(', 'private static func milliseconds');
const rollover = slice(recorder, 'private func performCheckpointRollover(\n    recordingSessionId: String,', 'private func failCheckpointCapture(');
const manager = slice(recorder, 'final class SystemDurableAudioSessionManager', '#else');
const diagClass = slice(recorder, 'final class DurableRecorderDiagnostics {', undefined);

console.log('Every beginSegment boundary has its own stage id, in execution order');
check('stage ids are assigned in the same order the operations run', () => {
  const order = [
    'var stage = "permission_check"',
    'stage = "audio_session"',
    'try audioSession.activateForRecording(reassertConfiguration: reassertAudioSession)',
    'stage = "input_availability_recheck"',
    'stage = "segment_plan_create"',
    'try store.createSegmentPlan(recordingSessionId: recordingSessionId)',
    'stage = "recorder_init"',
    'try captureFactory.makeCapture(url: newPlan.activeURL)',
    'stage = "prepare_to_record"',
    'let prepared = capture.prepareToRecord()',
    'stage = "record"',
    'started = capture.record()',
    'stage = "session_transition"',
    'try store.transitionSession(recordingSessionId: recordingSessionId, to: .recording)',
  ];
  let cursor = -1;
  for (const marker of order) {
    const index = begin.indexOf(marker, cursor + 1);
    assert.ok(index > cursor, `out of order or missing: ${marker}`);
    cursor = index;
  }
  const stages = [...begin.matchAll(/stage = "([a-z_]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(stages).size, stages.length, 'each stage id is used exactly once (no collapsing into one generic error)');
});
check('the AVAudioSession activation splits into set_category / set_active / input_availability', () => {
  const activate = slice(manager, 'func activateForRecording(reassertConfiguration: Bool) throws {', 'func diagnosticSnapshot()');
  const order = ['lastActivationStage = "set_category"', 'try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])',
    'lastActivationStage = "set_active"', 'try session.setActive(true)', 'lastActivationStage = "input_availability"', 'guard hasSuitableInput', 'lastActivationStage = "activated"'];
  let cursor = -1;
  for (const marker of order) { const i = activate.indexOf(marker, cursor + 1); assert.ok(i > cursor, marker); cursor = i; }
  assert.match(recorder, /resolvedStage = "audio_session\." \+ audioSession\.lastActivationStage/);
});

console.log('\nNo behavioral change');
check('the audio-session operations, category and options are exactly what shipped', () => {
  assert.match(manager, /try session\.setCategory\(\.record, mode: \.default, options: \[\.allowBluetoothHFP\]\)/);
  assert.match(manager, /try session\.setActive\(true\)/);
  assert.match(manager, /try session\.setActive\(false, options: \[\.notifyOthersOnDeactivation\]\)/);
});
check('the original failure handling of beginSegment is preserved: same cleanup, same order, same rethrow (Start/Resume never retry)', () => {
  const order = ['activeCapture?.stop()', 'clearActiveCapture()', 'audioSession.deactivate()'];
  let cursor = -1;
  for (const marker of order) { const i = abandon.indexOf(marker, cursor + 1); assert.ok(i > cursor, marker); cursor = i; }
  assert.match(abandon, /runtimeState = resuming \? \.paused : \.ready/);
  assert.match(abandon, /if !failure\.isPermissionGuard \{/, 'the permission guard still never deactivates the session');
  assert.match(begin, /recordBeginFailure\([\s\S]*?\)\n\s*var stageId = stage/, 'evidence is still recorded FIRST, before any cleanup');
  assert.match(beginEntry, /abandonFailedBegin\(failure, resuming: resuming\)\s*\n\s*throw failure\.error/);
  const entryCode = beginEntry.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(entryCode, /\bfor\b|\bwhile\b|repeat\s*\{|asyncAfter|sleep|retry/i, 'Start/Resume entry point never retries');
  const code = begin.replace(/\/\/.*$/gm, '').split('\n').slice(1).join('\n');
  assert.doesNotMatch(code, /\bfor\b|\bwhile\b|repeat\s*\{|Task\.sleep|asyncAfter|beginSegment\(|performBeginAttempt\(|retry/i, 'one attempt: no loop, delay or recursion inside the attempt (comments excluded)');
  assert.equal((recorder.match(/try beginSegment\(recordingSessionId: recordingSessionId, resuming: (true|false)\)/g) ?? []).length, 2, 'beginSegment is called by Start and Resume only');
  assert.match(recorder, /try beginCheckpointSegment\(recordingSessionId: recordingSessionId, previousCommitted: previousCommitted\)\s*\n\s*scheduleCheckpoint\(\)/);
  assert.match(recorder, /failureInterruption: String = "checkpoint_begin_segment_failed"/);
  assert.match(recorder, /lastInterruption = failureInterruption/);
});
check('prepare/record keep their original short-circuit semantics (record() is not called when prepare fails)', () => {
  assert.match(begin, /let prepared = capture\.prepareToRecord\(\)[\s\S]*?if prepared \{[\s\S]*?started = capture\.record\(\)[\s\S]*?\}[\s\S]*?guard prepared, started else \{\s*capture\.stop\(\)\s*throw DurableRecorderCoreError\.recorderStartFailed/);
});
check('checkpoint interval, recording engine and durability settings are unchanged', () => {
  assert.match(recorder, /static let defaultCheckpointInterval: TimeInterval = 60/);
  assert.match(recorder, /AVEncoderBitRateKey: 96_000/);
  const gate = read('lib/recording/featureGate.ts');
  assert.match(gate, /CONFIGURED_RECORDING_ENGINE: RecordingEngine = 'legacy'/);
  const eas = JSON.parse(read('eas.json'));
  assert.deepEqual(eas.build.production.env, { EXPO_PUBLIC_USE_REAL_IAP: 'true', EXPO_PUBLIC_RECORDING_DEFAULT_ENGINE: 'nativeDurable' }, 'the production EAS profile is exactly IAP + the approved recording build default (no dogfood/diagnostic/injector flags)');
});
check('rollover buffers evidence in memory: no file I/O between the old recorder stopping and the new one recording', () => {
  assert.equal((rollover.match(/diagnostics\.flush\(\)/g) ?? []).length, 1, 'one flush, in a defer that runs after rollover work');
  assert.match(rollover, /defer \{\s*diagnostics\.flush\(\)/);
  const emit = slice(diagClass, 'func emit(sessionId: String', '/// Writes and clears buffered events');
  assert.doesNotMatch(emit, /FileHandle|FileManager|\.write\(|createFile/, 'emit() only buffers');
  assert.doesNotMatch(begin, /flush\(\)/, 'a begin attempt never writes evidence itself');
  assert.match(beginEntry, /defer \{ diagnostics\.flush\(\) \}/);
  const policy = slice(recorder, 'private func beginCheckpointSegment(', 'private func emitEnteredPaused(');
  assert.equal((policy.match(/diagnostics\.flush\(\)/g) ?? []).length, 1, 'the retry path flushes once, only after a FAILED first attempt and before the pause');
});
check('the diagnostics log is OFF unless the Dev bundle enables it, and cannot throw', () => {
  assert.match(recorder, /enabled: DurableRecorderDiagnostics\.isDevBundle/);
  assert.match(diagClass, /Bundle\.main\.bundleIdentifier\?\.hasSuffix\("\.dev"\) == true/);
  assert.match(diagClass, /guard isEnabled else \{ return \}/);
  for (const fn of ['func emit(', 'func flush()', 'private func append(', 'private func trimIfNeeded(']) {
    const start = diagClass.indexOf(fn);
    assert.ok(start >= 0, fn);
    const body = diagClass.slice(start, diagClass.indexOf('\n  }\n', start));
    assert.doesNotMatch(body, /\bthrows\b|fatalError|try!|precondition\(/, `${fn} cannot throw or trap`);
  }
  assert.match(diagClass, /static let maxLines = 240/);
  assert.match(diagClass, /static let maxFailureLines = 40/);
});
check('recorded content is structural only: no audio, transcripts, tokens or user text; file is not part of segments/export', () => {
  assert.doesNotMatch(diagClass, /transcript|caption|token|password|email/i);
  assert.match(store, /appendingPathComponent\("diagnostics\.jsonl"/);
  assert.doesNotMatch(read('modules/expo-durable-recorder/ios/AudioSegmentComposer.swift'), /diagnostics/);
  assert.doesNotMatch(recorder + store, /telemetry|analytics|moov|M4A repair|reconstruct.*atom/i);
});
check('failure record carries every required field', () => {
  const failure = slice(recorder, 'private func recordBeginFailure(', 'diagnostics.emit(sessionId: recordingSessionId, event)');
  for (const field of ['"stage"', '"error"', '"recorder"', '"atFailure"', '"pre"', '"lecture"', '"seq"', '"cp"', '"stopToFailMs"', '"route"', '"committedSegments"']) {
    assert.ok(failure.includes(field), `missing ${field}`);
  }
  const describe = slice(diagClass, 'static func describe(', 'static func fourCC');
  for (const key of ['"domain"', '"code"', '"desc"', 'NSUnderlyingErrorKey', '"swift"']) assert.ok(describe.includes(key), key);
  const snapshot = manager.slice(manager.indexOf('func diagnosticSnapshot()'));
  for (const key of ['"category"', '"mode"', '"options"', '"otherAudioPlaying"', '"secondaryAudioSilenceHint"', '"sampleRate"', '"ioBufferMs"', '"inputAvailable"', '"inputs"', '"outputs"', '"preferredInput"', '"recordPermission"']) {
    assert.ok(snapshot.includes(key), `session snapshot missing ${key}`);
  }
  assert.match(rollover, /"pre": diagRolloverPre as Any/);
  assert.match(begin, /stopToRecordMs/);
  assert.match(rollover, /"kind": "old_segment_committed"/);
});

console.log('\ndurable-rollover-diagnostics: instrumentation contract PASS');
