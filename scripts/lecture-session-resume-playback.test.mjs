/**
 * Structural gates: Mini/Course Resume must call the authoritative recorder
 * toggle; Lecture playback must configure audible audio mode before play.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const notes = read('lib/recordingNotes.tsx');
assert.match(notes, /registerLectureSessionPauseToggle/);
assert.match(notes, /toggleLectureSessionPause/);

const recording = read('app/recording.tsx');
assert.match(recording, /registerLectureSessionPauseToggle\(\(\)\s*=>\s*togglePause\(\)\)/);
assert.match(
  recording,
  /await resumeRecording\(\);\s*(?:\/\/[^\n]*\n\s*)*if\s*\(\s*!isGuest\s*\)\s*await startCaptionPipeline\(\s*\{\s*preserveHistory:\s*true\s*\}\s*\)/,
);
assert.match(recording, /persistLectureLocalAudio/);

const mini = read('app/mini-caption.tsx');
assert.match(mini, /toggleLectureSessionPause/);
assert.equal(/if\s*\(\s*isLectureSessionPaused\s*\)\s*return/.test(mini), false);
assert.equal(/setPaused\(\(p\)\s*=>\s*!p\)/.test(mini), false);

const floating = read('components/FloatingMiniCaption.tsx');
assert.match(floating, /toggleLectureSessionPause/);
assert.equal(/if\s*\(\s*isLectureSessionPaused\s*\)\s*return/.test(floating), false);
assert.equal(/setPaused\(\(p\)\s*=>\s*!p\)/.test(floating), false);

const lecture = read('app/lecture/[id].tsx');
assert.match(lecture, /setAudioModeAsync\(\s*\{\s*playsInSilentMode:\s*true,\s*allowsRecording:\s*false\s*\}\s*\)/);
assert.match(lecture, /togglePlayback/);
assert.match(lecture, /player\.play\(\)/);
assert.match(lecture, /resolveLectureAudioPlaybackState/);
assert.match(lecture, /shouldShowAudioPlayer/);

const legacy = read('lib/recording/useLegacyLectureRecorder.ts');
assert.match(
  legacy,
  /setAudioModeAsync\(\s*\{\s*playsInSilentMode:\s*true,\s*allowsRecording:\s*false,\s*shouldPlayInBackground:\s*false,\s*allowsBackgroundRecording:\s*false,?\s*\}\s*\)/,
);

const gate = read('lib/recording/featureGate.ts');
assert.match(gate, /CONFIGURED_RECORDING_ENGINE:\s*RecordingEngine\s*=\s*'legacy'/);

console.log('lecture session resume + playback audio-mode gates passed.');
