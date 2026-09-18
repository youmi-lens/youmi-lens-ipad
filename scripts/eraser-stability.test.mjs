/**
 * Regression guards for the physical Pencil eraser incident.
 *
 * Geometry assertions are executable; source assertions protect the native
 * batching/tombstone contract where this repository has no Swift XCTest host.
 * They do not claim real-device latency, which remains a Pencil retest.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { strokeNearSweep, sweepMayReachBounds } from '../lib/inkEraser.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const notebook = read('../components/NotebookCanvas.tsx');
const fallback = read('../components/MaterialAnnotationOverlay.tsx');
const native = read('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
const materialScreen = read('../app/lecture-material/[lectureId]/[materialId].tsx');

const vertical = (id, x) => ({ id, width: 2, points: [{ x, y: 20 }, { x, y: 80 }] });

console.log('Swept eraser geometry');

check('a stationary eraser removes a directly touched stroke', () => {
  assert.equal(strokeNearSweep(vertical('touch', 50), { x: 50, y: 40 }, { x: 50, y: 40 }, 6), true);
});

check('a fast sweep crosses and removes ink between sampled endpoints', () => {
  assert.equal(strokeNearSweep(vertical('gap', 50), { x: 0, y: 50 }, { x: 100, y: 50 }, 4), true);
});

check('nearby non-overlapping ink stays untouched', () => {
  assert.equal(strokeNearSweep(vertical('nearby', 50), { x: 0, y: 0 }, { x: 30, y: 0 }, 4), false);
});

check('dense overlapping strokes are independently eligible in one sweep', () => {
  const from = { x: 0, y: 50 };
  const to = { x: 100, y: 50 };
  assert.equal(strokeNearSweep(vertical('a', 45), from, to, 4), true);
  assert.equal(strokeNearSweep(vertical('b', 50), from, to, 4), true);
  assert.equal(strokeNearSweep(vertical('c', 55), from, to, 4), true);
});

check('bounds prefilter rejects distant strokes before segment work', () => {
  assert.equal(sweepMayReachBounds({ x: 0, y: 0 }, { x: 10, y: 0 }, { minX: 40, minY: 40, maxX: 50, maxY: 50 }, 4), false);
});

console.log('Notebook immediate visual suppression and durable finish');

check('Notebook uses Set-based suppression and a sweep hit test, not per-id array scans', () => {
  assert.match(notebook, /const erasedIdsRef = useRef<Set<string>>/);
  assert.match(notebook, /strokeNearSweep\(stroke, from, to, eraserRadiusRef\.current\)/);
  assert.match(notebook, /sweepMayReachBounds\(from, to, bounds, threshold\)/);
  assert.doesNotMatch(notebook, /erasedIds\.includes\(/);
});

check('repeated passes are idempotent after a stroke is accepted for erasure', () => {
  assert.match(notebook, /if \(erasedIdsRef\.current\.has\(stroke\.id\)\) continue/);
  assert.match(fallback, /if \(erasedIdsRef\.current\.has\(stroke\.id\)\) continue/);
});

check('Notebook commits one filtered parent snapshot only at gesture end and keeps visual suppression until acknowledgement', () => {
  const eraseFn = notebook.slice(notebook.indexOf('const eraseAt = useCallback('), notebook.indexOf('const commitErase = useCallback('));
  const commitFn = notebook.slice(notebook.indexOf('const commitErase = useCallback('), notebook.indexOf('/**\n   * End the live stroke'));
  assert.doesNotMatch(eraseFn, /onStrokesChangeRef\.current/);
  assert.match(commitFn, /onStrokesChangeRef\.current\(strokesRef\.current\.filter/);
  assert.match(commitFn, /Do NOT clear visual suppression here/);
});

check('Notebook coalesces decorative cursor rendering to an animation frame', () => {
  assert.match(notebook, /const publishEraseCursor = useCallback/);
  assert.match(notebook, /eraseCursorFrameRef\.current = requestAnimationFrame/);
});

console.log('Course Material native and fallback protection');

check('native PDF eraser batches changed pages and emits no JS replacement from its changed-move case', () => {
  const changedCase = native.slice(native.indexOf('case .changed:'), native.indexOf('case .ended:'));
  assert.match(changedCase, /annotationOverlay\.continueErase/);
  assert.doesNotMatch(changedCase, /emitPageReplacement/);
  assert.match(native, /func endErase\(\) -> \[\(pageNumber: Int, strokes: \[AnnotationStroke\]\)\]/);
});

check('native PDF eraser applies swept segment hit-testing and keeps deletion tombstones against stale props', () => {
  assert.match(native, /distanceBetweenSegments\(start, end, stroke\.points\[i\], stroke\.points\[i \+ 1\]\)/);
  assert.match(native, /pendingLocalEraseIds\.formUnion\(removedIds\)/);
  assert.match(native, /filter \{ !pendingLocalEraseIds\.contains\(\$0\.id\) \}/);
});

check('native PDF eraser does not project a cross-page sweep into another page', () => {
  const eraseSweep = native.slice(native.indexOf('private func eraseSweep('), native.indexOf('/// The JS-initiated counterpart'));
  assert.match(eraseSweep, /let usesSinglePoint = startPageNumber != endPageNumber/);
  assert.match(eraseSweep, /let localEnd = usesSinglePoint \? pageStart : pageEnd/);
});

check('Undo clears an erase tombstone before its restored page snapshot is saved', () => {
  assert.match(native, /func markStrokeRestorationIntent\(ids: \[String\]\)/);
  assert.match(materialScreen, /markStrokeRestorationIntent\(restoredIds\)/);
});

check('both surfaces retain their existing durable write boundary rather than persisting each pointer move', () => {
  const notebookErase = notebook.slice(notebook.indexOf('const eraseAt = useCallback('), notebook.indexOf('const commitErase = useCallback('));
  const materialErase = fallback.slice(fallback.indexOf('const eraseAt = useCallback('), fallback.indexOf('const commitStroke = useCallback('));
  assert.doesNotMatch(notebookErase, /onStrokesChangeRef\.current/);
  assert.doesNotMatch(materialErase, /onEraseStrokeIds/);
  assert.match(materialScreen, /replaceMaterialPageAnnotationStrokesForMaterial\(mid, page, nextStrokes/);
});

check('JS Material fallback has the same immediate suppression/swept/batched contract', () => {
  assert.match(fallback, /const erasedIdsRef = useRef<Set<string>>/);
  assert.match(fallback, /strokeNearSweep\(stroke, from, to, eraserRadiusRef\.current\)/);
  const eraseFn = fallback.slice(fallback.indexOf('const eraseAt = useCallback('), fallback.indexOf('const commitStroke = useCallback('));
  assert.doesNotMatch(eraseFn, /onEraseStrokeIds/);
  assert.match(fallback, /if \(erasedIds\.length > 0\) onEraseStrokeIdsRef\.current\(erasedIds\)/);
  assert.match(fallback, /strokes\.filter\(\(stroke\) => !suppressedEraseIds\.has\(stroke\.id\)\)/);
});

console.log(`\neraser-stability: ${passed} checks passed`);
