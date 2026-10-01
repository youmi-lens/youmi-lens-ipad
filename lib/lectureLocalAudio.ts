/**
 * Local Lecture audio persistence + playback resolution.
 *
 * Finish-path recordings often land in Caches/ExpoAudio (temporary). We copy
 * them into Documents/YoumiLens/Recordings so App restart / cache eviction does
 * not orphan the Lecture's localAudioUri. Cloud storage is never required for
 * on-device playback.
 */
import {
  classifyLectureAudioPlayback,
  shouldShowCloudAudioSoon,
  shouldShowAudioPlayer,
  shouldShowLocalAudioPlayer,
} from './lectureLocalAudio.mjs';
import { persistLegacyAudioSources } from '@/modules/expo-durable-recorder';

export {
  classifyLectureAudioPlayback,
  shouldShowCloudAudioSoon,
  shouldShowAudioPlayer,
  shouldShowLocalAudioPlayer,
};

/**
 * Valid local audio always wins. A canonical storagePath is the cloud fallback
 * when no readable local file remains on this device.
 */
export type LectureAudioPlaybackKind = 'local' | 'cloud' | 'local-missing' | 'unavailable';

export type LectureAudioPlaybackState = {
  kind: LectureAudioPlaybackKind;
  uri: string | null;
};

/** Subdirectory under the app document directory for durable lecture audio. */
export const LECTURE_RECORDINGS_SUBDIR = 'YoumiLens/Recordings';

function loadFileSystem(): typeof import('expo-file-system') | null {
  try {
    return require('expo-file-system') as typeof import('expo-file-system');
  } catch {
    return null;
  }
}

function basenameFromUri(uri: string): string {
  const cleaned = uri.split('?')[0] ?? uri;
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || 'recording.m4a';
}

function extensionForUri(uri: string): string {
  const base = basenameFromUri(uri);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '.m4a';
  return base.slice(dot);
}

/** Sync existence check for a file:// URI (or absolute path). */
export function localAudioFileExists(uri: string | null | undefined): boolean {
  if (!uri || !String(uri).trim()) return false;
  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.File) return false;
  try {
    return Boolean(new FileSystemNS.File(uri).exists);
  } catch {
    return false;
  }
}

function documentRecordingsDirUri(): string | null {
  const FileSystemNS = loadFileSystem();
  const doc = FileSystemNS?.Paths?.document;
  if (!doc?.uri) return null;
  return `${String(doc.uri).replace(/\/+$/, '')}/${LECTURE_RECORDINGS_SUBDIR}`;
}

function cacheExpoAudioDirUri(): string | null {
  const FileSystemNS = loadFileSystem();
  const cache = FileSystemNS?.Paths?.cache;
  if (!cache?.uri) return null;
  return `${String(cache.uri).replace(/\/+$/, '')}/ExpoAudio`;
}

/**
 * expo-file-system's Paths API exposes `document`/`cache` but no
 * Application Support constant. Legacy audio assembly and durable-recovery
 * exports both live under Application Support (see
 * modules/expo-durable-recorder), so a persisted `localAudioUri` pointing
 * there needs a way back to the CURRENT container too. Documents and
 * Application Support are always siblings under the same container root,
 * so this derives it from the (Expo-provided) document root rather than
 * hardcoding a container path.
 */
function applicationSupportDirUri(): string | null {
  const FileSystemNS = loadFileSystem();
  const docs = FileSystemNS?.Paths?.document?.uri;
  if (!docs) return null;
  const trimmed = String(docs).replace(/\/+$/, '');
  if (!trimmed.endsWith('/Documents')) return null;
  // Percent-encoded to match how native Swift persists this path
  // (URL.absoluteString always encodes the space) and to stay a
  // well-formed file:// URI for the native file APIs on the JS side.
  return `${trimmed.slice(0, -'/Documents'.length)}/Library/Application%20Support`;
}

function isAlreadyDurableUri(uri: string): boolean {
  return uri.includes(`/${LECTURE_RECORDINGS_SUBDIR}/`);
}

/** A durable recording must be under Documents and contain actual media bytes. */
export function isVerifiedDurableLectureAudio(uri: string | null | undefined): boolean {
  if (!uri || !isAlreadyDurableUri(uri)) return false;
  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.File) return false;
  try {
    const file = new FileSystemNS.File(uri);
    return Boolean(file.exists) && typeof file.size === 'number' && file.size > 0;
  } catch {
    return false;
  }
}

/**
 * Proves that a lecture-owned Documents M4A is a finalized, readable asset.
 * File size alone is explicitly insufficient: a paused AVAudioRecorder has
 * bytes but no M4A moov atom until it is stopped.  The native assembler uses
 * AVAudioFile inspection and copies only after this exact validation; this
 * call therefore validates the Documents target itself and adds an
 * independent, non-destructive native recovery copy.
 */
async function verifyFinalizedLectureAudio(uri: string, lectureId: string): Promise<boolean> {
  if (!isVerifiedDurableLectureAudio(uri)) return false;
  try {
    const result = await persistLegacyAudioSources(lectureId, [{ role: 'prior_canonical', uri }]);
    return result.sourceCount === 1 && result.sources[0]?.durationMs > 0 && result.sources[0]?.byteLength > 0;
  } catch {
    return false;
  }
}

/** A final native-durable asset may live outside Documents, but must have bytes. */
export function localAudioFileHasBytes(uri: string | null | undefined): boolean {
  const FileSystemNS = loadFileSystem();
  if (!uri || !FileSystemNS?.File) return false;
  try {
    const file = new FileSystemNS.File(uri);
    return Boolean(file.exists) && typeof file.size === 'number' && file.size > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure the recordings directory exists under Documents.
 */
function ensureRecordingsDirectory(): import('expo-file-system').Directory | null {
  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.Directory || !FileSystemNS?.Paths?.document) return null;
  try {
    const dir = new FileSystemNS.Directory(FileSystemNS.Paths.document, 'YoumiLens', 'Recordings');
    if (!dir.exists) {
      dir.create({ intermediates: true, idempotent: true });
    }
    return dir;
  } catch (err) {
    if (__DEV__) console.warn('[lectureLocalAudio] could not create recordings dir', err);
    return null;
  }
}

/**
 * Copy a temporary recording into Documents/YoumiLens/Recordings.
 *
 * Each promotion has a unique name: a replacement must never delete an older
 * durable candidate before the newer copy is proven readable. This is
 * deliberately additive so recovery can retain every owned source.
 */
export async function persistLectureLocalAudio(
  sourceUri: string | null | undefined,
  lectureId: string,
): Promise<string | null> {
  const src = typeof sourceUri === 'string' ? sourceUri.trim() : '';
  if (!src) return null;
  if (isVerifiedDurableLectureAudio(src)) {
    return (await verifyFinalizedLectureAudio(src, lectureId)) ? src : null;
  }

  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.File) return null;

  if (!localAudioFileExists(src)) {
    // Source already gone — try resolving an alternate path before giving up.
    const resolved = resolvePlayableLocalAudioUri(src, lectureId);
    return resolved && resolved !== src
      ? persistLectureLocalAudio(resolved, lectureId)
      : null;
  }

  const dir = ensureRecordingsDirectory();
  if (!dir) return null;

  const ext = extensionForUri(src);
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const targetName = `${lectureId}-${nonce}${ext.startsWith('.') ? ext : `.${ext}`}`;
  try {
    const target = new FileSystemNS.File(dir, targetName);
    const sourceFile = new FileSystemNS.File(src);
    sourceFile.copy(target);
    if (await verifyFinalizedLectureAudio(target.uri, lectureId)) {
      return target.uri;
    }
  } catch (err) {
    if (__DEV__) console.warn('[lectureLocalAudio] persist copy failed', err);
  }
  return null;
}

/**
 * Preserve a legacy recovered segment under a unique path. Unlike the
 * canonical-file helper above, this function never deletes or replaces an
 * existing file. It is used only when assembly is still required.
 */
export async function persistLectureResumeSegment(
  sourceUri: string | null | undefined,
  lectureId: string,
): Promise<string | null> {
  const src = typeof sourceUri === 'string' ? sourceUri.trim() : '';
  if (!src || !localAudioFileExists(src)) return null;
  const FileSystemNS = loadFileSystem();
  // The recorder's source URI is still unique and readable. Preserve its
  // reference rather than dropping it if the durable-copy API is unavailable;
  // Finish remains blocked either way, so this cannot become a partial upload.
  if (!FileSystemNS?.File || !FileSystemNS?.Directory || !FileSystemNS?.Paths?.document) return src;
  try {
    const segmentsDir = new FileSystemNS.Directory(
      FileSystemNS.Paths.document,
      'YoumiLens',
      'Recordings',
      lectureId,
      'segments',
    );
    if (!segmentsDir.exists) segmentsDir.create({ intermediates: true, idempotent: true });
    const extension = extensionForUri(src);
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const target = new FileSystemNS.File(segmentsDir, `resume-${nonce}${extension.startsWith('.') ? extension : `.${extension}`}`);
    if (target.exists) return null;
    new FileSystemNS.File(src).copy(target);
    return (await verifyFinalizedLectureAudio(target.uri, lectureId)) ? target.uri : null;
  } catch (err) {
    if (__DEV__) console.warn('[lectureLocalAudio] resume segment preservation failed', err);
    // Do not fall back to the source URI here. A cache file can be non-empty
    // yet still be an open/unfinalized M4A; returning it would recreate the
    // exact assembly-required retry loop this helper is meant to prevent.
    return null;
  }
}

/**
 * Resolve a stored localAudioUri to a currently readable file URI.
 * Rewrites stale sandbox container UUIDs and looks under durable + ExpoAudio dirs.
 */
export function resolvePlayableLocalAudioUri(
  uri: string | null | undefined,
  lectureId?: string | null,
): string | null {
  const raw = typeof uri === 'string' ? uri.trim() : '';
  if (!raw) return null;
  if (localAudioFileExists(raw)) return raw;

  const candidates: string[] = [];

  // An old absolute sandbox URI may identify the same exact owned asset in a
  // new container. Resolve that exact path first. Do not search Documents by
  // a generic recorder basename: two lectures can legitimately have the same
  // generated filename and adopting the other lecture's media is worse than a
  // recoverable missing-audio failure.
  const rewritten = rewriteSandboxUri(raw);
  if (rewritten && localAudioFileExists(rewritten)) return rewritten;

  const base = basenameFromUri(raw);

  const recordingsDir = documentRecordingsDirUri();
  if (recordingsDir) {
    if (lectureId) {
      const ext = extensionForUri(raw);
      candidates.push(`${recordingsDir}/${lectureId}${ext.startsWith('.') ? ext : `.${ext}`}`);
    }
  }

  const expoAudioDir = cacheExpoAudioDirUri();
  if (expoAudioDir) {
    candidates.push(`${expoAudioDir}/${base}`);
  }

  if (rewritten) candidates.push(rewritten);

  for (const candidate of candidates) {
    const normalized = candidate.startsWith('file://') ? candidate : `file://${candidate}`;
    if (localAudioFileExists(normalized)) return normalized;
    if (localAudioFileExists(candidate)) return candidate.startsWith('file://') ? candidate : `file://${candidate}`;
  }

  return null;
}

function rewriteSandboxUri(uri: string): string | null {
  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.Paths) return null;
  const path = uri.replace(/^file:\/\//, '');

  const cachesIdx = path.indexOf('/Library/Caches/');
  if (cachesIdx >= 0 && FileSystemNS.Paths.cache?.uri) {
    const after = path.slice(cachesIdx + '/Library/Caches/'.length);
    const root = String(FileSystemNS.Paths.cache.uri).replace(/\/+$/, '');
    return `${root.startsWith('file://') ? root : `file://${root}`}/${after}`;
  }

  // Application Support is where durably-composed assets live (legacy
  // audio assembly, durable-recovery exports — see
  // modules/expo-durable-recorder). Native Swift persists this as an
  // absolute URL.absoluteString, which percent-encodes the space in
  // "Application Support" as %20 — check both forms rather than assuming
  // one encoding. Checked before the generic /Documents/ case below since
  // it is the more specific prefix.
  const appSupportMarker = path.includes('/Library/Application%20Support/')
    ? '/Library/Application%20Support/'
    : path.includes('/Library/Application Support/')
      ? '/Library/Application Support/'
      : null;
  if (appSupportMarker) {
    const appSupportIdx = path.indexOf(appSupportMarker);
    const after = path.slice(appSupportIdx + appSupportMarker.length);
    const root = applicationSupportDirUri();
    if (root) {
      const normalizedRoot = root.startsWith('file://') ? root : `file://${root}`;
      return `${normalizedRoot}/${after}`;
    }
  }

  const docsIdx = path.indexOf('/Documents/');
  if (docsIdx >= 0 && FileSystemNS.Paths.document?.uri) {
    const after = path.slice(docsIdx + '/Documents/'.length);
    const root = String(FileSystemNS.Paths.document.uri).replace(/\/+$/, '');
    return `${root.startsWith('file://') ? root : `file://${root}`}/${after}`;
  }
  return null;
}

/**
 * Classify playback UI for a lecture using on-disk existence when a local URI is set.
 */
export function resolveLectureAudioPlaybackState(input: {
  localAudioUri?: string | null;
  storagePath?: string | null;
  lectureId?: string | null;
}): LectureAudioPlaybackState {
  const resolved = resolvePlayableLocalAudioUri(input.localAudioUri, input.lectureId);
  if (resolved) {
    return classifyLectureAudioPlayback({
      localAudioUri: resolved,
      storagePath: input.storagePath,
      fileExists: true,
    }) as LectureAudioPlaybackState;
  }

  const raw = typeof input.localAudioUri === 'string' ? input.localAudioUri.trim() : '';
  if (raw) {
    return classifyLectureAudioPlayback({
      localAudioUri: raw,
      storagePath: input.storagePath,
      fileExists: false,
    }) as LectureAudioPlaybackState;
  }

  return classifyLectureAudioPlayback({
    localAudioUri: null,
    storagePath: input.storagePath,
    fileExists: null,
  }) as LectureAudioPlaybackState;
}
