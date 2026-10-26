/**
 * Regression guard for the unified AVAudioEngine ASR spike gate.
 *
 * Production must stay on the dual-mic path unless the env var is exactly '1'.
 * Pure gate behavior is mirrored here (same contract as
 * lib/recording/unifiedAudioAsrSpikeGate.ts) so this script runs on Node
 * without --experimental-strip-types. Structural checks lock the source and
 * recording.tsx wiring.
 *
 * Run: node scripts/unified-audio-asr-spike-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Mirrors isUnifiedAudioAsrSpikeEnabled({ envValue }) — keep in sync with the .ts gate. */
function isUnifiedAudioAsrSpikeEnabled(envValue) {
  return envValue === '1';
}

console.log('Pure gate contract: only exact env value "1" enables the spike');

check('disabled when env is undefined (production default)', () => {
  assert.equal(isUnifiedAudioAsrSpikeEnabled(undefined), false);
});

check('disabled for near-miss values', () => {
  for (const value of ['0', 'true', 'yes', '', ' 1', '1 ', 'TRUE']) {
    assert.equal(
      isUnifiedAudioAsrSpikeEnabled(value),
      false,
      `envValue=${JSON.stringify(value)} must not enable the spike`,
    );
  }
});

check('enabled only when envValue is exactly "1"', () => {
  assert.equal(isUnifiedAudioAsrSpikeEnabled('1'), true);
});

console.log('Structural: gate source matches the mirrored contract');

const gateSource = read('../lib/recording/unifiedAudioAsrSpikeGate.ts');
check('unifiedAudioAsrSpikeGate.ts has no local imports', () => {
  assert.doesNotMatch(gateSource, /^import /m);
});
check('gate reads EXPO_PUBLIC_UNIFIED_AUDIO_ASR_SPIKE and requires exact "1"', () => {
  assert.match(gateSource, /EXPO_PUBLIC_UNIFIED_AUDIO_ASR_SPIKE/);
  assert.match(gateSource, /return envValue === '1'/);
});

check('.env.example documents the flag defaulted off', () => {
  const envExample = read('../.env.example');
  assert.match(envExample, /EXPO_PUBLIC_UNIFIED_AUDIO_ASR_SPIKE=0/);
  assert.doesNotMatch(
    envExample,
    /^EXPO_PUBLIC_UNIFIED_AUDIO_ASR_SPIKE=1\s*$/m,
    'example must not default the spike ON',
  );
});

console.log('Structural: recording screen gates the spike; production mic path preserved');

const recordingScreen = read('../app/recording.tsx');
check('recording.tsx imports the spike gate and bridge', () => {
  assert.match(recordingScreen, /isUnifiedAudioAsrSpikeEnabled/);
  assert.match(recordingScreen, /startUnifiedAudioAsrSpike/);
  assert.match(recordingScreen, /stopUnifiedAudioAsrSpike/);
});

check('recording.tsx still starts liveMicStream on the flag-OFF path', () => {
  assert.match(recordingScreen, /startMicStream\(/);
});

check('spike branch is behind the flag check', () => {
  assert.match(
    recordingScreen,
    /if \(isUnifiedAudioAsrSpikeEnabled\(\)\) \{[\s\S]*?startUnifiedAudioAsrSpike/,
  );
});

console.log('Structural: featureGate / durable module production defaults untouched');

const featureGate = read('../lib/recording/featureGate.ts');
check('CONFIGURED_RECORDING_ENGINE remains legacy (committed default)', () => {
  assert.match(featureGate, /export const CONFIGURED_RECORDING_ENGINE: RecordingEngine = 'legacy'/);
});
check('featureGate does not reference the spike env var', () => {
  assert.doesNotMatch(featureGate, /UNIFIED_AUDIO_ASR_SPIKE/);
});

const durableModule = read('../modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift');
check('production DurableForegroundRecorder still uses AVAudioRecorder factory', () => {
  assert.match(durableModule, /AVAudioRecorder\(url: url, settings: durableRecorderAudioSettings\)/);
});
check('DurableForegroundRecorder does not import the spike engine', () => {
  assert.doesNotMatch(durableModule, /UnifiedAudioAsrSpike|expo-unified-audio-asr-spike/);
});

const spikeSwift = read('../modules/expo-unified-audio-asr-spike/ios/UnifiedAudioAsrSpikeEngine.swift');
check('spike documents 48 kHz PCM and 44.1 kHz AAC choices', () => {
  assert.match(spikeSwift, /targetPcmSampleRate: Double = 48_000/);
  assert.match(spikeSwift, /AVSampleRateKey: 44_100/);
  assert.match(spikeSwift, /pcmFormatInt16/);
});

const docs = read('../docs/verification/unified-audio-asr-spike.md');
check('docs note exists and states production default unchanged', () => {
  assert.match(docs, /EXPO_PUBLIC_UNIFIED_AUDIO_ASR_SPIKE=1/);
  assert.match(docs, /Production defaults are unchanged/i);
});

console.log(`\n${passed} checks passed`);
