/**
 * Pure helpers for Lecture local vs cloud audio playback gating.
 * Native file I/O lives in lectureLocalAudio.ts; this module stays Node-testable.
 */

/**
 * @typedef {'local' | 'local-missing' | 'cloud-soon' | 'unavailable'} LectureAudioPlaybackKind
 */

/**
 * @param {{
 *   localAudioUri?: string | null,
 *   storagePath?: string | null,
 *   fileExists?: boolean | null,
 * }} input
 * @returns {{ kind: LectureAudioPlaybackKind, uri: string | null }}
 */
export function classifyLectureAudioPlayback(input) {
  const raw = typeof input?.localAudioUri === 'string' ? input.localAudioUri.trim() : '';
  const uri = raw.length > 0 ? raw : null;
  const storagePath =
    typeof input?.storagePath === 'string' && input.storagePath.trim().length > 0
      ? input.storagePath.trim()
      : null;

  if (uri) {
    if (input?.fileExists === false) {
      return { kind: 'local-missing', uri };
    }
    // fileExists true or unknown: prefer local playback when a URI is recorded.
    return { kind: 'local', uri };
  }

  if (storagePath) {
    return { kind: 'cloud-soon', uri: null };
  }

  return { kind: 'unavailable', uri: null };
}

/**
 * True when the UI should mount the local compact player (not cloud/empty placeholders).
 * @param {{ kind: LectureAudioPlaybackKind }} state
 */
export function shouldShowLocalAudioPlayer(state) {
  return state?.kind === 'local';
}

/**
 * Cloud coming-soon must never win when a local URI is present.
 * @param {{ kind: LectureAudioPlaybackKind }} state
 */
export function shouldShowCloudAudioSoon(state) {
  return state?.kind === 'cloud-soon';
}
