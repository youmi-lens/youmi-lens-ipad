/**
 * Durable local storage for PK3-B's PencilKit Notebook ink — one raw
 * `PKDrawing.dataRepresentation()` file per lecture, entirely separate from
 * the `lectures` AsyncStorage array (see the PK3-B report's Step 1 audit:
 * every `lectures` state change rewrites the WHOLE array to a single
 * AsyncStorage key, so embedding a multi-hundred-KB-to-multi-MB base64
 * drawing inside a Lecture's own JSON would inflate every unrelated write to
 * every other lecture too — measured evidence, not a guess, ruled this out).
 *
 * Mirrors `notebookImageStorage.ts`'s directory pattern exactly (same
 * `expo-file-system` `File`/`Directory` API, same `Paths.document` root) so
 * this is a well-established shape in this codebase, not a new one. Actual
 * byte read/write happens entirely native-side (PencilKitTestModule.swift) —
 * this module only computes/ensures the `file://` path; it never touches
 * the drawing's bytes.
 */

/** Subdirectory under the app document directory for durable PencilKit ink. */
export const NOTEBOOK_INK_SUBDIR = 'YoumiLens/NotebookInk';

function loadFileSystem(): typeof import('expo-file-system') | null {
  try {
    return require('expo-file-system') as typeof import('expo-file-system');
  } catch {
    return null;
  }
}

function ensureNotebookInkDirectory(): import('expo-file-system').Directory | null {
  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.Directory || !FileSystemNS?.Paths?.document) return null;
  try {
    const dir = new FileSystemNS.Directory(FileSystemNS.Paths.document, 'YoumiLens', 'NotebookInk');
    if (!dir.exists) {
      dir.create({ intermediates: true, idempotent: true });
    }
    return dir;
  } catch (err) {
    if (__DEV__) console.warn('[notebookInkStorage] could not create ink dir', err);
    return null;
  }
}

/**
 * The durable `file://` URI for a lecture's PencilKit drawing — keyed by the
 * lecture's own stable `id` (never its title; see PK3-B Step 12), so
 * renaming a lecture or two lectures sharing a title never cross-attaches
 * ink. Returns null only when expo-file-system is unavailable (non-iOS,
 * Expo Go, or a build without it) — callers must treat that exactly like
 * "no PencilKit ink for this lecture" and skip save/load, never throw.
 */
export function notebookInkFileUri(lectureId: string): string | null {
  const dir = ensureNotebookInkDirectory();
  if (!dir) return null;
  const FileSystemNS = loadFileSystem();
  if (!FileSystemNS?.File) return null;
  try {
    return new FileSystemNS.File(dir, `${lectureId}.pkdrawing`).uri;
  } catch (err) {
    if (__DEV__) console.warn('[notebookInkStorage] could not compute ink file uri', err);
    return null;
  }
}
