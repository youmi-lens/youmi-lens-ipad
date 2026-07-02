/**
 * Pure decision for what the lecture-recording "caption stage" should show,
 * derived from reliable booleans instead of nested render ternaries.
 *
 * The startup bug this fixes: the recording screen entered the full recording
 * experience on microphone permission ALONE. So a FAILED audio start still
 * rendered "Live captions unavailable. Audio recording is still active." (audio
 * was NOT active) right next to "Could not start the recording. Please try
 * again." — two contradictory messages, plus active Pause/Mark controls.
 *
 * This resolver makes the states mutually exclusive:
 *   - audio never started      -> 'failed_start' (retry START, not captions)
 *   - audio active/starting    -> caption states; the "still active" copy is
 *                                 only reachable when audio actually is active.
 *
 * @typedef {'failed_start'|'preparing'|'captions_visible'|'captions_connecting'|'captions_unavailable'} CaptionAreaState
 *
 * @param {{
 *   audioActive: boolean,
 *   startFailed: boolean,
 *   micStreamError: boolean,
 *   hasCaptionContent: boolean,
 *   captionsConnecting: boolean,
 * }} input
 * @returns {CaptionAreaState}
 */
export function resolveCaptionAreaState(input) {
  const { audioActive, startFailed, micStreamError, hasCaptionContent, captionsConnecting } = input
  // Audio never started (and isn't running): a single failed-start state.
  // Never claim audio is active; never offer "retry captions".
  if (!audioActive && startFailed) return 'failed_start'
  // Captions failed while audio is (or was) streaming.
  if (micStreamError) return 'captions_unavailable'
  if (hasCaptionContent) return 'captions_visible'
  if (captionsConnecting) return 'captions_connecting'
  // Audio is active but captions have produced nothing yet.
  if (audioActive) return 'captions_unavailable'
  // Permission granted, audio still spinning up, no failure yet.
  return 'preparing'
}

/** Whether Pause / Mark Important should be usable (only with a live recording). */
export function recordingControlsEnabled(audioActive) {
  return audioActive === true
}
