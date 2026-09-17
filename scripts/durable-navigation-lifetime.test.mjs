import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');
const nativeHook = read('lib/recording/useNativeDurableLectureRecorder.ts');
const screen = read('app/recording.tsx');
const nativeModule = read('modules/expo-durable-recorder/ios/ExpoDurableRecorderModule.swift');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('nativeDurable navigation lifetime contract');

check('screen unmount never pauses native capture', () => {
  const beforeInitialization = nativeHook.slice(0, nativeHook.indexOf("useEffect(() => {\n    if (!enabled) return;"));
  assert.doesNotMatch(beforeInitialization, /pauseNative\(/);
  assert.match(nativeHook, /unmounting are not recording-state transitions/);
});

check('only explicit Pause owns pauseNative', () => {
  const pauseFn = nativeHook.slice(nativeHook.indexOf('const pauseRecording ='), nativeHook.indexOf('const resumeRecording ='));
  assert.match(pauseFn, /await pauseNative\(\{ recordingSessionId: session\.recordingSessionId \}\)/);
  const leaveFn = nativeHook.slice(nativeHook.indexOf('const leaveRecording ='), nativeHook.indexOf('const recoverRecording ='));
  assert.doesNotMatch(leaveFn, /pauseRecording\(|pauseNative\(/);
});

check('Back preserves a live native session but legacy Back behavior remains separate', () => {
  const back = screen.slice(screen.indexOf('const handleBack ='), screen.indexOf('const markImportant ='));
  assert.match(back, /recordingEngine === 'nativeDurable' && isRecording/);
  assert.match(back, /persistProgress\(\);\n\s*router\.back\(\);\n\s*return;/);
  assert.match(back, /uri = await leaveRecording\(\)/);
});

check('remount reads live native status and suppresses a false recovery modal', () => {
  assert.match(nativeHook, /getRecordingStatus\(\)\.catch\(\(\) => null\)/);
  assert.match(nativeHook, /liveStatus\?\.recordingSessionId === match\.recordingSessionId/);
  assert.match(screen, /const isLiveNativeReattachment = recordingEngine === 'nativeDurable'/);
  assert.match(screen, /!isLiveNativeReattachment/);
});

check('native module remains the durable owner across a React screen lifecycle', () => {
  assert.match(nativeModule, /private lazy var engineResult = Result \{/);
  assert.match(nativeModule, /DurableForegroundRecorder\(store: try storeResult\.get\(\)\)/);
});

console.log(`\nnativeDurable navigation lifetime: ${passed} checks passed`);
