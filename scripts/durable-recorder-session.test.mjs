import assert from 'node:assert/strict';

import { nativeSources, readSources, runSwiftHarness } from './lib/swift-harness.mjs';

await runSwiftHarness({
  sources: [
    nativeSources.core,
    nativeSources.store,
    'scripts/durable-recorder-session-core.test.swift',
  ],
  expect: /native session core tests passed/,
  tmpPrefix: 'durable-recorder-phase2a-',
});

const storeSource = await readSources(nativeSources.store);
assert.match(storeSource, /applicationSupportDirectory/, 'durable storage uses Application Support');
assert.match(storeSource, /isExcludedFromBackup = true/, 'durable recorder root is excluded from backup');
assert.match(storeSource, /options: \.atomic/, 'metadata replacement explicitly uses atomic writes');
assert.match(storeSource, /canonicalIdentifier/, 'all session paths require canonical identifiers');

const sessionLayer = await readSources(nativeSources.core, nativeSources.store);
assert.doesNotMatch(sessionLayer, /AVFoundation|AVAudioSession|AVAudioRecorder|AVAudioEngine/);

console.log('Durable recorder Phase 2A session tests passed.');
