import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const repositoryRoot = new URL('../../', import.meta.url);

/** Production Swift sources, in the order swiftc needs them. */
export const nativeSources = {
  core: 'modules/expo-durable-recorder/ios/DurableRecorderCore.swift',
  store: 'modules/expo-durable-recorder/ios/DurableRecorderStore.swift',
  recorder: 'modules/expo-durable-recorder/ios/DurableForegroundRecorder.swift',
  exporter: 'modules/expo-durable-recorder/ios/DurableFinalAssetExporter.swift',
};

export function sourceUrl(relativePath) {
  return new URL(relativePath, repositoryRoot);
}

/**
 * Compiles the real production Swift sources together with a test file and runs
 * the resulting binary. Compiling the shipping sources (rather than a copy) is
 * what makes these harnesses meaningful: a production regression breaks them.
 */
export async function runSwiftHarness({ sources, expect, tmpPrefix = 'durable-recorder-' }) {
  const sourceUrls = sources.map((path) => sourceUrl(path));
  const temporaryDirectory = await mkdtemp(join(tmpdir(), tmpPrefix));
  const executablePath = join(temporaryDirectory, 'harness');

  try {
    const compilation = spawnSync(
      'xcrun',
      ['swiftc', ...sourceUrls.map((url) => url.pathname), '-o', executablePath],
      { encoding: 'utf8' },
    );
    assert.equal(compilation.status, 0, `Swift harness compilation failed:\n${compilation.stderr}`);

    const execution = spawnSync(executablePath, [], { encoding: 'utf8' });
    assert.equal(
      execution.status,
      0,
      `Swift harness failed:\n${execution.stdout}${execution.stderr}`,
    );
    assert.match(execution.stdout, expect);
    return execution.stdout;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Reads and concatenates sources so a test can assert on production code shape. */
export async function readSources(...relativePaths) {
  const contents = await Promise.all(
    relativePaths.map((path) => readFile(sourceUrl(path), 'utf8')),
  );
  return contents.join('\n');
}
