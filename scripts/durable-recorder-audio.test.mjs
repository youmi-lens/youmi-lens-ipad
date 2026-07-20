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
assert.match(sources, /defaultCheckpointInterval/, 'production checkpoint interval is defined');
assert.match(sources, /performCheckpointRollover/, 'internal segment checkpoint rollover exists');
assert.match(sources, /checkpointGeneration/, 'stale checkpoint callbacks are identity-gated');
assert.doesNotMatch(sources, /UIBackgroundModes|telemetry|analytics/i);
assert.doesNotMatch(
  sources,
  /moov|M4A repair|reconstruct.*atom/i,
  'checkpoint durability must not depend on M4A binary repair',
);

console.log('Durable recorder Phase 2B audio tests passed.');
