/**
 * Durable local storage for Notes/Notebook inserted images.
 *
 * expo-image-picker's returned asset URI is transient: on iOS it points into
 * a picker-owned temporary/cache location (or a Photos `ph://` reference)
 * that is not guaranteed to survive app relaunch or cache eviction. Storing
 * that URI directly as the canonical NoteImage.uri (the previous behavior)
 * meant an inserted image could silently fail to render later even though
 * its position/size metadata was persisted correctly — the classic
 * "metadata says success, asset is gone" split-brain.
 *
 * This copies the picker's asset into a Youmi Lens-owned durable directory
 * immediately after insertion, keyed by the image's own already-unique id
 * (see makeImageId in NotebookCanvas.tsx) — collision-safe without needing
 * to thread a lecture/notebook identity through NotebookCanvas's props.
 */

/** Subdirectory under the app document directory for durable notebook images. */
export const NOTEBOOK_IMAGES_SUBDIR = 'YoumiLens/NoteImages';

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
  return parts[parts.length - 1] || 'image.jpg';
}

function extensionForUri(uri: string): string {
  const base = basenameFromUri(uri);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '.jpg';
  return base.slice(dot);
}

function ensureNotebookImagesDirectory(): import('expo-file-system').Directory | null {
  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.Directory || !FileSystemNS?.Paths?.document) return null;
  try {
    const dir = new FileSystemNS.Directory(FileSystemNS.Paths.document, 'YoumiLens', 'NoteImages');
    if (!dir.exists) {
      dir.create({ intermediates: true, idempotent: true });
    }
    return dir;
  } catch (err) {
    if (__DEV__) console.warn('[notebookImageStorage] could not create images dir', err);
    return null;
  }
}

/** Sync existence check for a file:// URI (or absolute path). */
export function notebookImageFileExists(uri: string | null | undefined): boolean {
  if (!uri || !String(uri).trim()) return false;
  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.File) return false;
  try {
    return Boolean(new FileSystemNS.File(uri).exists);
  } catch {
    return false;
  }
}

/**
 * Copy a freshly-picked image into Documents/YoumiLens/NoteImages/{imageId}.ext.
 *
 * Never touches the source photo (copy, not move). Returns the durable file
 * URI on success. On any failure (no FileSystem module, directory creation
 * failed, copy failed) returns null so the caller can decide how to proceed
 * — it must NOT silently substitute the original transient URI, since that
 * would recreate exactly the bug this exists to fix.
 */
export async function persistNotebookImage(
  sourceUri: string | null | undefined,
  imageId: string,
): Promise<string | null> {
  const src = typeof sourceUri === 'string' ? sourceUri.trim() : '';
  if (!src) return null;

  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.File) return null;

  const dir = ensureNotebookImagesDirectory();
  if (!dir) return null;

  const ext = extensionForUri(src);
  const targetName = `${imageId}${ext.startsWith('.') ? ext : `.${ext}`}`;
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
    return null;
  } catch (err) {
    if (__DEV__) console.warn('[notebookImageStorage] persist copy failed', err);
    return null;
  }
}
