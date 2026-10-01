/**
 * Shared selection TRANSFORM math + touch ROUTING (Selection Interaction Phase).
 * Pure and workspace-independent: Notebook feeds canvas coordinates, Course Material feeds
 * PDF page coordinates. Previews are always ORIGINAL_GEOMETRY × CURRENT_GESTURE_TRANSFORM —
 * never accumulated from already-transformed points — so a long pinch cannot drift.
 */
import { strokeWithShape, isStructuredStroke, type AnnotationShape, type ShapeGeometry } from './annotationShape.ts';

export type Pt = { x: number; y: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Relative scale limits per gesture (semantic, not document units). */
export const SELECTION_SCALE_MIN = 0.2;
export const SELECTION_SCALE_MAX = 5;
/** The scaled selection may not become smaller / larger than this many SCREEN points across its long side. */
export const SELECTION_MIN_SPAN_PT = 24;
export const SELECTION_MAX_SPAN_PT = 6000;
/** Touch tolerance around the selected region, in screen points. */
export const SELECTION_TOUCH_PAD_PT = 28;
export const SELECTION_PENCIL_PAD_PT = 18;

export function boundsOfPoints(points: readonly Pt[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boundsOfStrokes(strokes: readonly { points: readonly Pt[] }[]): Bounds | null {
  return boundsOfPoints(strokes.flatMap((s) => s.points));
}

export const boundsCenter = (b: Bounds): Pt => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
export const boundsSpan = (b: Bounds): number => Math.max(b.maxX - b.minX, b.maxY - b.minY);

/**
 * SHARED PRODUCT SEMANTIC (both workspaces): selected content is MOVABLE CONTENT — its origin canvas/page is never a
 * movement prison. When a workspace keeps per-page ownership (Course Material: PDF page buckets) the destination is
 * decided by ONE reference point for the whole selected group: the CENTER of the selection bounds after the drag.
 * Notebook's continuous canvas has no per-page ownership, so the same drag is a plain translation.
 */
export function selectionReferencePoint(bounds: Bounds, dx = 0, dy = 0): Pt {
  return { x: (bounds.minX + bounds.maxX) / 2 + dx, y: (bounds.minY + bounds.maxY) / 2 + dy };
}

/** True when `p` is inside the selected region grown by `padUnits` (= padPt / screen scale). */
export function insideSelectionRegion(bounds: Bounds | null, p: Pt, padUnits: number): boolean {
  return !!bounds && p.x >= bounds.minX - padUnits && p.x <= bounds.maxX + padUnits && p.y >= bounds.minY - padUnits && p.y <= bounds.maxY + padUnits;
}

/**
 * Clamps a relative pinch factor so the result neither collapses, inverts nor explodes.
 * `spanUnits` is the selection's long side at gesture start; `unitsPerPt` = 1 / screen scale.
 */
export function clampSelectionScale(factor: number, spanUnits: number, unitsPerPt: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  let f = Math.min(SELECTION_SCALE_MAX, Math.max(SELECTION_SCALE_MIN, factor));
  if (spanUnits > 0 && unitsPerPt > 0) {
    f = Math.max(f, (SELECTION_MIN_SPAN_PT * unitsPerPt) / spanUnits);
    f = Math.min(f, (SELECTION_MAX_SPAN_PT * unitsPerPt) / spanUnits);
    // A selection already below the minimum may still be scaled UP but never further down.
    if (spanUnits < SELECTION_MIN_SPAN_PT * unitsPerPt) f = Math.max(f, 1);
  }
  return f;
}

export const pinchFactor = (startDistance: number, distance: number): number =>
  startDistance > 1e-6 ? distance / startDistance : 1;

export const scalePoint = (p: Pt, center: Pt, factor: number): Pt => ({
  x: center.x + (p.x - center.x) * factor,
  y: center.y + (p.y - center.y) * factor,
});

export function scaleGeometry(geometry: ShapeGeometry, center: Pt, factor: number): ShapeGeometry {
  const s = (p: Pt) => scalePoint(p, center, factor);
  if (geometry.kind === 'line') return { kind: 'line', a: s(geometry.a), b: s(geometry.b) };
  if (geometry.kind === 'polygon') return { kind: 'polygon', vertices: geometry.vertices.map(s) };
  return {
    kind: 'ellipse',
    center: s(geometry.center),
    ax: { x: geometry.ax.x * factor, y: geometry.ax.y * factor },
    ay: { x: geometry.ay.x * factor, y: geometry.ay.y * factor },
  };
}

export const scaleShape = (shape: AnnotationShape, center: Pt, factor: number): AnnotationShape => ({
  origin: shape.origin,
  geometry: scaleGeometry(shape.geometry, center, factor),
});

/**
 * Scales one ink stroke about `center`. Geometry scales; identity, colour, tool and — by
 * product decision — PEN WIDTH are preserved (ink thickness is a style, not geometry).
 * A structured shape scales its geometry and REGENERATES its points from it.
 */
export function scaleInkStroke<T extends { points: Pt[]; shape?: AnnotationShape }>(stroke: T, center: Pt, factor: number): T {
  if (isStructuredStroke(stroke)) return strokeWithShape(stroke, scaleShape(stroke.shape, center, factor));
  return { ...stroke, points: stroke.points.map((p) => ({ ...p, ...scalePoint(p, center, factor) })) };
}

/** Scales the selected strokes (others keep identity) about the selection center. */
export function scaleSelectedStrokes<T extends { id: string; points: Pt[]; shape?: AnnotationShape }>(
  strokes: readonly T[], ids: ReadonlySet<string>, center: Pt, factor: number,
): T[] {
  return strokes.map((stroke) => (ids.has(stroke.id) ? scaleInkStroke(stroke, center, factor) : stroke));
}

// ---- Touch routing -------------------------------------------------------------------

export type TouchRoute =
  | 'shape-handle-edit'
  | 'selection-move'
  | 'selection-scale'
  | 'new-selection'
  | 'page-navigation';

export type TouchRouteInput = {
  pointer: 'stylus' | 'touch' | 'other';
  /** Touches down on the surface (including this one). */
  touchCount: number;
  hasSelection: boolean;
  /** First touch inside the selected region (screen-tolerance padded). */
  insideSelection: boolean;
  /** The (first) touch — Pencil OR one finger — is on a handle of the single selected structured shape. */
  onHandle?: boolean;
  /** For two touches: the second one is also inside the selected region. */
  secondInsideSelection?: boolean;
};

/**
 * Arbitration priority (highest first):
 *   Pencil on a handle > Pencil inside selection (move) > Pencil elsewhere (new Box/Lasso) ;
 *   ONE finger on a handle > ONE finger inside the selection (move) > page navigation for any finger outside it;
 *   TWO fingers both inside the selection (scale) > page navigation.
 * The page is NEVER made unscrollable just because something is selected: a finger that
 * begins outside the selected region always belongs to the page.
 */
export function routeSelectionTouch(input: TouchRouteInput): TouchRoute {
  if (input.pointer === 'stylus') {
    if (input.onHandle) return 'shape-handle-edit';
    if (input.hasSelection && input.insideSelection) return 'selection-move';
    return 'new-selection';
  }
  if (input.pointer === 'touch') {
    if (!input.hasSelection) return 'page-navigation';
    // ONE finger on a handle of the single selected shape edits that handle (same as the Pencil): a handle beats
    // the body move and the page. Notebook consumes this; Course Material's native finger recognizer mirrors it
    // (AnnotationOverlay.beginFingerManipulation) and scripts/selection-finger-handle-parity.test.mjs pins both.
    if (input.touchCount < 2 && input.onHandle) return 'shape-handle-edit';
    if (!input.insideSelection) return 'page-navigation';
    if (input.touchCount >= 2) return input.secondInsideSelection ? 'selection-scale' : 'page-navigation';
    return 'selection-move';
  }
  return 'page-navigation';
}
