/** Execute the production `touchToCanvasPoint` + `handleNativePencilSample`
 * callbacks without mounting React Native — same TS-AST extraction technique
 * as scripts/notebook-tool-switch-latency.test.mjs and
 * scripts/notebook-clear-page.test.mjs. `screenToCanvasPoint` is imported for
 * real (not reimplemented) so the coordinate transform under test is exactly
 * what Notebook actually uses.
 * Run: node --experimental-strip-types --test scripts/notebook-pencil-sampler-integration.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { screenToCanvasPoint } from '../lib/notebookViewport.ts';

const source = readFileSync(new URL('../components/NotebookCanvas.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('NotebookCanvas.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['touchToCanvasPoint', 'handleNativePencilSample']);
const declarations = [];
function visit(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && names.has(node.name?.getText(parsed))) {
    declarations.push(ts.isVariableDeclaration(node) ? `const ${node.getText(parsed)};` : node.getText(parsed));
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.deepEqual(
  new Set(declarations.map((code) => code.match(/const (\w+)|function (\w+)/)[1] ?? code.match(/const (\w+)|function (\w+)/)[2])),
  names,
  'both callbacks must come from production source',
);
const compiled = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

// Assert the production onTouchesMove branch no longer double-appends Pen
// points itself — this is the other half of "one authoritative source per
// tool" and would silently break if someone re-added the old append call.
test('onTouchesMove no longer appends Pen (write) points itself — only highlighter', () => {
  const start = source.indexOf(".onTouchesMove((event) => {");
  const end = source.indexOf('.onTouchesUp((event) => {', start);
  const fn = source.slice(start, end);
  assert.match(fn, /if \(modeRef\.current === 'highlight'\) {\s*activeInkRef\.current\?\.append\(point\);\s*}/);
  // The write branch must not unconditionally call append(point) with the
  // raw RNGH point anymore.
  const writeBranchOnly = fn.slice(fn.indexOf("mode === 'write' || modeRef.current === 'highlight'"));
  const beforeElseErase = writeBranchOnly.slice(0, writeBranchOnly.indexOf("} else if (modeRef.current === 'erase')"));
  assert.doesNotMatch(
    beforeElseErase,
    /^\s*activeInkRef\.current\?\.append\(point\);/m,
    'write mode must not unconditionally append the raw RNGH point anymore',
  );
});

function harness({ mode, drawing, canvasScale = 1, scrollOffsetY = 0, canvasTranslateX = 0 }) {
  const ref = (current) => ({ current });
  const appended = [];
  const activeInkRef = ref({ append: (point) => appended.push(point) });
  const environment = {
    useCallback: (fn) => fn,
    screenToCanvasPoint,
    scrollOffsetYRef: ref(scrollOffsetY),
    canvasScaleRef: ref(canvasScale),
    canvasTranslateXRef: ref(canvasTranslateX),
    modeRef: ref(mode),
    drawingRef: ref(drawing),
    activeInkRef,
  };
  const execute = new Function(
    ...Object.keys(environment),
    `${compiled}\nreturn { touchToCanvasPoint, handleNativePencilSample };`,
  );
  const { touchToCanvasPoint, handleNativePencilSample } = execute(...Object.values(environment));
  return { touchToCanvasPoint, handleNativePencilSample, appended };
}

test('write mode + active stroke: a moved sample is appended with the correct canvas coordinates and p/t passthrough', () => {
  const h = harness({ mode: 'write', drawing: true, canvasScale: 2, scrollOffsetY: 100, canvasTranslateX: 10 });
  h.handleNativePencilSample({ nativeEvent: { phase: 'moved', x: 50, y: 80, p: 0.42, t: 123.4 } });
  assert.equal(h.appended.length, 1);
  const expected = h.touchToCanvasPoint(50, 80);
  assert.deepEqual(h.appended[0], { ...expected, p: 0.42, t: 123.4 });
});

test('non-moved phases (began/ended/cancelled) are never appended — RNGH alone owns begin/end', () => {
  const h = harness({ mode: 'write', drawing: true });
  for (const phase of ['began', 'ended', 'cancelled']) {
    h.handleNativePencilSample({ nativeEvent: { phase, x: 1, y: 1, p: 0.5, t: 0 } });
  }
  assert.equal(h.appended.length, 0);
});

test('ignored when mode is not write (highlighter/erase/select/scroll unaffected)', () => {
  for (const mode of ['highlight', 'erase', 'select', 'scroll', 'type', 'insert']) {
    const h = harness({ mode, drawing: true });
    h.handleNativePencilSample({ nativeEvent: { phase: 'moved', x: 1, y: 1, p: 0.5, t: 0 } });
    assert.equal(h.appended.length, 0, `mode=${mode} must not append`);
  }
});

test('ignored when no stroke is active (drawingRef false) even in write mode', () => {
  const h = harness({ mode: 'write', drawing: false });
  h.handleNativePencilSample({ nativeEvent: { phase: 'moved', x: 1, y: 1, p: 0.5, t: 0 } });
  assert.equal(h.appended.length, 0);
});

test('null pressure (device/touch cannot report it) passes through as null, never fabricated', () => {
  const h = harness({ mode: 'write', drawing: true });
  h.handleNativePencilSample({ nativeEvent: { phase: 'moved', x: 5, y: 5, p: null, t: 9 } });
  assert.equal(h.appended[0].p, null);
});
