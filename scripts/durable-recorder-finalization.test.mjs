import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const sourcePaths = [
  'modules/expo-durable-recorder/ios/DurableRecorderCore.swift',
  'modules/expo-durable-recorder/ios/DurableRecorderStore.swift',
  'modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift',
  'modules/expo-durable-recorder/ios/DurableFinalAssetExporter.swift',
  'scripts/durable-recorder-finalization-core.test.swift',
].map((path) => new URL(path, root));
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'durable-recorder-phase2c-'));
const executablePath = join(temporaryDirectory, 'durable-recorder-finalization-tests');

try {
  const compilation = spawnSync('xcrun', ['swiftc', ...sourcePaths.map((url) => url.pathname), '-o', executablePath], { encoding: 'utf8' });
  assert.equal(compilation.status, 0, `Swift finalization test compilation failed:\n${compilation.stderr}`);
  const execution = spawnSync(executablePath, [], { encoding: 'utf8' });
  assert.equal(execution.status, 0, `Swift finalization tests failed:\n${execution.stderr}`);
  assert.match(execution.stdout, /native final asset tests passed/);

  const source = (await Promise.all(sourcePaths.slice(0, 4).map((url) => readFile(url, 'utf8')))).join('\n');
  assert.match(source, /AVMutableComposition/);
  assert.match(source, /AVAssetExportPresetAppleM4A/);
  assert.doesNotMatch(source, /Data\([^)]*contentsOf[^)]*\)\s*\.append|FileHandle[^\n]*write/i, 'M4A assets must never be byte-concatenated');
  assert.match(source, /lecture\.exporting\.m4a/);
  assert.match(source, /lecture\.m4a/);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('Durable recorder Phase 2C finalization tests passed.');
