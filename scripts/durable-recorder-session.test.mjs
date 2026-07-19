import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const corePath = new URL('modules/expo-durable-recorder/ios/DurableRecorderCore.swift', root);
const storePath = new URL('modules/expo-durable-recorder/ios/DurableRecorderStore.swift', root);
const nativeTestPath = new URL('scripts/durable-recorder-session-core.test.swift', root);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'durable-recorder-phase2a-'));
const executablePath = join(temporaryDirectory, 'durable-recorder-core-tests');

try {
  const compilation = spawnSync(
    'xcrun',
    ['swiftc', corePath.pathname, storePath.pathname, nativeTestPath.pathname, '-o', executablePath],
    { encoding: 'utf8' },
  );
  assert.equal(compilation.status, 0, `Swift core test compilation failed:\n${compilation.stderr}`);

  const execution = spawnSync(executablePath, [], { encoding: 'utf8' });
  assert.equal(execution.status, 0, `Swift core tests failed:\n${execution.stderr}`);
  assert.match(execution.stdout, /native session core tests passed/);

  const [coreSource, storeSource] = await Promise.all([
    readFile(corePath, 'utf8'),
    readFile(storePath, 'utf8'),
  ]);
  assert.match(storeSource, /applicationSupportDirectory/, 'durable storage uses Application Support');
  assert.match(storeSource, /isExcludedFromBackup = true/, 'durable recorder root is excluded from backup');
  assert.match(storeSource, /options: \.atomic/, 'metadata replacement explicitly uses atomic writes');
  assert.match(storeSource, /canonicalIdentifier/, 'all session paths require canonical identifiers');
  assert.doesNotMatch(`${coreSource}\n${storeSource}`, /AVFoundation|AVAudioSession|AVAudioRecorder|AVAudioEngine/);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('Durable recorder Phase 2A session tests passed.');
