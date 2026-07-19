import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const sourcePaths = [
  new URL('modules/expo-durable-recorder/ios/DurableRecorderCore.swift', root),
  new URL('modules/expo-durable-recorder/ios/DurableRecorderStore.swift', root),
  new URL('modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift', root),
  new URL('scripts/durable-recorder-audio-core.test.swift', root),
];
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'durable-recorder-phase2b-'));
const executablePath = join(temporaryDirectory, 'durable-recorder-audio-tests');

try {
  const compilation = spawnSync(
    'xcrun',
    ['swiftc', ...sourcePaths.map((url) => url.pathname), '-o', executablePath],
    { encoding: 'utf8' },
  );
  assert.equal(compilation.status, 0, `Swift audio test compilation failed:\n${compilation.stderr}`);
  const execution = spawnSync(executablePath, [], { encoding: 'utf8' });
  assert.equal(execution.status, 0, `Swift audio tests failed:\n${execution.stderr}`);
  assert.match(execution.stdout, /native audio engine tests passed/);

  const sources = (await Promise.all(sourcePaths.slice(0, 3).map((url) => readFile(url, 'utf8')))).join('\n');
  assert.match(sources, /AVAudioRecorder/, 'the engine uses Apple-native AVAudioRecorder');
  assert.match(sources, /kAudioFormatMPEG4AAC/, 'the engine records AAC');
  assert.match(sources, /\.partial\.m4a/, 'active artifacts are distinguishable from finalized M4A files');
  assert.match(sources, /AVAudioSession\.interruptionNotification/, 'interruption observer is registered');
  assert.match(sources, /AVAudioSession\.routeChangeNotification/, 'route observer is registered');
  assert.doesNotMatch(sources, /UIBackgroundModes|telemetry|analytics/i);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('Durable recorder Phase 2B audio tests passed.');
