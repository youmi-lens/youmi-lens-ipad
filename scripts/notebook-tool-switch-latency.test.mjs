/** Execute the production `changeMode` callback without mounting React Native.
 * Run: node --test scripts/notebook-tool-switch-latency.test.mjs
 *
 * Root cause (Phase 2 audit): `changeMode` unconditionally replaced
 * `selectedIds` (a Set) and `lassoPoints` (an array) with brand-new empty
 * values on every switch away from Select — even when both were already
 * empty. `selectedIds` is a dependency of the stroke-render `useMemo` in
 * `components/NotebookCanvas.tsx`, so a fresh-but-still-empty Set reference
 * invalidated that memo and re-filtered/re-mapped every stroke on the page on
 * every ordinary Pen/Eraser/Highlighter/Text switch. The fix only replaces
 * these refs/state when they actually hold something to clear.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { makeDispatchSelection } from './fixtures/selection-dispatch-harness.mjs';

const source = readFileSync(new URL('../components/NotebookCanvas.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('NotebookCanvas.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['changeMode']);
const declarations = [];
function visit(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && names.has(node.name?.getText(parsed))) {
    const name = node.name.getText(parsed);
    declarations.push({ name, code: ts.isVariableDeclaration(node) ? `const ${node.getText(parsed)};` : node.getText(parsed) });
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.deepEqual(new Set(declarations.map(({ name }) => name)), names, 'changeMode must come from production source');
const changeModeCode = ts.transpileModule(declarations.map(({ code }) => code).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness(initial) {
  const ref = current => ({ current });
  const calls = { setTemporaryEraser: [], setSelectedIds: [], setLassoPoints: [], setMode: [] };
  const modeRef = ref(initial.mode ?? 'write');
  const temporaryEraserRef = ref(false);
  const previousDrawingToolRef = ref('write');
  const selectedIdsRef = ref(initial.selectedIds ?? new Set());
  const lassoPointsRef = ref(initial.lassoPoints ?? []);
  const environment = {
    useCallback: callback => callback,
    modeRef, temporaryEraserRef, previousDrawingToolRef, selectedIdsRef, lassoPointsRef,
    setTemporaryEraser: (v) => { calls.setTemporaryEraser.push(v); },
    setSelectedIds: (v) => { calls.setSelectedIds.push(v); selectedIdsRef.current = v; },
    setLassoPoints: (v) => { calls.setLassoPoints.push(v); lassoPointsRef.current = v; },
    setMode: (v) => { calls.setMode.push(v); },
  };
  // Production changeMode now clears selection through the shared state machine (TOOL_CHANGE).
  environment.dispatchSelection = makeDispatchSelection({ selectedIdsRef, setSelectedIds: environment.setSelectedIds });
  const execute = new Function(...Object.keys(environment), `${changeModeCode}\nreturn changeMode;`);
  const changeMode = execute(...Object.values(environment));
  return { changeMode, calls, modeRef, temporaryEraserRef, previousDrawingToolRef, selectedIdsRef, lassoPointsRef };
}

test('ordinary tool switches with empty selection/lasso never replace those references (no memo invalidation)', () => {
  const h = harness({ mode: 'write', selectedIds: new Set(), lassoPoints: [] });
  const selectedIdsBefore = h.selectedIdsRef.current;
  const lassoPointsBefore = h.lassoPointsRef.current;

  h.changeMode('erase'); // Pen -> Eraser
  h.changeMode('write'); // Eraser -> Pen
  h.changeMode('highlight'); // Pen -> Highlighter
  h.changeMode('write'); // Highlighter -> Pen
  h.changeMode('type'); // Pen -> Text
  h.changeMode('write'); // Text -> Pen

  assert.equal(h.calls.setSelectedIds.length, 0, 'setSelectedIds must never fire when there is nothing selected');
  assert.equal(h.calls.setLassoPoints.length, 0, 'setLassoPoints must never fire when the lasso is already empty');
  assert.equal(h.selectedIdsRef.current, selectedIdsBefore, 'selectedIdsRef must keep the exact same (empty) Set reference');
  assert.equal(h.lassoPointsRef.current, lassoPointsBefore, 'lassoPointsRef must keep the exact same (empty) array reference');
  assert.deepEqual(h.calls.setMode, ['erase', 'write', 'highlight', 'write', 'type', 'write'], 'mode itself must still change on every switch');
});

test('a real selection is still cleared when leaving a non-select tool switch', () => {
  const realSelection = new Set(['stroke-1', 'stroke-2']);
  const h = harness({ mode: 'select', selectedIds: realSelection, lassoPoints: [] });

  h.changeMode('write'); // leaving Select with an active selection

  assert.equal(h.calls.setSelectedIds.length, 1, 'setSelectedIds must fire exactly once to clear a real selection');
  assert.notEqual(h.selectedIdsRef.current, realSelection, 'selectedIdsRef must be replaced with a new Set');
  assert.equal(h.selectedIdsRef.current.size, 0, 'the replacement Set must be empty');
});

test('a real lasso-in-progress is still cleared when switching tools mid-lasso', () => {
  const realLasso = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
  const h = harness({ mode: 'select', selectedIds: new Set(), lassoPoints: realLasso });

  h.changeMode('erase');

  assert.equal(h.calls.setLassoPoints.length, 1, 'setLassoPoints must fire exactly once to clear an in-progress lasso');
  assert.notEqual(h.lassoPointsRef.current, realLasso, 'lassoPointsRef must be replaced with a new array');
  assert.equal(h.lassoPointsRef.current.length, 0, 'the replacement array must be empty');
});

test('switching INTO Select never touches selectedIds/lassoPoints, empty or not', () => {
  const realSelection = new Set(['stroke-1']);
  const realLasso = [{ x: 1, y: 1 }];
  const h = harness({ mode: 'write', selectedIds: realSelection, lassoPoints: realLasso });

  h.changeMode('select');

  assert.equal(h.calls.setSelectedIds.length, 0, 'entering Select must not clear an existing selection');
  assert.equal(h.calls.setLassoPoints.length, 0, 'entering Select must not clear an existing lasso');
  assert.equal(h.selectedIdsRef.current, realSelection);
  assert.equal(h.lassoPointsRef.current, realLasso);
});

test('previousDrawingToolRef and temporaryEraser bookkeeping are unaffected by the fix', () => {
  const h = harness({ mode: 'erase', selectedIds: new Set(), lassoPoints: [] });
  h.changeMode('highlight');
  assert.equal(h.previousDrawingToolRef.current, 'highlight', 'write/highlight switches still update the "previous drawing tool" ref');
  assert.deepEqual(h.calls.setTemporaryEraser, [false], 'temporary-eraser reset is untouched by this fix');
});
