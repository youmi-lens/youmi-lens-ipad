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

// --- Stale-container playback resolution: Application Support case ---------
// Root cause (Build 50 P0): legacy audio assembly / durable-recovery final
// assets live under Application Support (modules/expo-durable-recorder),
// but rewriteSandboxUri only rewrote /Library/Caches/ and /Documents/ — a
// stale container UUID in a persisted localAudioUri pointing at
// Application Support could never be resolved back to the current
// container, even though the file was verifiably still on disk. This
// surfaced physically as "Audio could not be loaded" on a lecture whose
// audio had just been durably composed and correctly persisted.
{
  const fn = persist.slice(persist.indexOf('function rewriteSandboxUri('), persist.indexOf('function rewriteSandboxUri(') + 2000);

  assert.match(fn, /applicationSupportDirUri\(\)/, 'rewriteSandboxUri has an Application Support case');
  // Native Swift persists this as URL.absoluteString, which always
  // percent-encodes the space — the resolver must not assume one encoding.
  assert.match(fn, /Application%20Support/, 'checks the percent-encoded form (how it is actually persisted)');
  assert.match(fn, /Application Support/, 'also checks the literal-space form, defensively');

  // Application Support must be checked before the generic /Documents/
  // case — not because of a substring collision today, but so a future
  // path shape cannot silently fall through to the wrong branch.
  const appSupportIdx = fn.indexOf('appSupportMarker');
  const docsIdx = fn.indexOf("path.indexOf('/Documents/')");
  assert.ok(appSupportIdx >= 0 && docsIdx > appSupportIdx, 'Application Support is checked before the generic Documents case');
}

{
  const fn = persist.slice(
    persist.indexOf('function applicationSupportDirUri('),
    persist.indexOf('function rewriteSandboxUri('),
  );
  assert.match(fn, /FileSystemNS\?\.Paths\?\.document\?\.uri/, 'derived from the document root, never a hardcoded container path');
  assert.doesNotMatch(fn, /var\/mobile\/Containers|[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i, 'no hardcoded container UUID');
  assert.match(fn, /Library\/Application%20Support/, 'produces the percent-encoded form so it stays a well-formed file:// URI');
}

{
  // Behavioral parity: the same algorithm, re-derived here (expo-file-system
  // is RN-only and cannot load under plain Node — see every other
  // native-facing test this session), fed the ACTUAL stale URI captured
  // from the device during the physical failure, against a DIFFERENT
  // (current) mocked container UUID. Proves the rewrite actually resolves
  // to the current container, not just that the code text exists.
  function applicationSupportDirUri(documentUri) {
    const trimmed = documentUri.replace(/\/+$/, '');
    if (!trimmed.endsWith('/Documents')) return null;
    return `${trimmed.slice(0, -'/Documents'.length)}/Library/Application%20Support`;
  }
  function rewriteSandboxUri(uri, documentUri) {
    const path = uri.replace(/^file:\/\//, '');
    const marker = path.includes('/Library/Application%20Support/')
      ? '/Library/Application%20Support/'
      : path.includes('/Library/Application Support/')
        ? '/Library/Application Support/'
        : null;
    if (!marker) return null;
    const after = path.slice(path.indexOf(marker) + marker.length);
    const root = applicationSupportDirUri(documentUri);
    if (!root) return null;
    const normalizedRoot = root.startsWith('file://') ? root : `file://${root}`;
    return `${normalizedRoot}/${after}`;
  }

  // The real, device-captured stale URI (container 459309EC — the one
  // active when this lecture's audio was assembled) vs the CURRENT
  // container (a different UUID after a subsequent reinstall).
  const staleUri = 'file:///var/mobile/Containers/Data/Application/459309EC-B173-4E1A-91AE-B85251B4494E/Library/Application%20Support/YoumiLens/AudioAssembly/lecture_mtotna2taficn/final/lecture.m4a';
  const currentDocumentUri = 'file:///var/mobile/Containers/Data/Application/FCA9B459-0707-4D74-B6F7-8B11A5B17F35/Documents';
  const resolved = rewriteSandboxUri(staleUri, currentDocumentUri);
  assert.equal(
    resolved,
    'file:///var/mobile/Containers/Data/Application/FCA9B459-0707-4D74-B6F7-8B11A5B17F35/Library/Application%20Support/YoumiLens/AudioAssembly/lecture_mtotna2taficn/final/lecture.m4a',
    'rewrites the stale container UUID to the CURRENT one while preserving the exact relative path',
  );
  assert.doesNotMatch(resolved, /459309EC/, 'the stale UUID must not survive the rewrite');
}

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
