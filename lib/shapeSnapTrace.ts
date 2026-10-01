/**
 * DEV-only capture of every hold-triggered Shape Snap attempt, so recognizer
 * calibration uses REAL Apple Pencil traces instead of synthetic fixtures.
 *
 * One JSON line per attempt is appended to `Library/Caches/shape-snap-attempts.jsonl`
 * with the raw workspace-unit points, the recognizer decision, the numbers the gates
 * decided on and the exact rejection reasons. Recording never happens per sample: it
 * runs once when a hold fires (after recognition), buffers in memory and writes on a
 * 1.5 s debounce, so it cannot add latency to handwriting. No-op outside the Dev bundle.
 */
import Constants from 'expo-constants';

import type { Pt, ShapeSnapDiagnostics } from '@/lib/shapeSnap';

const DEV_BUNDLE_ID = 'com.aydenz.youmilensipad.dev';
const MAX_ATTEMPTS = 60;
const MAX_POINTS = 600;

export const SHAPE_SNAP_TRACE_ENABLED = Constants.expoConfig?.ios?.bundleIdentifier === DEV_BUNDLE_ID;

const attempts: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushSoon() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      const FileSystemNS = require('expo-file-system') as typeof import('expo-file-system');
      const file = new FileSystemNS.File(FileSystemNS.Paths.cache, 'shape-snap-attempts.jsonl');
      if (!file.exists) file.create({ intermediates: true, overwrite: true });
      file.write(attempts.join('\n') + '\n');
    } catch {
      // Diagnostics must never affect the app.
    }
  }, 1500);
}

/** How many trailing samples sit within `tolerance` of the final point (the stationary hold cluster). */
function endpointCluster(points: readonly Pt[], tolerance: number): number {
  const last = points[points.length - 1];
  let count = 0;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (Math.hypot(points[i].x - last.x, points[i].y - last.y) > tolerance) break;
    count += 1;
  }
  return count;
}

export function recordShapeSnapAttempt(args: {
  workspace: 'notebook' | 'course-material';
  points: readonly Pt[];
  diagnostics: ShapeSnapDiagnostics;
  /** Screen points per workspace unit (zoom / PDF scale). */
  scale: number;
  holdMs: number;
  tolerancePt: number;
}) {
  if (!SHAPE_SNAP_TRACE_ENABLED) return;
  const { points, diagnostics } = args;
  const step = points.length > MAX_POINTS ? Math.ceil(points.length / MAX_POINTS) : 1;
  const kept: [number, number][] = [];
  for (let i = 0; i < points.length; i += step) kept.push([Math.round(points[i].x * 100) / 100, Math.round(points[i].y * 100) / 100]);
  const record = {
    at: new Date().toISOString(),
    workspace: args.workspace,
    unit: args.workspace === 'notebook' ? 'canvas' : 'pdf-page',
    scale: args.scale,
    holdMs: args.holdMs,
    pointCount: points.length,
    downsampledBy: step,
    endpointClusterSamples: endpointCluster(points, args.tolerancePt / (args.scale || 1)),
    result: diagnostics.result ? diagnostics.result.type : 'none',
    confidence: diagnostics.result ? Math.round(diagnostics.result.confidence * 1000) / 1000 : null,
    reasons: diagnostics.reasons,
    metrics: diagnostics.metrics,
    points: kept,
  };
  attempts.push(JSON.stringify(record));
  if (attempts.length > MAX_ATTEMPTS) attempts.splice(0, attempts.length - MAX_ATTEMPTS);
  flushSoon();
}
