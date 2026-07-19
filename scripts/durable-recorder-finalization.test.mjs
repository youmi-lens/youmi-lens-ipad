import assert from 'node:assert/strict';

import { nativeSources, readSources, runSwiftHarness } from './lib/swift-harness.mjs';

await runSwiftHarness({
  sources: [
    nativeSources.core,
    nativeSources.store,
    nativeSources.recorder,
    nativeSources.exporter,
    'scripts/durable-recorder-finalization-core.test.swift',
  ],
  expect: /native final asset tests passed/,
  tmpPrefix: 'durable-recorder-phase2c-',
});

const source = await readSources(
  nativeSources.core,
  nativeSources.store,
  nativeSources.recorder,
  nativeSources.exporter,
);
assert.match(source, /AVMutableComposition/);
assert.match(source, /AVAssetExportPresetAppleM4A/);
assert.doesNotMatch(
  source,
  /Data\([^)]*contentsOf[^)]*\)\s*\.append|FileHandle[^\n]*write/i,
  'M4A assets must never be byte-concatenated',
);
assert.match(source, /lecture\.exporting\.m4a/);
assert.match(source, /lecture\.m4a/);

console.log('Durable recorder Phase 2C finalization tests passed.');
