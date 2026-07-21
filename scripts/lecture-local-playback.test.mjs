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
  shouldShowLocalAudioPlayer,
} from '../lib/lectureLocalAudio.mjs';

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
  assert.equal(shouldShowCloudAudioSoon(local), false);
}

{
  const missing = classifyLectureAudioPlayback({
    localAudioUri: 'file:///tmp/missing.m4a',
    storagePath: 'user/rec.m4a',
    fileExists: false,
  });
  assert.equal(missing.kind, 'local-missing');
  assert.equal(shouldShowLocalAudioPlayer(missing), false);
  assert.equal(shouldShowCloudAudioSoon(missing), false);
}

{
  const cloud = classifyLectureAudioPlayback({
    localAudioUri: null,
    storagePath: 'user/rec.m4a',
    fileExists: null,
  });
  assert.equal(cloud.kind, 'cloud-soon');
  assert.equal(shouldShowCloudAudioSoon(cloud), true);
  assert.equal(shouldShowLocalAudioPlayer(cloud), false);
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

// --- Wiring: detail screen ---
const lecture = read('app/lecture/[id].tsx');
assert.match(lecture, /resolveLectureAudioPlaybackState/);
assert.match(lecture, /shouldShowLocalAudioPlayer/);
assert.match(lecture, /lecture\.audioLocalMissing/);
assert.match(lecture, /lecture\.audioCloudSoon/);
assert.match(lecture, /lecture\.audioUnavailable/);
assert.match(lecture, /isLectureSessionActive/);
assert.match(lecture, /lecture\.playbackBlockedRecording/);
assert.match(lecture, /setAudioModeAsync\(\s*\{\s*playsInSilentMode:\s*true,\s*allowsRecording:\s*false\s*\}\s*\)/);
assert.match(lecture, /player\.play\(\)/);
assert.match(lecture, /player\.pause\(\)/);
// Must not gate the player solely on storagePath / cloud soon when local exists.
assert.equal(
  /storagePath\s*\?\s*t\('lecture\.audioCloudSoon'\)/.test(lecture),
  false,
  'cloud soon must not be chosen by storagePath alone',
);
assert.match(lecture, /audioPlayback\.kind === 'cloud-soon'/);
assert.match(lecture, /audioPlayback\.kind === 'local-missing'/);

// --- Wiring: finish persists durable local audio ---
const recording = read('app/recording.tsx');
assert.match(recording, /persistLectureLocalAudio/);
assert.match(recording, /CONFIGURED_RECORDING_ENGINE|recordingEngine/);

const persist = read('lib/lectureLocalAudio.ts');
assert.match(persist, /YoumiLens\/Recordings/);
assert.match(persist, /persistLectureLocalAudio/);
assert.match(persist, /resolvePlayableLocalAudioUri/);
assert.match(persist, /resolveLectureAudioPlaybackState/);

const notes = read('lib/recordingNotes.tsx');
assert.match(notes, /isLectureSessionActive/);

const gate = read('lib/recording/featureGate.ts');
assert.match(gate, /CONFIGURED_RECORDING_ENGINE:\s*RecordingEngine\s*=\s*'legacy'/);

// Locale keys present in English (completeness suite covers other langs).
const en = read('lib/locales/en.mjs');
assert.match(en, /lecture\.audioLocalMissing/);
assert.match(en, /lecture\.playbackBlockedRecording/);

console.log('lecture local playback gates passed.');
