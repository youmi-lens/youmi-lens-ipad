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

const sessionResult = {
  schemaVersion: 1,
  recordingSessionId: '11111111-1111-4111-8111-111111111111',
  lectureId: 'lecture-contract',
  state: 'created',
  createdAt: '2023-11-14T22:13:20.000Z',
  updatedAt: '2023-11-14T22:13:20.000Z',
  relativeSessionPath: 'sessions/11111111-1111-4111-8111-111111111111',
  recoverable: true,
  finalized: false,
  segments: [],
};

const linked = loadBoundary({
  nativeModule: {
    getCapabilities: async () => nativeResult,
    createSession: async () => sessionResult,
    getSession: async () => sessionResult,
    listRecoverableSessions: async () => [sessionResult],
    transitionSession: async () => ({ ...sessionResult, state: 'preparing' }),
    finalizeSession: async () => ({ ...sessionResult, state: 'finalized', recoverable: false, finalized: true }),
    abandonSession: async () => ({ ...sessionResult, state: 'abandoned', recoverable: false }),
    deleteSession: async () => true,
  },
  platform: 'ios',
});
assert.equal(linked.DURABLE_RECORDER_CONTRACT_VERSION, 1, 'contract version remains stable');
assert.deepEqual(plain(await linked.getCapabilities()), nativeResult, 'linked native result is mapped exactly');
assert.deepEqual(plain(linked.DURABLE_RECORDING_STATES), [
  'created',
  'preparing',
  'ready',
  'recording',
  'paused',
  'finalizing',
  'finalized',
  'failed',
  'abandoned',
]);
assert.deepEqual(plain(await linked.createSession({ lectureId: ' lecture-contract ' })), sessionResult);
assert.deepEqual(plain(await linked.listRecoverableSessions()), [sessionResult]);
assert.equal(await linked.deleteSession(sessionResult.recordingSessionId), true);

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
  [
    'DURABLE_RECORDER_CONTRACT_VERSION',
    'DURABLE_RECORDING_STATES',
    'DurableRecorderError',
    'abandonSession',
    'createSession',
    'deleteSession',
    'finalizeSession',
    'getCapabilities',
    'getSession',
    'listRecoverableSessions',
    'transitionSession',
  ],
  'Phase 2A exposes only capability and session-foundation actions',
);

for (const forbidden of ['startRecording', 'pauseRecording', 'resumeRecording', 'stopRecording']) {
  assert.equal(forbidden in linked, false, `${forbidden} is not public`);
}

await assert.rejects(
  unavailable.createSession({ lectureId: 'lecture-unavailable' }),
  (error) => error instanceof unavailable.DurableRecorderError && error.code === 'ERR_DURABLE_RECORDER_UNAVAILABLE',
  'missing native module returns a deterministic typed error',
);

const invalidNativeResult = loadBoundary({
  nativeModule: {
    getCapabilities: async () => nativeResult,
    createSession: async () => ({ ...sessionResult, relativeSessionPath: '/private/unrestricted' }),
  },
  platform: 'ios',
});
await assert.rejects(
  invalidNativeResult.createSession({ lectureId: 'lecture-invalid-result' }),
  (error) => error.code === 'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
  'absolute native paths are rejected by the TypeScript boundary',
);

console.log('Durable recorder Phase 2A contract tests passed.');
