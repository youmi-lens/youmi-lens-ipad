import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import ts from 'typescript';

const sourceUrl = new URL('../modules/expo-durable-recorder/index.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');

function loadBoundary({ nativeModule, platform, optionalLoadError = null }) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: 'modules/expo-durable-recorder/index.ts',
  }).outputText;

  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier === 'expo-modules-core') {
      return {
        requireOptionalNativeModule(name) {
          assert.equal(name, 'ExpoDurableRecorder');
          if (optionalLoadError) throw optionalLoadError;
          return nativeModule;
        },
      };
    }
    if (specifier === 'react-native') return { Platform: { OS: platform } };
    throw new Error(`Unexpected test import: ${specifier}`);
  };

  vm.runInNewContext(compiled, { module, exports: module.exports, require, Promise });
  return module.exports;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const nativeResult = {
  moduleAvailable: true,
  contractVersion: 1,
  platform: 'ios',
  implementation: 'native-placeholder',
};

const linked = loadBoundary({
  nativeModule: { getCapabilities: async () => nativeResult },
  platform: 'ios',
});
assert.equal(linked.DURABLE_RECORDER_CONTRACT_VERSION, 1, 'contract version remains stable');
assert.deepEqual(plain(await linked.getCapabilities()), nativeResult, 'linked native result is mapped exactly');

const unavailable = loadBoundary({ nativeModule: null, platform: 'web' });
assert.deepEqual(plain(await unavailable.getCapabilities()), {
  moduleAvailable: false,
  contractVersion: 1,
  platform: 'web',
  implementation: 'unavailable',
});

const unsupported = loadBoundary({
  nativeModule: null,
  platform: undefined,
  optionalLoadError: new Error('native modules unavailable'),
});
assert.deepEqual(plain(await unsupported.getCapabilities()), {
  moduleAvailable: false,
  contractVersion: 1,
  platform: 'unknown',
  implementation: 'unavailable',
}, 'unsupported imports return an explicit fallback without crashing');

const malformed = loadBoundary({
  nativeModule: { getCapabilities: async () => ({ ...nativeResult, contractVersion: 2 }) },
});
assert.equal((await malformed.getCapabilities()).moduleAvailable, false, 'invalid native contracts cannot claim availability');

const publicExports = Object.keys(linked).sort();
assert.deepEqual(
  publicExports,
  ['DURABLE_RECORDER_CONTRACT_VERSION', 'getCapabilities'],
  'Phase 1 exposes no recording actions',
);

for (const forbidden of ['startRecording', 'pauseRecording', 'resumeRecording', 'stopRecording']) {
  assert.equal(forbidden in linked, false, `${forbidden} is not public`);
}

console.log('Durable recorder Phase 1 contract tests passed.');
