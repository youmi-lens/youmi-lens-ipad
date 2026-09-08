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
