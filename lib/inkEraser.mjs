/**
 * Geometry shared by JS ink erasers.
 *
 * Eraser input is sampled, not continuous. Testing only sampled points lets a
 * fast Pencil move jump over ink, so every sample is evaluated as the swept
 * capsule from its predecessor to the new point.
 */
export function distancePointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.0001) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) <= 0.0001) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a, b, point) {
  return point.x <= Math.max(a.x, b.x) + 0.0001
    && point.x + 0.0001 >= Math.min(a.x, b.x)
    && point.y <= Math.max(a.y, b.y) + 0.0001
    && point.y + 0.0001 >= Math.min(a.y, b.y);
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, b, c))
    || (o2 === 0 && onSegment(a, b, d))
    || (o3 === 0 && onSegment(c, d, a))
    || (o4 === 0 && onSegment(c, d, b));
}

export function distanceSegmentToSegment(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distancePointToSegment(a, c, d),
    distancePointToSegment(b, c, d),
    distancePointToSegment(c, a, b),
    distancePointToSegment(d, a, b),
  );
}

export function strokeBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

export function sweepMayReachBounds(from, to, bounds, radius) {
  return !(Math.max(from.x, to.x) < bounds.minX - radius
    || Math.min(from.x, to.x) > bounds.maxX + radius
    || Math.max(from.y, to.y) < bounds.minY - radius
    || Math.min(from.y, to.y) > bounds.maxY + radius);
}

export function strokeNearSweep(stroke, from, to, eraserRadius) {
  const points = stroke.points;
  if (points.length === 0) return false;
  const threshold = eraserRadius + Math.max(1, stroke.width / 2);
  if (points.length === 1) return distancePointToSegment(points[0], from, to) <= threshold;
  for (let index = 0; index < points.length - 1; index += 1) {
    if (distanceSegmentToSegment(from, to, points[index], points[index + 1]) <= threshold) return true;
  }
  return false;
}
