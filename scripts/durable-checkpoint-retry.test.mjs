import { nativeSources, runSwiftHarness } from './lib/swift-harness.mjs';

// Behavioral proof for the bounded checkpoint-rollover retry (one retry, same sequence, new segment id, paused
// fallback, process death, final assembly). The harness compiles the shipping recorder, store, composer and exporter.
await runSwiftHarness({
  sources: [
    nativeSources.core,
    nativeSources.store,
    nativeSources.recorder,
    nativeSources.composer,
    nativeSources.exporter,
    'scripts/durable-checkpoint-retry-core.test.swift',
  ],
  expect: /durable checkpoint retry tests passed/,
  tmpPrefix: 'durable-checkpoint-retry-',
});
console.log('durable-checkpoint-retry: native behavior PASS');
