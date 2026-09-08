import { nativeSources, runSwiftHarness } from './lib/swift-harness.mjs';

// Phase 2C forced-relaunch recovery: resume, discard, and interrupted capture.
await runSwiftHarness({
  sources: [
    nativeSources.core,
    nativeSources.store,
    nativeSources.recorder,
    nativeSources.composer,
    nativeSources.exporter,
    'scripts/durable-recorder-recovery-core.test.swift',
  ],
  expect: /native recovery tests passed/,
  tmpPrefix: 'durable-recorder-recovery-',
});

console.log('Durable recorder Phase 2C recovery tests passed.');
