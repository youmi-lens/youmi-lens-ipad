/**
 * Direct structured-shape TAP from a drawing tool (Pen / Highlighter). Shared by Notebook (TS) and
 * Course Material (mirrored constants in native, pinned by the fixture).
 *
 * A structured shape is directly interactive regardless of the active tool, but a Pencil-down near a
 * shape must NOT select it: only a TAP does. A tap is decided from gesture evidence at Pencil-UP —
 * never per sample — so ordinary handwriting pays nothing:
 *
 *   tiny extent  AND  short duration  AND  not a hold-snapped stroke  AND  lands on a shape outline
 *     -> select the shape, suppress the dot
 *   anything else (a drag, a slow press, a snap, blank paper, ordinary ink) -> normal Pen behavior.
 */
import { SHAPE_TAP_MAX_EXTENT_PT, SHAPE_TAP_SELECT_PT, hitTestStructuredStroke, type AnnotationShape } from './annotationShape.ts';

/** A tap is quick: longer presses are deliberate marks (or a hold-snap), never a selection. */
export const PEN_TAP_MAX_DURATION_MS = 450;

type Pt = { x: number; y: number };

/** Extent (long side of the bounding box) of the stroke, in workspace units. */
function extentOf(points: readonly Pt[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

/** True when the just-finished stroke is a TAP (tiny, quick, not snapped). `unitsPerPt` = 1 / screen scale. */
export function penStrokeIsTap(input: { points: readonly Pt[]; durationMs: number; unitsPerPt: number; snapped: boolean }): boolean {
  if (input.snapped || input.points.length === 0) return false;
  if (input.durationMs > PEN_TAP_MAX_DURATION_MS) return false;
  return extentOf(input.points) < SHAPE_TAP_MAX_EXTENT_PT * input.unitsPerPt;
}

/**
 * The structured shape a Pen/Highlighter tap selects, or null when the stroke is ordinary writing / a dot on
 * blank paper. Hit tolerance is defined in screen points and converted with `unitsPerPt`.
 */
export function penTapShapeTarget<T extends { id: string; points: Pt[]; shape?: AnnotationShape }>(
  strokes: readonly T[],
  input: { points: readonly Pt[]; durationMs: number; unitsPerPt: number; snapped: boolean },
): T | null {
  if (!penStrokeIsTap(input)) return null;
  return hitTestStructuredStroke(strokes, input.points[0], SHAPE_TAP_SELECT_PT * input.unitsPerPt);
}
