import assert from 'node:assert/strict';

import { nativeSources, readSources, runSwiftHarness } from './lib/swift-harness.mjs';

await runSwiftHarness({
  sources: [
    nativeSources.core,
    nativeSources.store,
    nativeSources.recorder,
    nativeSources.composer,
    nativeSources.exporter,
    'scripts/durable-packet-concatenation-core.test.swift',
  ],
  expect: /native packet concatenation tests passed/,
  tmpPrefix: 'durable-packet-concatenation-',
});

const composer = await readSources(nativeSources.composer);
const exporter = await readSources(nativeSources.exporter);
const moduleSource = await readSources('modules/expo-durable-recorder/ios/ExpoDurableRecorderModule.swift');

console.log('Packet concatenation: structure');
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
check('the fast path never decodes or re-encodes: nil reader/writer settings, no AVAssetExportSession, no byte concatenation', () => {
  const start = composer.indexOf('enum PacketPreservingConcatenator');
  assert.ok(start > 0);
  const body = composer.slice(start);
  assert.match(body, /AVAssetReaderTrackOutput\(track: source\.track, outputSettings: nil\)/);
  assert.match(body, /AVAssetWriterInput\(mediaType: \.audio, outputSettings: nil,/);
  assert.doesNotMatch(body, /AVAssetExportSession|AVAudioConverter|AVEncoderBitRateKey|kAudioFormatMPEG4AAC,\s*\n?\s*\]|FileHandle[^\n]*write/);
});
check('every unexpected condition refuses before commit (format, priming, cookie, remainder, length)', () => {
  for (const reason of ['unexpected audio format', 'codec configuration differs', 'priming is not', 'non-zero remainder', 'too short']) {
    assert.ok(composer.includes(reason), reason);
  }
});
check('the original re-encoding composer is preserved as the fallback and still used', () => {
  assert.match(exporter, /if !builtWithoutReencode \{\s*\n\s*try await AudioSegmentComposer\.compose\(/);
  assert.match(exporter, /"outcome": "fallback_to_reencode"/);
  assert.match(exporter, /\} catch PacketConcatenationError\.cancelled \{\s*\n\s*try\? FileManager\.default\.removeItem\(at: plan\.temporaryURL\)\s*\n\s*throw PacketConcatenationError\.cancelled/, 'cancellation is never swallowed by the fallback');
});
check('the committed segments are only ever read; the fast path writes one new file at the temporary URL', () => {
  const body = composer.slice(composer.indexOf('enum PacketPreservingConcatenator'));
  assert.doesNotMatch(body, /removeItem\(at: (source|url)\b|\.moveItem|replaceItem/);
});
check('the Dev switch can force re-encode; production answers packetPreserving', () => {
  assert.match(exporter, /var strategyProvider: \(\) -> Strategy = \{ \.packetPreserving \}/);
  assert.match(moduleSource, /finalExportStrategy/);
  assert.match(moduleSource, /DurableRecorderDiagnostics\.isDevBundle/);
});

console.log('Durable packet concatenation tests passed.');
