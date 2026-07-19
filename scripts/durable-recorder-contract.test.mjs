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
  implementation: 'native-foreground-audio',
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

const segmentResult = {
  schemaVersion: 1,
  segmentId: '22222222-2222-4222-8222-222222222222',
  sequence: 1,
  relativePath: 'segments/000001-22222222-2222-4222-8222-222222222222.m4a',
  createdAt: '2023-11-14T22:13:21.000Z',
  finalizedAt: '2023-11-14T22:13:22.000Z',
  durationMs: 1000,
  byteLength: 4096,
  container: 'm4a',
  codec: 'aac',
  sampleRate: 44100,
  channelCount: 1,
  integrityStatus: 'validated',
};

const readySession = { ...sessionResult, state: 'ready' };
const recordingSession = { ...sessionResult, state: 'recording' };
const pausedSession = { ...sessionResult, state: 'paused', segments: [segmentResult] };
const finalizedRecordingSession = {
  ...sessionResult,
  state: 'finalized',
  recoverable: false,
  finalized: true,
  segments: [segmentResult],
};

const statusResult = (runtimeState, session = undefined) => ({
  runtimeState,
  permission: 'granted',
  ...(session ? { recordingSessionId: session.recordingSessionId, session } : {}),
  completedSegments: session?.segments ?? [],
});

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
    getMicrophonePermissionStatus: async () => 'granted',
    prepareRecording: async () => statusResult('ready', readySession),
    startRecording: async () => statusResult('recording', recordingSession),
    pauseRecording: async () => statusResult('paused', pausedSession),
    resumeRecording: async () => statusResult('recording', recordingSession),
    stopRecording: async () => statusResult('idle', finalizedRecordingSession),
    getRecordingStatus: async () => statusResult('idle'),
    recoverRecordingSession: async () => ({ session: pausedSession, issues: [] }),
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
assert.equal(await linked.getMicrophonePermissionStatus(), 'granted');
assert.equal((await linked.prepareRecording({ recordingSessionId: sessionResult.recordingSessionId })).runtimeState, 'ready');
assert.equal((await linked.startRecording({ recordingSessionId: sessionResult.recordingSessionId })).runtimeState, 'recording');
assert.equal((await linked.pauseRecording({ recordingSessionId: sessionResult.recordingSessionId })).completedSegments.length, 1);
assert.equal((await linked.recoverRecordingSession({ recordingSessionId: sessionResult.recordingSessionId })).issues.length, 0);

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
    'DURABLE_RECORDER_RUNTIME_STATES',
    'DURABLE_RECORDING_STATES',
    'DurableRecorderError',
    'abandonSession',
    'createSession',
    'deleteSession',
    'finalizeSession',
    'getCapabilities',
    'getMicrophonePermissionStatus',
    'getRecordingStatus',
    'getSession',
    'listRecoverableSessions',
    'pauseRecording',
    'prepareRecording',
    'recoverRecordingSession',
    'resumeRecording',
    'startRecording',
    'stopRecording',
    'transitionSession',
  ],
  'Phase 2B preserves session APIs and adds only foreground recorder actions',
);

await assert.rejects(
  unavailable.createSession({ lectureId: 'lecture-unavailable' }),
  (error) => error instanceof unavailable.DurableRecorderError && error.code === 'ERR_DURABLE_RECORDER_UNAVAILABLE',
  'missing native module returns a deterministic typed error',
);

await assert.rejects(
  unavailable.getRecordingStatus(),
  (error) => error instanceof unavailable.DurableRecorderError && error.code === 'ERR_DURABLE_RECORDER_UNAVAILABLE',
  'missing native recorder does not fall back to a fake JavaScript recorder',
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

console.log('Durable recorder Phase 2B contract tests passed.');
