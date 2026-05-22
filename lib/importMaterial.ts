/**
 * Course Materials import pipeline (Build 7 V1.1).
 *
 * Picks a PDF via UIDocumentPicker (expo-document-picker), validates it
 * (type + size), and copies it into the app's sandbox at
 * `Documents/materials/<materialId>.pdf`. The returned CourseMaterial stores
 * a *relative* localPath so the file survives sandbox-prefix changes between
 * installs of the same iCloud-restored profile.
 *
 * Native modules are required inside try/catch so a stale dev binary (no
 * ExpoDocumentPicker pod yet) surfaces a friendly error instead of red-screening
 * the screen that imports this file. Same pattern as lib/exportLectureNotesPdf.
 */
import type { CourseMaterial } from './models';

/**
 * 500 MB ceiling for local-only PDF imports. Real textbooks, scanned PDFs,
 * and long course packets often exceed 50 MB, so V1.1 keeps the gate but
 * raises it well above typical course material sizes. PDFKit handles files
 * this size lazily, so memory pressure stays manageable on iPad.
 */
export const MAX_MATERIAL_PDF_BYTES = 500 * 1024 * 1024;
/** Subdirectory under FileSystem document directory where PDFs live. */
const MATERIALS_SUBDIR = 'materials';

export type ImportMaterialResult =
  | { ok: true; material: CourseMaterial }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; reason: string };

export type ImportMaterialInput = {
  courseId: string;
  userId: string | null;
};

function makeMaterialId(): string {
  return `material_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function deriveTitle(originalName: string | undefined): string {
  const cleaned = (originalName ?? '').replace(/\.pdf$/i, '').trim();
  return cleaned || 'Untitled material';
}

/**
 * Pick + import flow. Resolves to a CourseMaterial on success.
 *
 *  - `{ ok: true }` — file is in the sandbox; metadata ready to add to store.
 *  - `{ ok: false, canceled: true }` — user dismissed the picker (no error UI).
 *  - `{ ok: false, canceled: false, reason }` — validation/copy error.
 */
export async function pickAndImportPdf(input: ImportMaterialInput): Promise<ImportMaterialResult> {
  if (!input.userId) {
    return { ok: false, canceled: false, reason: 'Please sign in to import materials.' };
  }

  // Guarded require — same pattern as exportLectureNotesPdf so a missing
  // native pod surfaces an alert, not a red screen.
  let DocumentPicker: typeof import('expo-document-picker');
  let FileSystemNS: typeof import('expo-file-system');
  try {
    DocumentPicker = require('expo-document-picker');
    FileSystemNS = require('expo-file-system');
  } catch (err) {
    if (__DEV__) console.warn('[materials] failed to load expo-document-picker / expo-file-system', err);
    return {
      ok: false,
      canceled: false,
      reason: 'Material import is not available in this build yet. Please rebuild the app from Xcode and try again.',
    };
  }

  const { Directory, File, Paths } = FileSystemNS;
  if (
    typeof DocumentPicker?.getDocumentAsync !== 'function' ||
    !Paths?.document ||
    typeof File !== 'function' ||
    typeof Directory !== 'function'
  ) {
    return {
      ok: false,
      canceled: false,
      reason: 'Material import is not available in this build yet. Please rebuild the app from Xcode and try again.',
    };
  }

  // 1. Picker — PDF only, copy to cache so we can read it on iOS.
  let picked: import('expo-document-picker').DocumentPickerResult;
  try {
    picked = await DocumentPicker.getDocumentAsync({
      type: 'application/pdf',
      copyToCacheDirectory: true,
      multiple: false,
    });
  } catch (err) {
    if (__DEV__) console.warn('[materials] document picker error', err);
    return { ok: false, canceled: false, reason: 'Could not open the file picker. Please try again.' };
  }

  if (picked.canceled) return { ok: false, canceled: true };
  const asset = picked.assets?.[0];
  if (!asset?.uri) {
    return { ok: false, canceled: false, reason: 'No file was selected.' };
  }

  // 2. Validate type. Even with type filter we double-check by extension.
  const isPdfByMime = asset.mimeType === 'application/pdf';
  const isPdfByExt = /\.pdf$/i.test(asset.name ?? '');
  if (!isPdfByMime && !isPdfByExt) {
    return { ok: false, canceled: false, reason: 'Only PDF files are supported in this version.' };
  }

  // 3. Validate size (against asset metadata; we recheck after copy).
  if (typeof asset.size === 'number' && asset.size > MAX_MATERIAL_PDF_BYTES) {
    return {
      ok: false,
      canceled: false,
      reason: 'This file is larger than 500 MB. Please import a smaller PDF.',
    };
  }

  // 4. Ensure the materials/ subdir exists. `create({intermediates,idempotent})`
  // is safe to call repeatedly.
  let materialsDir: import('expo-file-system').Directory;
  try {
    materialsDir = new Directory(Paths.document, MATERIALS_SUBDIR);
    if (!materialsDir.exists) {
      materialsDir.create({ intermediates: true, idempotent: true });
    }
  } catch (err) {
    if (__DEV__) console.warn('[materials] could not create materials dir', err);
    return { ok: false, canceled: false, reason: 'Could not access app storage. Please try again.' };
  }

  // 5. Copy the picked file into the sandbox.
  const id = makeMaterialId();
  const targetName = `${id}.pdf`;
  const targetFile = new File(materialsDir, targetName);
  try {
    const sourceFile = new File(asset.uri);
    sourceFile.copy(targetFile);
  } catch (err) {
    if (__DEV__) console.warn('[materials] copy failed', err);
    return { ok: false, canceled: false, reason: 'Could not save the file. Please try again.' };
  }

  // 6. Recheck on-disk size; abort if somehow it exceeded the cap.
  let finalSize: number | undefined;
  try {
    if (targetFile.exists) finalSize = targetFile.size;
  } catch {
    finalSize = asset.size;
  }
  if (typeof finalSize === 'number' && finalSize > MAX_MATERIAL_PDF_BYTES) {
    try { targetFile.delete(); } catch { /* best-effort */ }
    return {
      ok: false,
      canceled: false,
      reason: 'This file is larger than 500 MB. Please import a smaller PDF.',
    };
  }

  const now = new Date().toISOString();
  const material: CourseMaterial = {
    id,
    courseId: input.courseId,
    title: deriveTitle(asset.name),
    fileType: 'pdf',
    localPath: `${MATERIALS_SUBDIR}/${targetName}`,
    fileSize: typeof finalSize === 'number' ? finalSize : undefined,
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, material };
}

/**
 * Resolve a relative localPath to a real file URI for the PDF viewer.
 * Throws via guarded require pattern only if the native module is missing.
 */
export function resolveMaterialUri(localPath: string): string {
  // require() lazily so a missing native module fails on call, not on module load.
  let FileSystemNS: typeof import('expo-file-system');
  try {
    FileSystemNS = require('expo-file-system');
  } catch {
    return '';
  }
  const docDir = FileSystemNS.Paths?.document;
  if (!docDir) return '';
  return `${docDir.uri.replace(/\/+$/, '')}/${localPath.replace(/^\/+/, '')}`;
}

/** Delete the on-disk file for a permanently-removed material (best-effort). */
export function deleteMaterialFile(localPath: string): void {
  try {
    const FileSystemNS = require('expo-file-system') as typeof import('expo-file-system');
    const file = new FileSystemNS.File(resolveMaterialUri(localPath));
    if (file.exists) file.delete();
  } catch {
    // best-effort — the metadata is gone either way.
  }
}
