/**
 * P0 background-recording contract.
 *
 * These are source/configuration guards for the native capability. Physical
 * capture continuity still requires a rebuilt Development Client and device run.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const appConfig = JSON.parse(read('../app.json'));
const recorder = read('../modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift');
const hook = read('../lib/recording/useNativeDurableLectureRecorder.ts');
const legacyHook = read('../lib/recording/useLegacyLectureRecorder.ts');

const audioApiPlugin = appConfig.expo.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === 'react-native-audio-api',
);

assert.equal(audioApiPlugin?.[1]?.iosBackgroundMode, true, 'prebuild config must declare iOS audio background mode');
assert.deepEqual(appConfig.expo.ios.infoPlist.UIBackgroundModes, ['audio']);

assert.match(recorder, /setCategory\(\.record, mode: \.default, options: \[\.allowBluetoothHFP\]\)/);
assert.match(recorder, /try session\.setActive\(true\)/);
// Backgrounding must never pause/stop/finalize the recorder. The ONLY UIApplication observers allowed are:
//  - Dev-diagnostics-gated app-state labels (setAppState / emitLifecycle only), and
//  - didBecomeActive, which only runs the one bounded auto-recovery of a recorder-initiated protective pause.
const observerBlock = recorder.slice(recorder.indexOf('private func registerObservers()'), recorder.indexOf('private func handleInterruption'));
const appObservers = [...observerBlock.matchAll(/UIApplication\.(\w+)Notification/g)].map((m) => m[1]);
assert.deepEqual([...new Set(appObservers)].sort(), ['didBecomeActive', 'didEnterBackground', 'willEnterForeground', 'willResignActive']);
const backgroundEntry = observerBlock.slice(observerBlock.indexOf('let appEvents'), observerBlock.indexOf('#endif', observerBlock.indexOf('let appEvents')));
assert.doesNotMatch(backgroundEntry, /handleForcedPause|pauseRecording|stopRecording|finalizeActiveSegment|cancelCheckpoint/, 'app-state observers never touch the recorder');
assert.match(observerBlock, /if diagnostics\.isEnabled \{[\s\S]*?let appEvents/, 'background/resign labels are Dev-diagnostics only');
assert.match(observerBlock, /UIApplication\.didBecomeActiveNotification, object: nil, queue: nil\s*\n\s*\) \{ \[weak self\] _ in\s*\n\s*self\?\.queue\.async \{ self\?\.attemptAutomaticRecoveryAfterProtectivePause\(\) \}/);
assert.doesNotMatch(recorder, /application_backgrounded/);
assert.match(recorder, /AVAudioSession\.interruptionNotification/);
assert.match(recorder, /AVAudioSession\.routeChangeNotification/);
assert.match(recorder, /defaultCheckpointInterval: TimeInterval = 60/);

assert.match(hook, /next !== 'active'/, 'background must not invoke a JS pause/stop path');
assert.match(hook, /Date\.now\(\) - started/, 'elapsed time must recover from a stable start timestamp');
assert.match(hook, /pauseNative\(/, 'an explicit pause must remain distinct from backgrounding');
assert.match(legacyHook, /allowsRecording: true,[\s\S]{0,120}shouldPlayInBackground: true/);
assert.match(legacyHook, /shouldPlayInBackground: true,[\s\S]{0,120}allowsBackgroundRecording: true/);
assert.match(legacyHook, /allowsRecording: false,[\s\S]{0,120}shouldPlayInBackground: false/);
assert.match(legacyHook, /shouldPlayInBackground: false,[\s\S]{0,120}allowsBackgroundRecording: false/);

// Mutation proof: reintroducing the previous forced background pause must fail
// the exact invariant above, without mutating the user’s working tree.
const backgroundTeardownMutant = `${recorder}\nUIApplication.didEnterBackgroundNotification\napplication_backgrounded`;
assert.match(backgroundTeardownMutant, /UIApplication\.didEnterBackgroundNotification/);
assert.match(backgroundTeardownMutant, /application_backgrounded/);

const legacyBackgroundPauseMutant = legacyHook.replace('allowsBackgroundRecording: true', 'allowsBackgroundRecording: false');
assert.doesNotMatch(legacyBackgroundPauseMutant, /allowsBackgroundRecording: true/);

console.log('Background recording continuity configuration and lifecycle guards passed.');
