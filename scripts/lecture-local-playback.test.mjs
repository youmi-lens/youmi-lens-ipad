/**
 * Lecture local playback gating + wiring gates.
 * Ensures cloud coming-soon never masks a valid local audio URI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyLectureAudioPlayback,
  shouldShowCloudAudioSoon,
  shouldShowAudioPlayer,
  shouldShowLocalAudioPlayer,
} from '../lib/lectureLocalAudio.mjs';
import {
  cloudLectureAudioEndpoint,
  requestCloudLectureAudio,
} from '../lib/cloudLectureAudio.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// --- Pure classification ---
{
  const local = classifyLectureAudioPlayback({
    localAudioUri: 'file:///tmp/a.m4a',
    storagePath: 'user/rec.m4a',
    fileExists: true,
  });
  assert.equal(local.kind, 'local');
  assert.equal(shouldShowLocalAudioPlayer(local), true);
  assert.equal(shouldShowAudioPlayer(local), true);
  assert.equal(shouldShowCloudAudioSoon(local), false);
}

{
  const missing = classifyLectureAudioPlayback({
    localAudioUri: 'file:///tmp/missing.m4a',
    storagePath: null,
    fileExists: false,
  });
  assert.equal(missing.kind, 'local-missing');
  assert.equal(shouldShowLocalAudioPlayer(missing), false);
  assert.equal(shouldShowAudioPlayer(missing), false);
  assert.equal(shouldShowCloudAudioSoon(missing), false);
}

{
  // Cloud-only canonical recordings must be playable through the owner-scoped
  // signed-URL endpoint, never a coming-soon placeholder.
  const cloudOnly = classifyLectureAudioPlayback({
    localAudioUri: null,
    storagePath: 'user/rec.m4a',
    fileExists: null,
  });
  assert.equal(cloudOnly.kind, 'cloud');
  assert.equal(shouldShowCloudAudioSoon(cloudOnly), false);
  assert.equal(shouldShowAudioPlayer(cloudOnly), true);
}

{
  // A stale URI must not block cloud fallback.
  const staleLocalWithCloud = classifyLectureAudioPlayback({
    localAudioUri: 'file:///gone.m4a',
    storagePath: 'owner/recording.m4a',
    fileExists: false,
  });
  assert.equal(staleLocalWithCloud.kind, 'cloud');
}

{
  // storagePath must never suppress a usable local file.
  const both = classifyLectureAudioPlayback({
    localAudioUri: 'file:///doc/YoumiLens/Recordings/lecture_x.m4a',
    storagePath: 'user/rec.m4a',
    fileExists: true,
  });
  assert.equal(both.kind, 'local');
  assert.equal(shouldShowLocalAudioPlayer(both), true);
  assert.equal(shouldShowAudioPlayer(both), true);
  assert.equal(shouldShowCloudAudioSoon(both), false);
}

{
  const none = classifyLectureAudioPlayback({
    localAudioUri: '',
    storagePath: null,
    fileExists: null,
  });
  assert.equal(none.kind, 'unavailable');
}

{
  // Empty cloud fields must not invent a player; local URI alone is enough.
  const localOnly = classifyLectureAudioPlayback({
    localAudioUri: 'file:///doc/YoumiLens/Recordings/lecture_x.m4a',
    storagePath: null,
    fileExists: true,
  });
  assert.equal(localOnly.kind, 'local');
}

// --- Authenticated cloud request contract ---
{
  assert.equal(
    cloudLectureAudioEndpoint('https://api.example.test/', 'lecture_123'),
    'https://api.example.test/api/lectures/lecture_123/audio',
  );
  let request;
  const resolved = await requestCloudLectureAudio({
    apiBaseUrl: 'https://api.example.test',
    recordingId: 'recording-123',
    accessToken: 'owner-token',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, json: async () => ({ signedUrl: 'https://storage.example.test/audio?signature=temporary', expiresInSec: 900 }) };
    },
  });
  assert.equal(request.url, 'https://api.example.test/api/lectures/recording-123/audio');
  assert.equal(request.init.headers.Authorization, 'Bearer owner-token');
  assert.equal(resolved.signedUrl, 'https://storage.example.test/audio?signature=temporary');
  await assert.rejects(
    () => requestCloudLectureAudio({ apiBaseUrl: 'https://api.example.test', recordingId: 'r', accessToken: null, fetchImpl: async () => null }),
    /sign in/i,
  );
  await assert.rejects(
    () => requestCloudLectureAudio({
      apiBaseUrl: 'https://api.example.test', recordingId: 'r', accessToken: 'owner-token',
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    }),
    /HTTP 404/,
  );
}

// --- Wiring: detail screen ---
const lecture = read('app/lecture/[id].tsx');
assert.match(lecture, /resolveLectureAudioPlaybackState/);
assert.match(lecture, /requestCloudLectureAudio/);
assert.match(lecture, /shouldShowAudioPlayer/);
assert.match(lecture, /audioCloudLoading/);
assert.match(lecture, /audioCloudFailed/);
assert.match(lecture, /audioRetry/);
assert.match(lecture, /cloudRetry/);
assert.match(lecture, /lecture\.audioLocalMissing/);
assert.match(lecture, /lecture\.audioUnavailable/);
// The obsolete cloud placeholder must not be reachable from the detail screen.
assert.equal(
  /audioCloudSoon/.test(lecture),
  false,
  'unapproved cloud-playback placeholder must not be rendered',
);
assert.match(lecture, /isLectureSessionActive/);
assert.match(lecture, /lecture\.playbackBlockedRecording/);
assert.match(lecture, /setAudioModeAsync\(\s*\{\s*playsInSilentMode:\s*true,\s*allowsRecording:\s*false\s*\}\s*\)/);
assert.match(lecture, /player\.play\(\)/);
assert.match(lecture, /player\.pause\(\)/);
// Local playback must not request cloud audio simply because a remote copy exists.
assert.equal(
  /storagePath\s*\?\s*t\('lecture\.audioCloudSoon'\)/.test(lecture),
  false,
  'cloud soon must not be chosen by storagePath alone',
);
assert.match(lecture, /audioPlayback\.kind === 'local-missing'/);
assert.match(lecture, /audioPlayback\.kind === 'local'/);
assert.match(lecture, /remoteRecordingId/);

// --- Wiring: finish persists durable local audio ---
const recording = read('app/recording.tsx');
assert.match(recording, /persistLectureLocalAudio/);
assert.match(recording, /CONFIGURED_RECORDING_ENGINE|recordingEngine/);

const persist = read('lib/lectureLocalAudio.ts');
assert.match(persist, /YoumiLens\/Recordings/);
assert.match(persist, /persistLectureLocalAudio/);
assert.match(persist, /resolvePlayableLocalAudioUri/);
assert.match(persist, /resolveLectureAudioPlaybackState/);
assert.match(persist, /'cloud'/);

const notes = read('lib/recordingNotes.tsx');
assert.match(notes, /isLectureSessionActive/);

const gate = read('lib/recording/featureGate.ts');
assert.match(gate, /CONFIGURED_RECORDING_ENGINE:\s*RecordingEngine\s*=\s*'legacy'/);

// Locale keys present in English (completeness suite covers other langs).
const en = read('lib/locales/en.mjs');
assert.match(en, /lecture\.audioLocalMissing/);
assert.match(en, /lecture\.audioCloudLoading/);
assert.match(en, /lecture\.playbackBlockedRecording/);

console.log('lecture local playback gates passed.');
