/** Workspace coordinates are supplied by the caller (canvas or PDF page). */
export type SelectionPoint = { x: number; y: number };
export type SelectionRect = { x: number; y: number; width: number; height: number };
export type SelectionShape = 'lasso' | 'rect';

export function selectionAcceptsPointer(pointer: 'stylus' | 'touch' | 'other'): boolean {
  return pointer === 'stylus';
}

export function startFreeform(point: SelectionPoint): SelectionPoint[] {
  return [point];
}

export function appendFreeform(points: SelectionPoint[], point: SelectionPoint): SelectionPoint[] {
  return [...points, point];
}

export function boxFromCorners(a: SelectionPoint, b: SelectionPoint): SelectionRect {
  return {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
  };
}

export function pointInSelection(point: SelectionPoint, shape: SelectionShape, points: SelectionPoint[]): boolean {
  if (shape === 'rect') {
    if (points.length < 2) return false;
    const rect = boxFromCorners(points[0], points[points.length - 1]);
    return rect.width >= 3 && rect.height >= 3 &&
      point.x >= rect.x && point.x <= rect.x + rect.width &&
      point.y >= rect.y && point.y <= rect.y + rect.height;
  }
  if (points.length < 3) return false;
  // The visible path stays open. Ray casting closes the last-to-first edge
  // logically, so the Pencil need not return exactly to its starting point.
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Only ink points enter this function; text/PDF/image data have no route in. */
export function selectedInkIds<T extends { id: string; points: SelectionPoint[] }>(
  strokes: T[], shape: SelectionShape, points: SelectionPoint[],
): Set<string> {
  return new Set(strokes.filter((stroke) => stroke.points.some((point) =>
    pointInSelection(point, shape, points))).map((stroke) => stroke.id));
}
