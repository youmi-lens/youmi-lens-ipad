/**
 * Pure notebook stroke helpers — path generation, point filtering, and
 * structural cost accounting used by NotebookCanvas and unit tests.
 *
 * Kept free of React Native imports so node test scripts can exercise them.
 */

export type NotebookStrokePoint = { x: number; y: number };

/** Minimum distance (canvas px) before a new freehand sample is accepted. */
export const NOTEBOOK_MIN_POINT_DISTANCE = 1.8;

/** Build a smooth SVG path (quadratic midpoints) from freehand points. */
export function strokeToPath(points: readonly NotebookStrokePoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${p.y} L ${p.x + 0.1} ${p.y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** Whether `candidate` is far enough from `last` to keep. */
export function shouldAcceptStrokePoint(
  last: NotebookStrokePoint | undefined,
  candidate: NotebookStrokePoint,
  minDistance: number = NOTEBOOK_MIN_POINT_DISTANCE,
): boolean {
  if (!last) return true;
  return Math.hypot(candidate.x - last.x, candidate.y - last.y) >= minDistance;
}

/**
 * Append `candidate` to `points` in place when it clears the distance filter.
 * Returns true when a point was added.
 */
export function appendStrokePoint(
  points: NotebookStrokePoint[],
  candidate: NotebookStrokePoint,
  minDistance: number = NOTEBOOK_MIN_POINT_DISTANCE,
): boolean {
  const last = points[points.length - 1];
  if (!shouldAcceptStrokePoint(last, candidate, minDistance)) return false;
  points.push(candidate);
  return true;
}

/**
 * Structural cost model: without a memoized completed-stroke layer, each
 * active-point React commit regenerates SVG paths for every completed stroke
 * plus the active stroke (O(completed + 1) path builds per point).
 *
 * With completed strokes isolated/memoized, only the active stroke path is
 * rebuilt (O(1) path builds per point relative to page density).
 */
export function pathBuildsPerActivePoint(args: {
  completedStrokeCount: number;
  completedStrokesMemoized: boolean;
}): number {
  const { completedStrokeCount, completedStrokesMemoized } = args;
  if (completedStrokeCount < 0) return 0;
  return completedStrokesMemoized ? 1 : completedStrokeCount + 1;
}

/** Synthetic long stroke for stress / cost checks (deterministic). */
export function synthesizeStrokePoints(
  count: number,
  opts?: { startX?: number; startY?: number; step?: number },
): NotebookStrokePoint[] {
  const startX = opts?.startX ?? 40;
  const startY = opts?.startY ?? 40;
  const step = opts?.step ?? 3;
  const points: NotebookStrokePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    points.push({
      x: startX + i * step,
      y: startY + Math.sin(i / 8) * 12,
    });
  }
  return points;
}
