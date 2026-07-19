import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const sourcePaths = [
  'modules/expo-durable-recorder/ios/DurableRecorderCore.swift',
  'modules/expo-durable-recorder/ios/DurableRecorderStore.swift',
  'modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift',
  'modules/expo-durable-recorder/ios/DurableFinalAssetExporter.swift',
  'scripts/durable-recorder-recovery-core.test.swift',
].map((path) => new URL(path, root));
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'durable-recorder-recovery-'));
const executablePath = join(temporaryDirectory, 'durable-recorder-recovery-tests');

try {
  const compilation = spawnSync(
    'xcrun',
    ['swiftc', ...sourcePaths.map((url) => url.pathname), '-o', executablePath],
    { encoding: 'utf8' },
  );
  assert.equal(compilation.status, 0, `Swift recovery test compilation failed:\n${compilation.stderr}`);
  const execution = spawnSync(executablePath, [], { encoding: 'utf8' });
  assert.equal(execution.status, 0, `Swift recovery tests failed:\n${execution.stdout}${execution.stderr}`);
  assert.match(execution.stdout, /native recovery tests passed/);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('Durable recorder Phase 2C recovery tests passed.');
