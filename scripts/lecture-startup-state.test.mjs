import assert from 'node:assert/strict';

import { resolveCaptionAreaState, recordingControlsEnabled } from '../lib/lectureStartupState.mjs';

const base = {
  audioActive: false,
  startFailed: false,
  micStreamError: false,
  hasCaptionContent: false,
  captionsConnecting: false,
};

// B/C. Audio start FAILED → one coherent failed-start state, never "audio active".
assert.equal(resolveCaptionAreaState({ ...base, startFailed: true }), 'failed_start');
assert.equal(
  resolveCaptionAreaState({ ...base, startFailed: true, micStreamError: true }),
  'failed_start',
  'failed start wins even if a stale caption error is present',
);

// A/D. Audio active but captions failed → captions_unavailable (the only place
// the "audio recording is still active" copy is reachable).
assert.equal(resolveCaptionAreaState({ ...base, audioActive: true, micStreamError: true }), 'captions_unavailable');
assert.equal(resolveCaptionAreaState({ ...base, audioActive: true }), 'captions_unavailable');

// Happy paths.
assert.equal(resolveCaptionAreaState({ ...base, audioActive: true, hasCaptionContent: true }), 'captions_visible');
assert.equal(resolveCaptionAreaState({ ...base, audioActive: true, captionsConnecting: true }), 'captions_connecting');

// Startup window: permission granted, audio still starting, no failure yet →
// "preparing", NOT the contradictory "unavailable" message.
assert.equal(resolveCaptionAreaState({ ...base }), 'preparing');

// Controls only usable with a live recording.
assert.equal(recordingControlsEnabled(true), true);
assert.equal(recordingControlsEnabled(false), false);

console.log('Lecture startup-state tests passed.');
