import assert from 'node:assert/strict';

import { nativeSources, readSources, runSwiftHarness } from './lib/swift-harness.mjs';

await runSwiftHarness({
  sources: [
    nativeSources.core,
    nativeSources.store,
    nativeSources.recorder,
    'scripts/durable-recorder-audio-core.test.swift',
  ],
  expect: /native audio engine tests passed/,
  tmpPrefix: 'durable-recorder-phase2b-',
});

const sources = await readSources(nativeSources.core, nativeSources.store, nativeSources.recorder);
assert.match(sources, /AVAudioRecorder/, 'the engine uses Apple-native AVAudioRecorder');
assert.match(sources, /kAudioFormatMPEG4AAC/, 'the engine records AAC');
assert.match(sources, /\.partial\.m4a/, 'active artifacts are distinguishable from finalized M4A files');
assert.match(sources, /AVAudioSession\.interruptionNotification/, 'interruption observer is registered');
assert.match(sources, /AVAudioSession\.routeChangeNotification/, 'route observer is registered');
assert.doesNotMatch(sources, /UIBackgroundModes|telemetry|analytics/i);

console.log('Durable recorder Phase 2B audio tests passed.');
