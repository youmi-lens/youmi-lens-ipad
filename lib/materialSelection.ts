import { dragShapeHandle, isStructuredStroke, strokeWithShape, translateInkStroke } from './annotationShape.ts';
import { scaleInkStroke } from './selectionTransform.ts';
import type { MaterialAnnotationStroke } from './models';

export type MaterialSelection = { pageNumber: number; strokeIds: string[] };
export type MaterialSelectionChange = {
  beforeStrokes: MaterialAnnotationStroke[];
  afterStrokes: MaterialAnnotationStroke[];
};

/** Native selection IDs are page-local; legacy viewport strokes are never editable here. */
export function materialSelectionChange(
  selection: MaterialSelection,
  strokes: MaterialAnnotationStroke[],
  operation: 'delete' | 'duplicate',
  newId: () => string,
  now: string,
): MaterialSelectionChange | null {
  const strokeIds = new Set(selection.strokeIds);
  const selectedStrokes = strokes.filter((stroke) => stroke.coordSpace === 'pdfPage' && strokeIds.has(stroke.id));
  if (selectedStrokes.length === 0) return null;

  const afterStrokes = operation === 'delete'
    ? strokes.filter((stroke) => !selectedStrokes.includes(stroke))
    : [...strokes, ...selectedStrokes.map((stroke) => ({
      // A structured shape's geometry moves with its points; the copy gets a new stable id.
      ...translateInkStroke(stroke, 18, -18), id: newId(), createdAt: now,
    }))];
  return { beforeStrokes: strokes, afterStrokes };
}

/** Translates selected PDF-page ink by (dx, dy) in page space. Unselected strokes keep their identity. */
export function materialSelectionMove(
  selection: MaterialSelection,
  strokes: MaterialAnnotationStroke[],
  dx: number,
  dy: number,
): MaterialSelectionChange | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  const strokeIds = new Set(selection.strokeIds);
  const moves = (stroke: MaterialAnnotationStroke) => stroke.coordSpace === 'pdfPage' && strokeIds.has(stroke.id);
  if (!strokes.some(moves)) return null;
  const afterStrokes = strokes.map((stroke) => moves(stroke) ? translateInkStroke(stroke, dx, dy) : stroke);
  return { beforeStrokes: strokes, afterStrokes };
}

/**
 * One completed two-finger pinch of the selected ink (PDF page space). Scales geometry about `center`
 * (native's selection center) from the ORIGINAL strokes; pen width, identity and style are preserved.
 */
export function materialSelectionScale(
  selection: MaterialSelection,
  strokes: MaterialAnnotationStroke[],
  factor: number,
  center: { x: number; y: number },
): MaterialSelectionChange | null {
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-6 || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;
  const strokeIds = new Set(selection.strokeIds);
  const scales = (stroke: MaterialAnnotationStroke) => stroke.coordSpace === 'pdfPage' && strokeIds.has(stroke.id);
  if (!strokes.some(scales)) return null;
  const afterStrokes = strokes.map((stroke) => (scales(stroke) ? scaleInkStroke(stroke, center, factor) : stroke));
  return { beforeStrokes: strokes, afterStrokes };
}

/**
 * One completed handle drag of a structured shape (PDF page space). Shares the Notebook's
 * `dragShapeHandle` semantics, then REGENERATES the ink points from the edited geometry.
 */
export function materialShapeEdit(
  pageNumber: number,
  strokes: MaterialAnnotationStroke[],
  strokeId: string,
  handleIndex: number,
  target: { x: number; y: number },
): (MaterialSelectionChange & { strokeId: string; pageNumber: number }) | null {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
  const stroke = strokes.find((candidate) => candidate.id === strokeId);
  if (!stroke || stroke.coordSpace !== 'pdfPage' || !isStructuredStroke(stroke)) return null;
  const geometry = dragShapeHandle(stroke.shape.geometry, handleIndex, target);
  const edited = strokeWithShape(stroke, { origin: stroke.shape.origin, geometry });
  return {
    pageNumber,
    strokeId,
    beforeStrokes: strokes,
    afterStrokes: strokes.map((candidate) => (candidate.id === strokeId ? edited : candidate)),
  };
}
