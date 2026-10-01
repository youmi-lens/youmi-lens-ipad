/**
 * The Dev-only Shape Snap attempt recorder must be inert in production and can never add
 * handwriting latency: it runs once per HOLD (after recognition), buffers in memory and
 * writes on a debounce, and never per sample.
 * Run: node --experimental-strip-types scripts/shape-snap-trace.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const trace = read('lib/shapeSnapTrace.ts');
const canvas = read('components/NotebookCanvas.tsx');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');

check('the recorder is a no-op outside the Dev bundle', () => {
  assert.match(trace, /export const SHAPE_SNAP_TRACE_ENABLED = Constants\.expoConfig\?\.ios\?\.bundleIdentifier === DEV_BUNDLE_ID/);
  assert.match(trace, /if \(!SHAPE_SNAP_TRACE_ENABLED\) return;/);
});
check('file IO is debounced 1.5 s and buffered; nothing is written synchronously in the record path', () => {
  const record = trace.slice(trace.indexOf('export function recordShapeSnapAttempt'));
  assert.doesNotMatch(record, /\.write\(|File\(|writeAsString/);
  assert.match(trace, /setTimeout\(\(\) => \{[\s\S]*shape-snap-attempts\.jsonl[\s\S]*\}, 1500\)/);
  assert.match(trace, /MAX_ATTEMPTS = 60/);
  assert.match(trace, /MAX_POINTS = 600/);
});
check('it logs the raw points, the decision, the gate metrics, exact reasons and the hold-endpoint cluster size', () => {
  for (const field of ['points: kept', 'reasons: diagnostics.reasons', 'metrics: diagnostics.metrics', 'endpointClusterSamples', "result: diagnostics.result ? diagnostics.result.type : 'none'", 'workspace: args.workspace']) assert.ok(trace.includes(field), field);
});
check('it is only called from the hold path of each workspace, guarded by the Dev flag (never per sample)', () => {
  for (const source of [canvas, screen]) {
    assert.equal((source.match(/recordShapeSnapAttempt\(/g) ?? []).length, 1);
    assert.match(source, /if \(SHAPE_SNAP_TRACE_ENABLED\) \{\s*recordShapeSnapAttempt\(/);
  }
  const holdFire = canvas.slice(canvas.indexOf('const shapeHoldFire = useCallback'), canvas.indexOf('shapeHoldFireRef.current = shapeHoldFire'));
  assert.ok(holdFire.includes('recordShapeSnapAttempt('));
  const sample = canvas.slice(canvas.indexOf('const noteShapeHoldSample'), canvas.indexOf('const noteShapeHoldSample') + 600);
  assert.doesNotMatch(sample, /recordShapeSnapAttempt/);
});
console.log('\nshape-snap-trace: all checks passed');
