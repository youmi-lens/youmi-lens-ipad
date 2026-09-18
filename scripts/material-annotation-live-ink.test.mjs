/**
 * Material annotation pen performance/regression guard.
 *
 * Root cause (see components/MaterialAnnotationOverlay.tsx's doc comment):
 * the in-progress stroke's points used to live in the PARENT component's own
 * React state, so every Apple Pencil sample re-rendered the whole overlay —
 * including {children} (the embedded PDF) and a fresh .filter() over every
 * already-committed stroke on the page — which is exactly the class of bug
 * this session already found and fixed once in lib/liveCaptions.tsx. The fix
 * mirrors NotebookCanvas's proven ActiveInkHost pattern: the live stroke now
 * lives in its own small, separately-memoized sub-component with local
 * state, so a Pencil sample only ever re-renders that one small overlay.
 *
 * These are structural source-level guards (this is a native drawing
 * component; tactile "feel" can only be judged on a real iPad + Apple
 * Pencil — see the task's own runtime-validation requirement) plus pure
 * behavioral checks on the parts that ARE testable without React Native.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const overlay = read('../components/MaterialAnnotationOverlay.tsx');
const notebook = read('../components/NotebookCanvas.tsx');
const materialScreen = read('../app/lecture-material/[lectureId]/[materialId].tsx');

console.log('Pen width parity with Notebook (the "too much ink" fix)');

check('Material annotation PEN_WIDTHS exactly match NotebookCanvas PEN_WIDTHS — no drift', () => {
  const materialWidths = materialScreen.match(/const PEN_WIDTHS = \[[\s\S]*?\];/)[0];
  assert.match(materialWidths, /value: 2, dot: 7/, 'Thin must match Notebook (2, not the old 2.4)');
  assert.match(materialWidths, /value: 3\.5, dot: 11/, 'Medium (default) must match Notebook (3.5, not the old 4)');
  assert.match(materialWidths, /value: 6, dot: 16/, 'Thick must match Notebook (6, not the old 6.5)');

  const notebookWidths = notebook.match(/const PEN_WIDTHS: \{[\s\S]*?\];/)[0];
  const extractValues = (src) => [...src.matchAll(/value:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(extractValues(materialWidths), extractValues(notebookWidths), 'pen width VALUES are identical between the two tools, tier for tier');
});

check('the width fix is scoped to the pen only — highlighter/eraser sizes are untouched (not part of the reported complaint)', () => {
  assert.match(materialScreen, /const HIGHLIGHTER_WIDTHS = \[\s*\{ key: 'Narrow', value: 12, dot: 8 \}/);
  assert.match(materialScreen, /const ERASER_SIZES = \[\s*\{ key: 'Small', value: 16, dot: 8 \}/);
});

console.log('Live-ink render isolation (the actual fix)');

check('the live stroke no longer lives in top-level component state', () => {
  assert.doesNotMatch(overlay, /const \[currentPoints, setCurrentPoints\]/, 'currentPoints must not be re-introduced as parent state — that is the regression this fix closes');
});

check('a dedicated, memoized ActiveAnnotationInkHost owns the live stroke, mirroring NotebookCanvas', () => {
  assert.match(overlay, /const ActiveAnnotationInkHost = memo\(/, 'live-ink host exists and is memoized');
  assert.match(overlay, /useImperativeHandle\(/, 'exposes an imperative begin/append/clear/getPoints handle, like ActiveInkHost');
  assert.match(overlay, /begin\(point\)\s*\{/);
  assert.match(overlay, /append\(point\)\s*\{/);
  assert.match(overlay, /clear\(\)\s*\{/);
  assert.match(overlay, /getPoints\(\)\s*\{/);
});

check('the gesture handlers drive the live-ink ref, never a parent state setter, per point', () => {
  const moveHandler = overlay.slice(overlay.indexOf('.onTouchesMove('), overlay.indexOf('.onTouchesUp('));
  assert.match(moveHandler, /addPoint\(touch\.x, touch\.y\)/, 'move still routes through addPoint');
  const addPointFn = overlay.slice(overlay.indexOf('const addPoint = useCallback'), overlay.indexOf('const eraseAt = useCallback'));
  assert.match(addPointFn, /activeInkRef\.current\?\.append\(/, 'addPoint calls the ref-based append, not a state setter');
  assert.doesNotMatch(addPointFn, /setCurrentPoints/, 'addPoint must never call a parent state setter (that is the re-render-per-point regression)');
});

check('committed strokes are memoized, with only a local erased-id suppression layer during an erase gesture', () => {
  assert.match(overlay, /const visibleStrokes = useMemo\(/, 'visual suppression is derived once per erase acknowledgement, not per Pencil point');
  assert.match(overlay, /strokes\.filter\(\(stroke\) => !suppressedEraseIds\.has\(stroke\.id\)\)/);
  assert.match(overlay, /const highlighterStrokes = useMemo\(\(\) => visibleStrokes\.filter/, 'highlighter partition remains memoized');
  assert.match(overlay, /const penStrokes = useMemo\(\(\) => visibleStrokes\.filter/, 'pen partition remains memoized');
});

console.log('\nSaved-stroke compatibility (must not change persisted shape)');

check('a committed stroke still has exactly the same fields existing saved annotations already have', () => {
  const commitFn = overlay.slice(overlay.indexOf('const commitStroke = useCallback'), overlay.indexOf('const finishStylusGesture'));
  assert.match(commitFn, /id: makeStrokeId\(\)/);
  assert.match(commitFn, /tool,/);
  assert.match(commitFn, /color: tool === 'highlighter'/);
  assert.match(commitFn, /width: tool === 'highlighter'/);
  assert.match(commitFn, /opacity: tool === 'highlighter' \? 0\.34 : 1/);
  assert.match(commitFn, /points,/);
  assert.match(commitFn, /createdAt: new Date\(\)\.toISOString\(\)/);
});

check('point-distance filtering (MIN_POINT_DISTANCE) is unchanged — same constant, same 2D-distance rule as before and as Notebook', () => {
  assert.match(overlay, /const MIN_POINT_DISTANCE = 1\.8;/);
  assert.match(overlay, /Math\.hypot\(last\.x - point\.x, last\.y - point\.y\) < MIN_POINT_DISTANCE/);
});

console.log('\nNotebook — unaffected by this change');

check("NotebookCanvas's own ActiveInkHost pattern is untouched (the model this fix mirrors, not modifies)", () => {
  assert.match(notebook, /const ActiveInkHost = memo\(/);
  assert.match(notebook, /Live ink only\. Owns its own React state so each Pencil sample/);
});

console.log(`\nmaterial-annotation-live-ink: ${passed} checks passed`);
