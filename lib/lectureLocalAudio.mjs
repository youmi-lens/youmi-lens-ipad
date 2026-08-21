/**
 * Pure helpers for Lecture local vs cloud audio playback gating.
 * Native file I/O lives in lectureLocalAudio.ts; this module stays Node-testable.
 */

/**
 * @typedef {'local' | 'cloud' | 'local-missing' | 'unavailable'} LectureAudioPlaybackKind
 *
 * `storagePath` is the authoritative signal that the canonical recording has
 * an audio object. A usable local file remains first choice; cloud is used only
 * when that file is absent or stale on this device.
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

  if (uri) {
    if (input?.fileExists === false) {
      return hasStoragePath(input?.storagePath)
        ? { kind: 'cloud', uri: null }
        : { kind: 'local-missing', uri };
    }
    // fileExists true or unknown: prefer local playback when a URI is recorded.
    return { kind: 'local', uri };
  }

  if (hasStoragePath(input?.storagePath)) {
    return { kind: 'cloud', uri: null };
  }

  return { kind: 'unavailable', uri: null };
}

function hasStoragePath(storagePath) {
  return typeof storagePath === 'string' && storagePath.trim().length > 0;
}

/**
 * True when the UI should mount the local compact player (not cloud/empty placeholders).
 * @param {{ kind: LectureAudioPlaybackKind }} state
 */
export function shouldShowLocalAudioPlayer(state) {
  return state?.kind === 'local';
}

/**
 * Retained so existing callers keep compiling, but this product has no cloud
 * playback state: it is now always false. Do not reintroduce a cloud branch
 * here without an approved cloud-playback feature.
 * @param {{ kind: LectureAudioPlaybackKind }} _state
 */
export function shouldShowCloudAudioSoon(_state) {
  return false;
}

/** A cloud URL is resolved separately, but it uses the same player once ready. */
export function shouldShowAudioPlayer(state) {
  return state?.kind === 'local' || state?.kind === 'cloud';
}
