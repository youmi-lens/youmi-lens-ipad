/** Execute the production callbacks without mounting React Native.
 * Run: node --test scripts/notebook-clear-page.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../components/NotebookCanvas.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('NotebookCanvas.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set([
  'clamp', 'cloneSnapshot', 'HISTORY_MAX', 'pageForScroll', 'clearPage',
  'captureSnapshot', 'updateHistoryFlags', 'endTextHistoryBurst',
  'pushUndoSnapshot', 'pushRedoSnapshot', 'recordHistory', 'applySnapshot', 'undo', 'redo',
]);
const declarations = [];
function visit(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && names.has(node.name?.getText(parsed))) {
    const name = node.name.getText(parsed);
    declarations.push({ name, code: ts.isVariableDeclaration(node) ? `const ${node.getText(parsed)};` : node.getText(parsed) });
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.deepEqual(new Set(declarations.map(({ name }) => name)), names, 'all tested callbacks must come from production source');
// Source order is intentional: it also catches a hook dependency referencing a
// resolver before its declaration. No page math or history algorithm is copied.
const callbacks = ts.transpileModule(declarations.map(({ code }) => code).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const geometry = { pageHeight: 1000, pageStride: 1022, totalPages: 5 };
const fixture = {
  strokes: Array.from({ length: 5 }, (_, index) => {
    const top = index * geometry.pageStride;
    return [
      { id: `ink-${index + 1}`, points: [{ x: 10, y: top + 100 }, { x: 20, y: top + 200 }] },
      // Crosses page edges, but its bounding-box center assigns it to this page.
      { id: `cross-${index + 1}`, points: [{ x: 10, y: top - 100 }, { x: 20, y: top + 1100 }] },
      { id: `lower-${index + 1}`, points: [{ x: 10, y: top }] },
      // Exactly at the excluded upper edge, in the visual gap: must survive.
      { id: `upper-${index + 1}`, points: [{ x: 10, y: top + geometry.pageHeight }] },
    ];
  }).flat(),
  images: Array.from({ length: 5 }, (_, index) => ({
    id: `image-${index + 1}`, x: 10, y: index * geometry.pageStride + 100, width: 40, height: 200,
  })),
  text: 'Page-one typed notes',
};

function harness(scale, scrollY, viewportHeight = 400) {
  const state = structuredClone(fixture);
  const ref = current => ({ current });
  const alerts = [];
  const strokesRef = ref(state.strokes), imagesRef = ref(state.images), textRef = ref(state.text);
  const onStrokesChange = next => { state.strokes = next; strokesRef.current = next; };
  const onImagesChange = next => { state.images = next; imagesRef.current = next; };
  const onTextChange = next => { state.text = next; textRef.current = next; };
  const noop = () => {};
  const environment = {
    useCallback: callback => callback,
    NOTEBOOK_DEFAULT_SCALE: 1,
    pageGeomRef: ref(geometry), canvasScaleRef: ref(scale),
    containerSizeRef: ref({ height: viewportHeight }), scrollOffsetYRef: ref(scrollY),
    strokes: state.strokes, images: state.images, text: state.text,
    strokesRef, imagesRef, textRef, onStrokesChange, onImagesChange, onTextChange,
    onStrokesChangeRef: ref(onStrokesChange), onImagesChangeRef: ref(onImagesChange), onTextChangeRef: ref(onTextChange),
    undoStackRef: ref([]), redoStackRef: ref([]), textBurstRef: ref(false), textHistoryTimerRef: ref(null),
    selectedIdsRef: ref(new Set()), erasedIdsRef: ref(new Set()), suppressedEraseIdsRef: ref(new Set()),
    lastErasePointRef: ref(null), eraseRenderFrameRef: ref(null), eraseCursorFrameRef: ref(null),
    pendingEraseCursorPointRef: ref(null),
    setCanUndo: noop, setCanRedo: noop, setSelectedIds: noop, setErasedIds: noop, setErasePoint: noop,
    clearTimeout, cancelAnimationFrame: noop,
    Alert: { alert: (...args) => alerts.push(args) },
    t: (key, params) => ({ key, ...params }),
  };
  const execute = new Function(...Object.keys(environment), `${callbacks}\nreturn { pageForScroll, clearPage, undo, redo };`);
  return { ...execute(...Object.values(environment)), state, alerts, environment };
}

const positions = [
  { label: 'first page, centered', center: 600, page: 1 },
  { label: 'middle page, centered', center: 1533, page: 2 },
  { label: 'boundary viewport, center before page 2', center: 990, page: 1 },
  { label: 'boundary viewport, center on page 2', center: 1030, page: 2 },
  { label: 'middle boundary, center before page 3', center: 2030, page: 2 },
  { label: 'middle boundary, center on page 3', center: 2050, page: 3 },
];

for (const scale of [0.5, 1, 2, 3.5]) {
  for (const { label, center, page } of positions) {
    test(`${scale}x ${label}: indicator = clear target; assignment, text, cancel, undo/redo preserved`, () => {
      const scrollY = center * scale - 200;
      const h = harness(scale, scrollY);
      assert.equal(h.pageForScroll(scrollY), page);
      h.clearPage();
      assert.equal(h.alerts.length, 1);
      const [, message, buttons] = h.alerts[0];
      assert.equal(message.page, page, 'Clear Page must target the page identified by the indicator');
      assert.deepEqual(h.state, fixture, 'opening confirmation must not mutate content');
      const cancel = buttons.find(button => button.style === 'cancel');
      assert.ok(cancel);
      cancel.onPress?.();
      assert.deepEqual(h.state, fixture, 'Cancel must preserve all content');
      assert.equal(h.environment.undoStackRef.current.length, 0);

      const removedIds = new Set([`ink-${page}`, `cross-${page}`, `lower-${page}`]);
      const expected = {
        strokes: fixture.strokes.filter(stroke => !removedIds.has(stroke.id)),
        images: fixture.images.filter(image => image.id !== `image-${page}`),
        text: page === 1 ? '' : fixture.text,
      };
      buttons.find(button => button.style === 'destructive').onPress();
      assert.deepEqual(h.state, expected, 'center assignment, half-open page band and page-one text rule must remain unchanged');
      assert.equal(h.environment.undoStackRef.current.length, 1, 'one clear = one history entry');
      h.undo();
      assert.deepEqual(h.state, fixture, 'Undo must restore the exact original objects and text');
      h.redo();
      assert.deepEqual(h.state, expected, 'Redo must reproduce exactly the cleared document');
    });
  }
}

test('Clear Page delegates to the indicator resolver and retains its hook dependency', () => {
  const clear = declarations.find(({ name }) => name === 'clearPage').code;
  assert.match(clear, /pageForScroll\(scrollOffsetYRef\.current\) - 1/);
  assert.match(clear, /\}, \[[^\]]*pageForScroll[^\]]*\]\)/);
  assert.doesNotMatch(clear, /centerY|Math\.floor|canvasScaleRef/);
  assert.match(source, /showPageBadge\(pageForScroll\(y\)\)/);
});
