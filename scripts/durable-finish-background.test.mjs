import assert from 'node:assert/strict';

import { nativeSources, readSources, runSwiftHarness } from './lib/swift-harness.mjs';

await runSwiftHarness({
  sources: [
    nativeSources.core,
    nativeSources.store,
    nativeSources.recorder,
    nativeSources.composer,
    nativeSources.exporter,
    'scripts/durable-finish-background-core.test.swift',
  ],
  expect: /native finish background tests passed/,
  tmpPrefix: 'durable-finish-background-',
});

const exporter = await readSources(nativeSources.exporter);
const moduleSource = await readSources('modules/expo-durable-recorder/ios/ExpoDurableRecorderModule.swift');
const composer = await readSources(nativeSources.composer);

// Structure: the background task spans stop -> export, and every terminal path ends it.
assert.match(moduleSource, /AsyncFunction\("stopRecording"\)[\s\S]*?self\.acquireFinishAssertion\(input\.recordingSessionId\)[\s\S]*?try self\.withEngine[\s\S]*?engine\.stopRecording/);
assert.match(moduleSource, /release\(sessionId: input\.recordingSessionId, reason: "stop_failed"\)/);
assert.match(moduleSource, /AsyncFunction\("exportFinalizedAsset"\)[\s\S]*?acquireFinishAssertion[\s\S]*?defer \{ self\.finishAssertion\.release\(sessionId: input\.recordingSessionId, reason: "export_finished"\) \}/);
assert.match(moduleSource, /cancelExport\(recordingSessionId: sessionId, backgroundTimeExpired: true\)/);
// The experiment switch that can disable the task is Dev-bundle only.
assert.match(moduleSource, /if DurableRecorderDiagnostics\.isDevBundle, Self\.finishBackgroundTaskDisabledByExperiment\(\)/);
// Expiry is an explicit failure, never a silent success, and never touches segments.
assert.match(exporter, /backgroundTimeExpiredMessage/);
assert.match(exporter, /catch AudioSegmentComposerError\.cancelled[\s\S]*?throw DurableRecorderCoreError\.finalAssetExportFailed\(Self\.backgroundTimeExpiredMessage\)/);
assert.doesNotMatch(exporter, /removeItem\(at: [^)]*segment/i, 'expiry must never delete committed segments');
assert.match(exporter, /iOS requires the task to be ended inside the expiration handler/);
assert.match(composer, /cancellation\?\.attach\(exporter\)/);

console.log('Durable finish background-execution tests passed.');
