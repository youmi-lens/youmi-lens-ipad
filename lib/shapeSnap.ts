/**
 * SharedShapeSnapEngine — pure, unit-agnostic geometry recognition for
 * draw-and-hold shape snapping (Phase 1: line, rectangle, square, circle,
 * ellipse). Used by BOTH Notebook (canvas coordinates) and Course Material
 * (PDF page coordinates); workspace adapters own coordinate systems and pass
 * `minSize` in their own units. No React, no native, no I/O.
 *
 * Conservative by design: any doubt returns `null` (false negatives beat
 * false positives), and an ambiguous rectangle-vs-ellipse fit is rejected.
 */
export type Pt = { x: number; y: number };

export type ShapeSnapResult =
  | { type: 'line'; confidence: number; a: Pt; b: Pt }
  | { type: 'rectangle' | 'square'; confidence: number; center: Pt; width: number; height: number; angle: number }
  | { type: 'circle'; confidence: number; center: Pt; radius: number }
  | { type: 'ellipse'; confidence: number; center: Pt; rx: number; ry: number; angle: number }
  /** Any clear three-sided polygon (not necessarily equilateral / isosceles / right). Vertices follow the drawing direction. */
  | { type: 'triangle'; confidence: number; vertices: [Pt, Pt, Pt] };

export type ShapeSnapOptions = {
  /** Smallest overall extent (workspace units) worth snapping. Default 24. */
  minSize?: number;
  /** Smallest extent for CLOSED shapes (default 2.5x minSize): letters and doodles stay ink. */
  minClosedSize?: number;
};

// ---- Conservative thresholds (all relative, so unit-agnostic) ----
const MIN_POINTS = 8;
const RESAMPLE_COUNT = 96;
const LINE_MIN_STRAIGHTNESS = 0.92; // chord / path length
const LINE_MAX_DEVIATION = 0.07; // max perpendicular deviation / chord
const LINE_MAX_BACKTRACK = 0.06; // reverse travel along the chord / chord
const CLOSED_MAX_GAP = 0.075; // end-to-start gap / path length (a loop must be essentially finished)
const TURNING_TARGET = 2 * Math.PI;
const SIMPLIFY_EPSILON = 0.03; // Douglas-Peucker tolerance as a fraction of the loop length
const TURNING_TOLERANCE = 1.1; // rad on the trimmed, smoothed loop; rejects spirals, figure-8s, scribbles
// Fit gates use the MEAN and the 90th-percentile residual (not the single worst
// point), so a stray pen-lift flick cannot veto an otherwise clear shape.
const RECT_MAX_MEAN_ERROR = 0.075;
const RECT_MAX_P90_ERROR = 0.17;
const ELLIPSE_MAX_MEAN_ERROR = 0.07;
const ELLIPSE_MAX_P90_ERROR = 0.14;
const AMBIGUITY_RATIO = 1.5; // rejected shape's error must be this much worse
// Real strokes overshoot / overlap their start and end with a pen-lift hook; the
// loop is extracted from the nearest start<->end approach, trimming at most this
// fraction of the path (more than that is a tail, e.g. the stem of an "a").
const LOOP_MAX_TRIM = 0.32;
const LOOP_TAIL_MAX_DEVIATION = 0.12; // median distance of a long trimmed tail from the loop, in loop radii
const LOOP_TAIL_CHECK_FROM = 0.06; // shorter tails are hooks/flicks and are ignored
const LOOP_START_WINDOW = 0.3;
const LOOP_END_WINDOW = 0.45;
const LOOP_TRIM_PENALTY = 0.03;
/** Closed shapes must be a deliberate size: this multiple of the line `minSize`. */
// Triangle: fitted from three dominant corners + a line fit per side (Phase 2).
// Calibrated on REAL Apple Pencil triangles (mean 0.021-0.036, p90 <= 0.089) vs rounded three-lobed blobs (mean >= 0.053, p90 >= 0.10).
const TRI_MAX_MEAN_ERROR = 0.046;
const TRI_MAX_P90_ERROR = 0.105;
const TRI_MIN_ANGLE = (18 * Math.PI) / 180; // no slivers
const TRI_MIN_SIDE_RATIO = 0.22; // shortest / longest side
const TRI_SIMPLIFY_EPSILONS = [0.03, 0.045, 0.06, 0.08]; // x loop length; first that yields exactly 3 corners wins
const TRI_MIN_CORNER_TURN = (28 * Math.PI) / 180; // a vertex turning less than this is not a corner
const CLOSED_SIZE_FACTOR = 2.5; // ~60 screen pt: bigger than any handwriting, smaller than a deliberate shape
const MIN_ASPECT = 0.15; // thinnest closed shape (short/long)
const ELLIPSE_MIN_ASPECT = 0.3; // rounder than 3:1 only; thinner loops are cursive strokes, not ellipses
const SQUARE_ASPECT = 0.88; // >= this becomes square / circle
const ANGLE_SNAP = (5 * Math.PI) / 180;
const MIN_SIDE_COVERAGE = 0.12;
const MAX_ANGULAR_GAP = (75 * Math.PI) / 180;

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function dedupe(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push({ x: p.x, y: p.y });
  }
  return out;
}

function pathLength(points: readonly Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += dist(points[i - 1], points[i]);
  return total;
}

/** Uniform arc-length resample including both endpoints. */
function resample(points: readonly Pt[], count: number): Pt[] {
  const total = pathLength(points);
  if (total === 0) return points.map((p) => ({ ...p }));
  const step = total / (count - 1);
  const out: Pt[] = [{ ...points[0] }];
  let carried = 0;
  let prev = points[0];
  for (let i = 1; i < points.length; i += 1) {
    let cur = points[i];
    let seg = dist(prev, cur);
    while (carried + seg >= step && out.length < count - 1) {
      const t = (step - carried) / seg;
      const p = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
      out.push(p);
      prev = p;
      seg = dist(prev, cur);
      carried = 0;
    }
    carried += seg;
    prev = cur;
  }
  out.push({ ...points[points.length - 1] });
  return out;
}

/** Douglas-Peucker: drops wiggles smaller than `epsilon` (touch-down notches, lift flicks). */
function simplifyPath(points: readonly Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return [...points];
  const a = points[0];
  const b = points[points.length - 1];
  const len = dist(a, b);
  let index = -1;
  let far = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = len < 1e-9
      ? dist(points[i], a)
      : Math.abs((points[i].x - a.x) * (b.y - a.y) - (points[i].y - a.y) * (b.x - a.x)) / len;
    if (d > far) { far = d; index = i; }
  }
  if (far <= epsilon || index < 0) return [a, b];
  const left = simplifyPath(points.slice(0, index + 1), epsilon);
  const right = simplifyPath(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

/** Turning of the loop after removing sub-`epsilon` wiggles, including the closing turn. */
function simplifiedClosedTurning(loop: readonly Pt[], epsilon: number): number {
  const poly = simplifyPath(loop, epsilon);
  if (poly.length < 3) return 0;
  const heading = (i: number) => Math.atan2(poly[i + 1].y - poly[i].y, poly[i + 1].x - poly[i].x);
  let total = 0;
  for (let i = 1; i < poly.length - 1; i += 1) {
    let d = heading(i) - heading(i - 1);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    total += d;
  }
  let close = heading(0) - heading(poly.length - 2);
  while (close > Math.PI) close -= 2 * Math.PI;
  while (close <= -Math.PI) close += 2 * Math.PI;
  return total + close;
}

function convexHull(points: readonly Pt[]): Pt[] {
  const sorted = [...points].sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

type OrientedBox = { center: Pt; width: number; height: number; angle: number };

/** Minimum-area oriented bounding rectangle (rotating over hull edges). */
function minAreaBox(points: readonly Pt[]): OrientedBox {
  const hull = convexHull(points);
  let best: (OrientedBox & { area: number }) | null = null;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * c + p.y * s;
      const v = -p.x * s + p.y * c;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const width = maxU - minU;
    const height = maxV - minV;
    const area = width * height;
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { area, width, height, angle, center: { x: cu * c - cv * s, y: cu * s + cv * c } };
    }
  }
  if (!best) return { center: { x: 0, y: 0 }, width: 0, height: 0, angle: 0 };
  return { center: best.center, width: best.width, height: best.height, angle: best.angle };
}

/** Errors are normalized by the shape's mean half-size so they compare across fits. */
function rectangleFit(points: readonly Pt[], box: OrientedBox) {
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  const hw = box.width / 2;
  const hh = box.height / 2;
  const unit = (hw + hh) / 2;
  let sum = 0;
  let peak = 0;
  const errors: number[] = [];
  const sides = [0, 0, 0, 0];
  for (const p of points) {
    const dx = p.x - box.center.x;
    const dy = p.y - box.center.y;
    const u = dx * c + dy * s;
    const v = -dx * s + dy * c;
    const du = Math.abs(u) - hw;
    const dv = Math.abs(v) - hh;
    const d = du <= 0 && dv <= 0 ? Math.min(-du, -dv) : Math.hypot(Math.max(du, 0), Math.max(dv, 0));
    sum += d;
    errors.push(d);
    if (d > peak) peak = d;
    const nearestVertical = Math.abs(du) <= Math.abs(dv);
    sides[nearestVertical ? (u >= 0 ? 0 : 1) : v >= 0 ? 2 : 3] += 1;
  }
  const covered = sides.every((n) => n / points.length >= MIN_SIDE_COVERAGE);
  return { mean: sum / points.length / unit, peak: peak / unit, p90: percentile(errors, 0.9) / unit, covered };
}

type EllipseFrame = { center: Pt; rx: number; ry: number; angle: number };

/** PCA-oriented ellipse (axes from the covariance of an arc-length-uniform ring). */
function ellipseFrame(points: readonly Pt[]): EllipseFrame {
  let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= points.length;
  my /= points.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of points) {
    const u = (p.x - mx) * c + (p.y - my) * s;
    const v = -(p.x - mx) * s + (p.y - my) * c;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  return {
    center: { x: mx + cu * c - cv * s, y: my + cu * s + cv * c },
    rx: (maxU - minU) / 2,
    ry: (maxV - minV) / 2,
    angle,
  };
}

function ellipseFit(points: readonly Pt[], e: EllipseFrame) {
  if (e.rx < 1e-6 || e.ry < 1e-6) return { mean: Infinity, peak: Infinity, p90: Infinity, covered: false };
  const c = Math.cos(e.angle);
  const s = Math.sin(e.angle);
  let sum = 0;
  let peak = 0;
  const errors: number[] = [];
  const angles: number[] = [];
  for (const p of points) {
    const dx = p.x - e.center.x;
    const dy = p.y - e.center.y;
    const u = (dx * c + dy * s) / e.rx;
    const v = (-dx * s + dy * c) / e.ry;
    const err = Math.abs(Math.hypot(u, v) - 1);
    sum += err;
    errors.push(err);
    if (err > peak) peak = err;
    angles.push(Math.atan2(v, u));
  }
  angles.sort((a, b) => a - b);
  let maxGap = 2 * Math.PI - (angles[angles.length - 1] - angles[0]);
  for (let i = 1; i < angles.length; i += 1) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
  return { mean: sum / points.length, peak, p90: percentile(errors, 0.9), covered: maxGap <= MAX_ANGULAR_GAP };
}

/** Snap a near-axis angle to exactly axis-aligned (multiples of 90 degrees). */
function tidyAngle(angle: number): number {
  const quarter = Math.PI / 2;
  const nearest = Math.round(angle / quarter) * quarter;
  return Math.abs(angle - nearest) <= ANGLE_SNAP ? nearest : angle;
}

/** Moving average (endpoints kept) so pen jitter does not inflate path length. */
function smooth(points: readonly Pt[], radius: number): Pt[] {
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return { ...p };
    const lo = Math.max(0, i - radius);
    const hi = Math.min(points.length - 1, i + radius);
    let x = 0, y = 0;
    for (let k = lo; k <= hi; k += 1) { x += points[k].x; y += points[k].y; }
    return { x: x / (hi - lo + 1), y: y / (hi - lo + 1) };
  });
}

function recognizeLine(raw: readonly Pt[], sample: readonly Pt[], _length: number, minSize: number): ShapeSnapResult | null {
  const a = raw[0];
  const b = raw[raw.length - 1];
  const chord = dist(a, b);
  const length = pathLength(smooth(sample, 2));
  if (chord < minSize || chord / length < LINE_MIN_STRAIGHTNESS) return null;
  const ux = (b.x - a.x) / chord;
  const uy = (b.y - a.y) / chord;
  let maxDev = 0;
  // Largest single reversal along the chord: tolerates hand jitter, rejects
  // out-and-back scribbles.
  let backtrack = 0;
  let reached = 0;
  for (const p of sample) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    maxDev = Math.max(maxDev, Math.abs(dx * uy - dy * ux));
    const t = (dx * ux + dy * uy) / chord;
    backtrack = Math.max(backtrack, reached - t);
    reached = Math.max(reached, t);
  }
  const deviation = maxDev / chord;
  if (deviation > LINE_MAX_DEVIATION || backtrack > LINE_MAX_BACKTRACK) return null;
  const confidence = clamp01(1 - (deviation / LINE_MAX_DEVIATION) * 0.5 - ((1 - chord / length) / (1 - LINE_MIN_STRAIGHTNESS)) * 0.5);
  return { type: 'line', confidence, a: { ...a }, b: { ...b } };
}

/** Total-least-squares line through points: a point on it and a unit direction. */
function fitLine(points: readonly Pt[]): { p: Pt; d: Pt } | null {
  if (points.length < 4) return null;
  let mx = 0, my = 0;
  for (const q of points) { mx += q.x; my += q.y; }
  mx /= points.length; my /= points.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const q of points) { sxx += (q.x - mx) ** 2; syy += (q.y - my) ** 2; sxy += (q.x - mx) * (q.y - my); }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: mx, y: my }, d: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function intersectLines(a: { p: Pt; d: Pt }, b: { p: Pt; d: Pt }): Pt | null {
  const det = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(det) < 1e-6) return null;
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / det;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}

function pointSegmentDistance(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { d: Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)), t };
}

/** Corners of the simplified closed loop; near-collinear vertices (e.g. where the stroke happened to start) are dropped. */
function closedCorners(loop: readonly Pt[], epsilon: number): Pt[] {
  const a = loop[0];
  let k = 0;
  for (let i = 1; i < loop.length; i += 1) if (dist(loop[i], a) > dist(loop[k], a)) k = i;
  const left = simplifyPath(loop.slice(0, k + 1), epsilon);
  const right = simplifyPath(loop.slice(k), epsilon);
  const poly = left.concat(right.slice(1));
  if (poly.length > 3 && dist(poly[poly.length - 1], poly[0]) < epsilon * 2) poly.pop();
  const turn = (i: number) => {
    const p = poly[(i + poly.length - 1) % poly.length];
    const q = poly[i];
    const r = poly[(i + 1) % poly.length];
    let d = Math.atan2(r.y - q.y, r.x - q.x) - Math.atan2(q.y - p.y, q.x - p.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  };
  while (poly.length > 3) {
    let weakest = 0;
    for (let i = 1; i < poly.length; i += 1) if (turn(i) < turn(weakest)) weakest = i;
    if (turn(weakest) >= TRI_MIN_CORNER_TURN) break;
    poly.splice(weakest, 1);
  }
  return poly;
}

type TriangleFit = { vertices: [Pt, Pt, Pt]; mean: number; p90: number; minAngle: number; sideRatio: number };

function fitTriangle(loop: readonly Pt[]): TriangleFit | null {
  const loopLength = pathLength(loop);
  let corners: Pt[] | null = null;
  for (const e of TRI_SIMPLIFY_EPSILONS) {
    const poly = closedCorners(loop, loopLength * e);
    if (poly.length === 3) { corners = poly; break; }
  }
  if (!corners) return null;
  // Every corner must be a real turn, not a stray vertex of a rounder shape.
  const vertices: [Pt, Pt, Pt] = [corners[0], corners[1], corners[2]];

  // Refine: one least-squares line per side, from the loop points that belong to that side's middle.
  const sides = [0, 1, 2].map((i) => [vertices[i], vertices[(i + 1) % 3]] as const);
  const lines = sides.map(([a, b]) => {
    const own: Pt[] = [];
    for (const q of loop) {
      let bestSide = -1;
      let bestDistance = Infinity;
      let bestT = 0;
      sides.forEach(([sa, sb], si) => {
        const r = pointSegmentDistance(q, sa, sb);
        if (r.d < bestDistance) { bestDistance = r.d; bestSide = si; bestT = r.t; }
      });
      if (bestSide >= 0 && sides[bestSide][0] === a && sides[bestSide][1] === b && bestT > 0.12 && bestT < 0.88) own.push(q);
    }
    return fitLine(own);
  });
  const refined = [0, 1, 2].map((i) => {
    const prev = lines[(i + 2) % 3];
    const cur = lines[i];
    const hit = prev && cur ? intersectLines(prev, cur) : null;
    return hit && dist(hit, vertices[i]) < loopLength * 0.12 ? hit : vertices[i];
  }) as [Pt, Pt, Pt];

  const boundary = [refined[0], refined[1], refined[2], refined[0]];
  const perimeter = dist(refined[0], refined[1]) + dist(refined[1], refined[2]) + dist(refined[2], refined[0]);
  if (perimeter <= 0) return null;
  const unit = perimeter / 7;
  const errors = loop.map((q) => Math.min(
    pointSegmentDistance(q, boundary[0], boundary[1]).d,
    pointSegmentDistance(q, boundary[1], boundary[2]).d,
    pointSegmentDistance(q, boundary[2], boundary[3]).d,
  ) / unit);
  const sideLengths = [dist(refined[0], refined[1]), dist(refined[1], refined[2]), dist(refined[2], refined[0])];
  const angleAt = (i: number) => {
    const p = refined[(i + 2) % 3], q = refined[i], r = refined[(i + 1) % 3];
    const ux = p.x - q.x, uy = p.y - q.y, vx = r.x - q.x, vy = r.y - q.y;
    return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1))));
  };
  return {
    vertices: refined,
    mean: errors.reduce((a, b) => a + b, 0) / errors.length,
    p90: percentile(errors, 0.9),
    minAngle: Math.min(angleAt(0), angleAt(1), angleAt(2)),
    sideRatio: Math.min(...sideLengths) / Math.max(...sideLengths),
  };
}

/**
 * Real strokes rarely end exactly where they began: the pen overshoots the start,
 * flicks on lift, or hooks at touch-down. The loop is the stretch between the
 * best start-region / end-region nearest approach; the rest is a tail to ignore.
 */
type LoopResult = { loop: Pt[]; gapRatio: number; trimmed: number } | { fail: string };

function extractLoop(sample: readonly Pt[]): LoopResult {
  const n = sample.length;
  const step = pathLength(sample) / (n - 1);
  const iMax = Math.floor(LOOP_START_WINDOW * n);
  const jMin = Math.ceil((1 - LOOP_END_WINDOW) * n);
  let best: { i: number; j: number; cost: number } | null = null;
  for (let i = 0; i <= iMax; i += 1) {
    for (let j = Math.max(jMin, i + Math.floor(n / 2)); j < n; j += 1) {
      const cost = dist(sample[i], sample[j]) + LOOP_TRIM_PENALTY * step * (i + (n - 1 - j));
      if (!best || cost < best.cost) best = { i, j, cost };
    }
  }
  if (!best) return { fail: 'no-candidate' };
  const loop = resample(sample.slice(best.i, best.j + 1), RESAMPLE_COUNT);
  const loopLength = pathLength(loop);
  if (loopLength === 0) return { fail: 'zero-length' };
  const gapRatio = dist(loop[0], loop[loop.length - 1]) / loopLength;
  const trimmed = (best.i + (n - 1 - best.j)) / (n - 1);
  if (gapRatio > CLOSED_MAX_GAP) return { fail: `open(gap=${gapRatio.toFixed(3)})` };
  if (trimmed > LOOP_MAX_TRIM) return { fail: `tail-too-long(${trimmed.toFixed(2)})` };
  // An overshoot/overlap tail runs ALONG the loop; a stem (the "a" in handwriting) leaves it.
  // Short tails are pen-lift hooks/flicks and are simply ignored; only a LONGER tail must hug
  // the loop, judged by its median distance so a stray flick cannot dominate.
  if (trimmed > LOOP_TAIL_CHECK_FROM) {
    const tail = sample.slice(0, best.i).concat(sample.slice(best.j + 1));
    let cx = 0, cy = 0;
    for (const p of loop) { cx += p.x; cy += p.y; }
    cx /= loop.length; cy /= loop.length;
    let unit = 0;
    for (const p of loop) unit += Math.hypot(p.x - cx, p.y - cy);
    unit /= loop.length;
    const away = tail.map((q) => loop.reduce((nearest, p) => Math.min(nearest, dist(q, p)), Infinity));
    const deviation = unit > 0 ? percentile(away, 0.5) / unit : 0;
    if (deviation > LOOP_TAIL_MAX_DEVIATION) return { fail: `tail-leaves-loop(${deviation.toFixed(3)})` };
  }
  return { loop, gapRatio, trimmed };
}

export type ShapeSnapDiagnostics = {
  result: ShapeSnapResult | null;
  /** Every gate that rejected the stroke (empty when it snapped). */
  reasons: string[];
  metrics: Record<string, number | boolean | string>;
};

/** Same decision as `recognizeShape`, plus exactly which gates fired (for calibration logs). */
export function recognizeShapeDetailed(input: readonly Pt[], options: ShapeSnapOptions = {}): ShapeSnapDiagnostics {
  const reasons: string[] = [];
  const metrics: ShapeSnapDiagnostics['metrics'] = {};
  const reject = (reason: string): ShapeSnapDiagnostics => { reasons.push(reason); return { result: null, reasons, metrics }; };
  const minSize = options.minSize ?? 24;
  const minClosed = options.minClosedSize ?? minSize * CLOSED_SIZE_FACTOR;
  const raw = dedupe(input);
  metrics.points = raw.length;
  if (raw.length < MIN_POINTS) return reject('too-few-points');
  const length = pathLength(raw);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of raw) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  metrics.length = length; metrics.bboxW = maxX - minX; metrics.bboxH = maxY - minY;
  metrics.rawGapRatio = dist(raw[0], raw[raw.length - 1]) / length;
  if (diag < minSize || length < minSize) return reject('too-small');

  const sample = resample(raw, RESAMPLE_COUNT);
  const extracted = extractLoop(sample);
  if ('fail' in extracted) {
    const line = recognizeLine(raw, sample, length, minSize);
    if (line) return { result: line, reasons, metrics };
    metrics.loopFailure = extracted.fail;
    return reject(`no-closed-loop(${extracted.fail})-and-not-a-line`);
  }
  const loop = extracted.loop;
  metrics.loopGapRatio = extracted.gapRatio; metrics.trimmed = extracted.trimmed;
  if (diag < minClosed) return reject(`closed-too-small(${diag.toFixed(1)}<${minClosed.toFixed(1)})`);

  // Simplified first so touch-down notches and lift flicks (real Pencil hooks, ~1-2% of the
  // perimeter) do not count as turning; the corners and curvature of the shape survive.
  const turning = Math.abs(simplifiedClosedTurning(smooth(loop, 1), pathLength(loop) * SIMPLIFY_EPSILON));
  metrics.turning = turning;
  if (Math.abs(turning - TURNING_TARGET) > TURNING_TOLERANCE) return reject(`turning(${turning.toFixed(2)})`);

  const box = minAreaBox(loop);
  const long = Math.max(box.width, box.height);
  const short = Math.min(box.width, box.height);
  metrics.aspect = short / long;
  if (long < minClosed * 0.75) return reject('closed-box-too-small');
  if (short / long < MIN_ASPECT) return reject(`aspect(${(short / long).toFixed(2)})`);

  const rect = rectangleFit(loop, box);
  const ellipse = ellipseFrame(loop);
  const frame = ellipseFit(loop, ellipse);
  metrics.rectMean = rect.mean; metrics.rectP90 = rect.p90; metrics.rectPeak = rect.peak; metrics.rectCovered = rect.covered;
  metrics.ellMean = frame.mean; metrics.ellP90 = frame.p90; metrics.ellPeak = frame.peak; metrics.ellCovered = frame.covered;
  metrics.ellipseAspect = Math.min(ellipse.rx, ellipse.ry) / Math.max(ellipse.rx, ellipse.ry);
  const rectOk = rect.covered && rect.mean <= RECT_MAX_MEAN_ERROR && rect.p90 <= RECT_MAX_P90_ERROR;
  const ellipseOk = frame.covered && frame.mean <= ELLIPSE_MAX_MEAN_ERROR && frame.p90 <= ELLIPSE_MAX_P90_ERROR;
  const tri = fitTriangle(loop);
  const triOk = !!tri && tri.mean <= TRI_MAX_MEAN_ERROR && tri.p90 <= TRI_MAX_P90_ERROR && tri.minAngle >= TRI_MIN_ANGLE && tri.sideRatio >= TRI_MIN_SIDE_RATIO;
  if (tri) { metrics.triMean = tri.mean; metrics.triP90 = tri.p90; metrics.triMinAngle = tri.minAngle; metrics.triSideRatio = tri.sideRatio; }
  if (!rectOk) reasons.push(!rect.covered ? 'rect:sides-not-covered' : rect.mean > RECT_MAX_MEAN_ERROR ? `rect:mean(${rect.mean.toFixed(3)})` : `rect:p90(${rect.p90.toFixed(3)})`);
  if (!ellipseOk) reasons.push(!frame.covered ? 'ellipse:angular-gap' : frame.mean > ELLIPSE_MAX_MEAN_ERROR ? `ellipse:mean(${frame.mean.toFixed(3)})` : `ellipse:p90(${frame.p90.toFixed(3)})`);
  if (!triOk) reasons.push(!tri ? 'triangle:not-three-corners' : tri.mean > TRI_MAX_MEAN_ERROR ? `triangle:mean(${tri.mean.toFixed(3)})` : tri.p90 > TRI_MAX_P90_ERROR ? `triangle:p90(${tri.p90.toFixed(3)})` : tri.minAngle < TRI_MIN_ANGLE ? `triangle:sliver(${(tri.minAngle * 57.3).toFixed(0)}deg)` : `triangle:side-ratio(${tri.sideRatio.toFixed(2)})`);

  // A winner must beat every other candidate's error by AMBIGUITY_RATIO (otherwise: no snap).
  const triMean = tri ? tri.mean : Infinity;
  if (triOk && tri && triMean * AMBIGUITY_RATIO <= rect.mean && triMean * AMBIGUITY_RATIO <= frame.mean) {
    reasons.length = 0;
    return { result: { type: 'triangle', confidence: clamp01(1 - triMean / TRI_MAX_MEAN_ERROR), vertices: tri.vertices }, reasons, metrics };
  }
  if (rectOk && rect.mean * AMBIGUITY_RATIO <= frame.mean && rect.mean * AMBIGUITY_RATIO <= triMean) {
    const aspect = short / long;
    const angle = tidyAngle(box.angle);
    const confidence = clamp01(1 - rect.mean / RECT_MAX_MEAN_ERROR);
    reasons.length = 0;
    if (aspect >= SQUARE_ASPECT) {
      const side = Math.sqrt(box.width * box.height);
      return { result: { type: 'square', confidence, center: box.center, width: side, height: side, angle }, reasons, metrics };
    }
    return { result: { type: 'rectangle', confidence, center: box.center, width: box.width, height: box.height, angle }, reasons, metrics };
  }
  if (ellipseOk && frame.mean * AMBIGUITY_RATIO <= rect.mean && frame.mean * AMBIGUITY_RATIO <= triMean) {
    const rMax = Math.max(ellipse.rx, ellipse.ry);
    const rMin = Math.min(ellipse.rx, ellipse.ry);
    if (rMin / rMax < ELLIPSE_MIN_ASPECT) return reject(`ellipse-too-flat(${(rMin / rMax).toFixed(2)})`);
    const confidence = clamp01(1 - frame.mean / ELLIPSE_MAX_MEAN_ERROR);
    reasons.length = 0;
    if (rMin / rMax >= SQUARE_ASPECT) {
      return { result: { type: 'circle', confidence, center: ellipse.center, radius: Math.sqrt(ellipse.rx * ellipse.ry) }, reasons, metrics };
    }
    return { result: { type: 'ellipse', confidence, center: ellipse.center, rx: ellipse.rx, ry: ellipse.ry, angle: tidyAngle(ellipse.angle) }, reasons, metrics };
  }
  if (rectOk || ellipseOk || triOk) reasons.push(`ambiguous(rect=${rect.mean.toFixed(3)},ellipse=${frame.mean.toFixed(3)},triangle=${triMean.toFixed(3)})`);
  return { result: null, reasons, metrics };
}

/** Returns the recognized clean shape, or `null` (do nothing) when not confident. */
export function recognizeShape(input: readonly Pt[], options: ShapeSnapOptions = {}): ShapeSnapResult | null {
  return recognizeShapeDetailed(input, options).result;
}
