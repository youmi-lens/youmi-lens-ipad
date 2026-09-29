/**
 * Shared STRUCTURED SHAPE model (Shape System Phase 2): the semantic geometry of a
 * snapped shape, workspace-independent. Notebook stores it in canvas/document
 * coordinates, Course Material in PDF page coordinates; this module never knows which.
 *
 * A structured shape is an ordinary ink stroke record PLUS an authoritative `shape`.
 * The stroke's `points` are always DERIVED from `shape` (`shapeToInkPoints`), so
 * every ink pathway (SVG / CALayer rendering, eraser, selection, move, duplicate,
 * delete, undo/redo, persistence, PDF export) keeps working on plain points, while
 * editing changes the GEOMETRY and regenerates the points — sampled points are never
 * edited in place. Historical ordinary strokes have no `shape` and are untouched.
 *
 * Product semantics decided here (shared, so both workspaces behave identically):
 *  - line:     2 handles (start, end); each moves independently.
 *  - polygon:  one handle per vertex (3 = triangle, 4 = rectangle/square/general
 *              quadrilateral). Dragging a vertex moves ONLY that vertex; a dragged
 *              rectangle is NOT forced to stay a rectangle.
 *  - ellipse:  4 handles [top, right, bottom, left] on the shape's LOCAL axes.
 *              Dragging a handle resizes that local axis with the opposite side
 *              anchored; a circle becomes an ellipse and is not forced back.
 */
import type { Pt, ShapeSnapResult } from './shapeSnap';

export type ShapeOrigin = 'line' | 'triangle' | 'rectangle' | 'square' | 'circle' | 'ellipse';

export type ShapeGeometry =
  | { kind: 'line'; a: Pt; b: Pt }
  | { kind: 'polygon'; vertices: Pt[] }
  /** ax / ay are semi-axis VECTORS from the center; handles sit on center ± ax and center ± ay. */
  | { kind: 'ellipse'; center: Pt; ax: Pt; ay: Pt };

export type AnnotationShape = {
  /** What the recognizer originally classified it as (informational; geometry is authoritative). */
  origin: ShapeOrigin;
  geometry: ShapeGeometry;
};

/**
 * Interaction sizes are defined in SCREEN POINTS (geometry stays in workspace units):
 * a workspace length is `screenPt / scale`, where scale = screen points per workspace unit
 * (Notebook zoom; Course Material page scale × zoom). Same on-screen reach at every zoom.
 */
export const SHAPE_HANDLE_RADIUS_PT = 9;
export const SHAPE_HANDLE_HIT_PT = 24;
export const SHAPE_TAP_SELECT_PT = 16;
/** A select-tool gesture whose extent stays under this many screen points is a TAP. */
export const SHAPE_TAP_MAX_EXTENT_PT = 10;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const clonePt = (p: Pt): Pt => ({ x: p.x, y: p.y });
const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;

function signedArea(points: readonly Pt[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Recognizer output -> structured shape, ordered in the direction the user drew it. */
export function shapeFromRecognition(result: ShapeSnapResult, original: readonly Pt[]): AnnotationShape {
  if (result.type === 'line') {
    return { origin: 'line', geometry: { kind: 'line', a: clonePt(result.a), b: clonePt(result.b) } };
  }
  const start = original[0];
  const direction = signedArea(original) >= 0 ? 1 : -1;

  if (result.type === 'circle' || result.type === 'ellipse') {
    const rx = result.type === 'circle' ? result.radius : result.rx;
    const ry = result.type === 'circle' ? result.radius : result.ry;
    const angle = result.type === 'circle' ? 0 : result.angle;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    // cross(ax, ay) carries the drawing direction, so increasing t IS the user's direction.
    const sign = direction >= 0 ? 1 : -1;
    return {
      origin: result.type,
      geometry: {
        kind: 'ellipse',
        center: clonePt(result.center),
        ax: { x: rx * c, y: rx * s },
        ay: { x: -sign * ry * s, y: sign * ry * c },
      },
    };
  }

  let vertices: Pt[];
  if (result.type === 'triangle') {
    vertices = result.vertices.map(clonePt);
  } else {
    const c = Math.cos(result.angle);
    const s = Math.sin(result.angle);
    const hw = result.width / 2;
    const hh = result.height / 2;
    vertices = [
      { x: hw, y: hh }, { x: -hw, y: hh }, { x: -hw, y: -hh }, { x: hw, y: -hh },
    ].map((q) => ({ x: result.center.x + q.x * c - q.y * s, y: result.center.y + q.x * s + q.y * c }));
    // (hw,hh) -> (-hw,hh) -> (-hw,-hh) -> (hw,-hh) is counter-clockwise in math axes.
    if (direction < 0) vertices = [vertices[0], vertices[3], vertices[2], vertices[1]];
  }
  let first = 0;
  for (let i = 1; i < vertices.length; i += 1) if (dist(vertices[i], start) < dist(vertices[first], start)) first = i;
  vertices = vertices.map((_, k) => vertices[(first + k) % vertices.length]);
  return { origin: result.type, geometry: { kind: 'polygon', vertices } };
}

function densifyClosed(vertices: readonly Pt[]): Pt[] {
  const ring = [...vertices, vertices[0]];
  let perimeter = 0;
  for (let i = 1; i < ring.length; i += 1) perimeter += dist(ring[i - 1], ring[i]);
  const spacing = Math.min(4, Math.max(1, perimeter / 600));
  const out: Pt[] = [clonePt(ring[0])];
  for (let i = 1; i < ring.length; i += 1) {
    const a = ring[i - 1];
    const b = ring[i];
    const steps = Math.max(1, Math.ceil(dist(a, b) / spacing));
    for (let k = 1; k <= steps; k += 1) {
      out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
    }
  }
  return out;
}

/**
 * Ink points for the shape (what renderers, eraser, selection and export consume).
 * Lines are exactly two points; polygons are densified so midpoint smoothing cannot
 * round corners; ellipses are 120 samples. `startHint` only picks where a closed
 * ellipse starts (used at snap time so the outline starts where the user's stroke did).
 */
export function shapeToInkPoints(shape: AnnotationShape, startHint?: Pt): Pt[] {
  const g = shape.geometry;
  if (g.kind === 'line') return [clonePt(g.a), clonePt(g.b)];
  if (g.kind === 'polygon') return densifyClosed(g.vertices);
  let t0 = 0;
  if (startHint) {
    const det = cross(g.ax, g.ay);
    if (Math.abs(det) > 1e-9) {
      const dx = startHint.x - g.center.x;
      const dy = startHint.y - g.center.y;
      const u = (dx * g.ay.y - dy * g.ay.x) / det;
      const v = (g.ax.x * dy - g.ax.y * dx) / det;
      t0 = Math.atan2(v, u);
    }
  }
  const count = 120;
  const out: Pt[] = [];
  for (let i = 0; i <= count; i += 1) {
    const t = t0 + (2 * Math.PI * i) / count;
    const cs = Math.cos(t);
    const sn = Math.sin(t);
    out.push({ x: g.center.x + g.ax.x * cs + g.ay.x * sn, y: g.center.y + g.ax.y * cs + g.ay.y * sn });
  }
  return out;
}

/**
 * Clean geometry as ordinary ink points for a recognizer result: the structured model's
 * derived points, so a freshly snapped shape and a later-edited one render identically.
 * Lines stay exactly two points (the drawn start and final Pencil position).
 */
export function shapeToPoints(result: ShapeSnapResult, original: readonly Pt[]): Pt[] {
  return shapeToInkPoints(shapeFromRecognition(result, original));
}

/** Handle positions in workspace units: line [start,end]; polygon vertices; ellipse [top,right,bottom,left]. */
export function shapeHandles(geometry: ShapeGeometry): Pt[] {
  if (geometry.kind === 'line') return [clonePt(geometry.a), clonePt(geometry.b)];
  if (geometry.kind === 'polygon') return geometry.vertices.map(clonePt);
  const { center: c, ax, ay } = geometry;
  return [
    { x: c.x - ay.x, y: c.y - ay.y },
    { x: c.x + ax.x, y: c.y + ax.y },
    { x: c.x + ay.x, y: c.y + ay.y },
    { x: c.x - ax.x, y: c.y - ax.y },
  ];
}

export function shapeHandleCount(geometry: ShapeGeometry): number {
  return geometry.kind === 'line' ? 2 : geometry.kind === 'polygon' ? geometry.vertices.length : 4;
}

/** Index of the handle within `radius` of `p` (nearest wins), or null. `radius` is in workspace units. */
export function nearestShapeHandle(geometry: ShapeGeometry, p: Pt, radius: number): number | null {
  let best: number | null = null;
  let bestDistance = radius;
  shapeHandles(geometry).forEach((h, i) => {
    const d = dist(h, p);
    if (d <= bestDistance) { bestDistance = d; best = i; }
  });
  return best;
}

/**
 * The geometry after dragging handle `index` to `to`. Only what that handle controls
 * changes: one endpoint, one vertex, or one local ellipse axis (opposite side anchored).
 * `minAxis` (workspace units) stops an ellipse collapsing to nothing.
 */
export function dragShapeHandle(geometry: ShapeGeometry, index: number, to: Pt, minAxis = 2): ShapeGeometry {
  if (geometry.kind === 'line') {
    return index === 0 ? { kind: 'line', a: clonePt(to), b: clonePt(geometry.b) } : { kind: 'line', a: clonePt(geometry.a), b: clonePt(to) };
  }
  if (geometry.kind === 'polygon') {
    return { kind: 'polygon', vertices: geometry.vertices.map((v, i) => (i === index ? clonePt(to) : clonePt(v))) };
  }
  const { center: c, ax, ay } = geometry;
  const horizontal = index === 1 || index === 3; // right / left resize ax; top / bottom resize ay
  const axis = horizontal ? ax : ay;
  const length = Math.hypot(axis.x, axis.y);
  if (length < 1e-9) return geometry;
  const u = { x: axis.x / length, y: axis.y / length };
  // "positive" handles sit at +axis (right, bottom); the others at -axis (left, top).
  const positive = index === 1 || index === 2;
  const anchor = positive ? { x: c.x - axis.x, y: c.y - axis.y } : { x: c.x + axis.x, y: c.y + axis.y };
  const along = (to.x - anchor.x) * u.x + (to.y - anchor.y) * u.y;
  const full = Math.max(2 * minAxis, positive ? along : -along);
  const half = { x: (u.x * full) / 2, y: (u.y * full) / 2 };
  const center = positive ? { x: anchor.x + half.x, y: anchor.y + half.y } : { x: anchor.x - half.x, y: anchor.y - half.y };
  return horizontal
    ? { kind: 'ellipse', center, ax: half, ay: clonePt(ay) }
    : { kind: 'ellipse', center, ax: clonePt(ax), ay: half };
}

export function translateGeometry(geometry: ShapeGeometry, dx: number, dy: number): ShapeGeometry {
  const move = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  if (geometry.kind === 'line') return { kind: 'line', a: move(geometry.a), b: move(geometry.b) };
  if (geometry.kind === 'polygon') return { kind: 'polygon', vertices: geometry.vertices.map(move) };
  return { kind: 'ellipse', center: move(geometry.center), ax: clonePt(geometry.ax), ay: clonePt(geometry.ay) };
}

export function translateShape(shape: AnnotationShape, dx: number, dy: number): AnnotationShape {
  return { origin: shape.origin, geometry: translateGeometry(shape.geometry, dx, dy) };
}

/** Structural type guard for strokes that carry a structured shape (Notebook and Course Material alike). */
export function isStructuredStroke<T extends { shape?: AnnotationShape }>(stroke: T): stroke is T & { shape: AnnotationShape } {
  return !!stroke.shape && typeof stroke.shape === 'object' && !!stroke.shape.geometry;
}

/**
 * Translates an ink stroke by (dx, dy): its points, and its structured geometry when
 * it has one, so the two can never drift apart. Ordinary strokes are unchanged in shape.
 */
export function translateInkStroke<T extends { points: Pt[]; shape?: AnnotationShape }>(stroke: T, dx: number, dy: number): T {
  const points = stroke.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  return isStructuredStroke(stroke) ? { ...stroke, points, shape: translateShape(stroke.shape, dx, dy) } : { ...stroke, points };
}

/** The stroke rebuilt from edited geometry: authoritative `shape`, regenerated `points`. */
export function strokeWithShape<T extends { points: Pt[]; shape?: AnnotationShape }>(stroke: T, shape: AnnotationShape): T {
  return { ...stroke, shape, points: shapeToInkPoints(shape) };
}

/** Distance from `p` to the shape's drawn outline (its ink points), in workspace units. */
export function distanceToInkOutline(points: readonly Pt[], p: Pt): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

/** The structured stroke whose outline is nearest to `p` within `tolerance` (workspace units), or null. Topmost wins ties. */
export function hitTestStructuredStroke<T extends { id: string; points: Pt[]; shape?: AnnotationShape }>(
  strokes: readonly T[],
  p: Pt,
  tolerance: number,
): T | null {
  let best: T | null = null;
  let bestDistance = tolerance;
  for (const stroke of strokes) {
    if (!isStructuredStroke(stroke)) continue;
    const d = distanceToInkOutline(stroke.points, p);
    if (d <= bestDistance) { bestDistance = d; best = stroke; }
  }
  return best;
}

/** Invariant used by tests and by adapters after every edit: points regenerate from the geometry. */
export function inkPointsMatchShape(stroke: { points: readonly Pt[]; shape?: AnnotationShape }, epsilon = 1e-6): boolean {
  if (!stroke.shape) return true;
  const expected = shapeToInkPoints(stroke.shape);
  if (expected.length !== stroke.points.length) return false;
  return expected.every((p, i) => Math.abs(p.x - stroke.points[i].x) <= epsilon && Math.abs(p.y - stroke.points[i].y) <= epsilon);
}
