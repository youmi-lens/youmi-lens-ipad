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
  shouldShowLocalAudioPlayer,
} from './lectureLocalAudio.mjs';

export {
  classifyLectureAudioPlayback,
  shouldShowCloudAudioSoon,
  shouldShowLocalAudioPlayer,
};

export type LectureAudioPlaybackKind = 'local' | 'local-missing' | 'cloud-soon' | 'unavailable';

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

function isAlreadyDurableUri(uri: string): boolean {
  return uri.includes(`/${LECTURE_RECORDINGS_SUBDIR}/`);
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
 * Copy a temporary recording into Documents/YoumiLens/Recordings/{lectureId}.ext.
 * Returns the durable file URI, or the original URI if copy is unnecessary/impossible.
 */
export async function persistLectureLocalAudio(
  sourceUri: string | null | undefined,
  lectureId: string,
): Promise<string | null> {
  const src = typeof sourceUri === 'string' ? sourceUri.trim() : '';
  if (!src) return null;
  if (isAlreadyDurableUri(src) && localAudioFileExists(src)) {
    return src;
  }

  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.File) {
    return localAudioFileExists(src) ? src : null;
  }

  if (!localAudioFileExists(src)) {
    // Source already gone — try resolving an alternate path before giving up.
    const resolved = resolvePlayableLocalAudioUri(src, lectureId);
    return resolved;
  }

  const dir = ensureRecordingsDirectory();
  if (!dir) return src;

  const ext = extensionForUri(src);
  const targetName = `${lectureId}${ext.startsWith('.') ? ext : `.${ext}`}`;
  try {
    const target = new FileSystemNS.File(dir, targetName);
    if (target.exists) {
      try {
        target.delete();
      } catch {
        /* replace below */
      }
    }
    const sourceFile = new FileSystemNS.File(src);
    sourceFile.copy(target);
    if (target.exists) {
      return target.uri;
    }
  } catch (err) {
    if (__DEV__) console.warn('[lectureLocalAudio] persist copy failed', err);
  }
  return src;
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

  const base = basenameFromUri(raw);
  const candidates: string[] = [];

  const recordingsDir = documentRecordingsDirUri();
  if (recordingsDir) {
    candidates.push(`${recordingsDir}/${base}`);
    if (lectureId) {
      const ext = extensionForUri(raw);
      candidates.push(`${recordingsDir}/${lectureId}${ext.startsWith('.') ? ext : `.${ext}`}`);
    }
  }

  const expoAudioDir = cacheExpoAudioDirUri();
  if (expoAudioDir) {
    candidates.push(`${expoAudioDir}/${base}`);
  }

  // Rewrite absolute Simulator/device container path to the live cache/document roots.
  const rewritten = rewriteSandboxUri(raw);
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
