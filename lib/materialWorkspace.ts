import type { MaterialAnnotationStroke, MaterialTextAnnotation } from '@/lib/models';

/** Shared, persistence-safe rules for the PDF workspace's synthetic note pages. */
export function compositePageCount(sourcePageCount: number, appendedPageCount: number): number {
  return Math.max(1, Math.round(sourcePageCount || 0)) + Math.max(0, Math.round(appendedPageCount || 0));
}

export function hasMeaningfulMaterialPageContent(
  strokes: MaterialAnnotationStroke[] | undefined,
  textAnnotations: MaterialTextAnnotation[] | undefined,
): boolean {
  return Boolean(
    strokes?.some((stroke) => stroke.points?.length > 0 && stroke.coordSpace === 'pdfPage') ||
    textAnnotations?.some((annotation) => annotation.text.trim().length > 0),
  );
}

/**
 * Appended pages are deliberately monotonic. Once a student has used the
 * document's final page, retain that page and make exactly one new workspace
 * page available; erasing later never renumbers the document.
 */
export function appendedPageCountAfterFinalPageContent(
  sourcePageCount: number,
  appendedPageCount: number,
  contentPageNumber: number,
): number {
  const source = Math.max(1, Math.round(sourcePageCount || 0));
  const current = Math.max(0, Math.round(appendedPageCount || 0));
  return contentPageNumber >= source + current ? current + 1 : current;
}

/** The workspace-only blank trailing page is omitted from the portable export. */
export function exportedPageCount(
  sourcePageCount: number,
  appendedPageCount: number,
): number {
  const source = Math.max(1, Math.round(sourcePageCount || 0));
  return source + Math.max(0, Math.round(appendedPageCount || 0) - 1);
}

/** A corrupted/stale local resume value must never make PDFKit navigate out of range. */
export function clampedMaterialResumePage(savedPage: unknown, compositeTotalPages: number): number {
  const total = Math.max(1, Math.round(compositeTotalPages || 0));
  const numeric = typeof savedPage === 'number' ? savedPage : Number(savedPage);
  if (!Number.isFinite(numeric) || numeric < 1) return 1;
  return Math.min(total, Math.max(1, Math.round(numeric)));
}

/**
 * Content equality for a page->text-annotations grouping (the shape sent to
 * the native PDF overlay as a prop). `textAnnotationsForMaterialPage` (and
 * therefore the whole DataContext value) gets a new function/array reference
 * on every unrelated store update — recording autosave, an unrelated lecture
 * edit, anything — even when no text annotation actually changed. Without
 * this check, that reference churn alone rebuilds the grouped object every
 * time and hands the native view a "new" prop, which unconditionally
 * reloads and redraws every committed text annotation (see
 * PdfAnnotationView.swift's loadTextAnnotations) — the exact mechanism
 * behind pasted/committed text visually flashing on a cadence tied to
 * unrelated app activity rather than anything the user did on this screen.
 */
export function textAnnotationsByPageEqual(
  a: Record<string, MaterialTextAnnotation[]>,
  b: Record<string, MaterialTextAnnotation[]>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const aList = a[key];
    const bList = b[key];
    if (!bList || aList.length !== bList.length) return false;
    for (let i = 0; i < aList.length; i += 1) {
      const x = aList[i];
      const y = bList[i];
      if (
        x.id !== y.id ||
        x.text !== y.text ||
        x.x !== y.x ||
        x.y !== y.y ||
        x.width !== y.width ||
        x.fontSize !== y.fontSize ||
        x.anchor !== y.anchor
      ) {
        return false;
      }
    }
  }
  return true;
}
