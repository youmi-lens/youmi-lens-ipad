/**
 * Notes reliability loop, round 2 — physical-fail evidence and fixes.
 *
 * Result 1 (image deselection) — TWO rounds:
 *
 * Round 1 fix (physically failed): a blank-paper deselect check was added
 * before the pointerType gate in drawGesture.onTouchesDown, scoped to
 * Write/Highlight/Erase. Physical retest still failed with the EXACT
 * reported repro (insert/select an image, tap it, tap blank paper).
 *
 * Round 2 root cause (proven by reading components/NotebookCanvas.tsx): the
 * toolbar has a persistent 'insert' mode (CanvasMode) — tapping the
 * toolbar's Insert tool sets mode to 'insert' to reveal the "Insert Photos"
 * button, and NOTHING ever resets mode back to 'write' afterward. The exact
 * reported repro happens entirely in 'insert' mode. onTouchesDown's very
 * FIRST gate (`activeMode !== 'write' && ... && activeMode !== 'select'`)
 * evaluates true for 'insert' and calls manager.fail() immediately — before
 * the Round 1 deselect check, which ran AFTER that gate, was ever reached.
 * selectImage() itself never touches `mode`, so whatever mode was active
 * when the image was selected (here, 'insert') is still active when the
 * user then taps blank paper.
 *
 * Fixed by hoisting the deselect check to the very top of onTouchesDown,
 * before ANY mode gate — it now runs for every mode except Select
 * (write/highlight/erase/insert/scroll/type alike), not a hardcoded list of
 * drawing modes.
 *
 * Result 2 (page-1 jump on insert): proven by unit analysis of
 * components/NotebookCanvas.tsx's pickImage. scrollOffsetYRef holds the
 * ScrollView's raw contentOffset — SCREEN-scaled pixels, since the paper
 * renders at canvasHeight * canvasScale — but was being assigned directly as
 * a canvas-space (unscaled document) y, the same space strokes/images live
 * in. At canvasScale < 1 (pinch-zoomed out, exactly the reported repro) this
 * under-counts the true canvas position by the zoom factor, landing the
 * image far closer to the top of the document than the visible viewport —
 * worst, and most visible, at minimum zoom. Fixed by routing insertion
 * through the same screenToCanvasPoint transform every touch/stroke uses.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const canvas = read('components/NotebookCanvas.tsx');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('Result 1 — tap on blank paper deselects an image in every drawing mode');

const touchesDownStart = canvas.indexOf('.onTouchesDown((event, manager) => {');
const touchesDownEnd = canvas.indexOf('.onTouchesMove((event) => {', touchesDownStart);
const touchesDownBody = canvas.slice(touchesDownStart, touchesDownEnd);

check('the deselect check runs before the mode-validity gate AND the pointerType gate — not just the second one (the Round 1 mistake)', () => {
  const deselectIdx = touchesDownBody.indexOf("activeMode !== 'select' && point && selectedIdsRef.current.size > 0 && !findImageAtPoint(point)");
  const modeGateIdx = touchesDownBody.indexOf("activeMode !== 'write' && activeMode !== 'highlight' && activeMode !== 'erase' && activeMode !== 'select'");
  // Selection/drawing are Apple Pencil only in every mode (selectionAcceptsPointer).
  const pointerGateIdx = touchesDownBody.indexOf("!selectionAcceptsPointer(isStylusTouch ? 'stylus' : 'touch')");
  assert.ok(deselectIdx > 0, 'deselect check must exist');
  assert.ok(modeGateIdx > 0, 'the mode-validity gate must still exist (it fails Insert/Scroll/Type before Round 1\'s check position)');
  assert.ok(pointerGateIdx > 0, 'the pointerType gate must still exist');
  assert.ok(deselectIdx < modeGateIdx, 'deselect check must run before the mode gate — this is what Round 1 got wrong, since Insert mode never reaches Write/Highlight/Erase/Select checks at all');
  assert.ok(deselectIdx < pointerGateIdx, 'deselect check must also run before the pointerType gate');
});

check('the deselect check does not require a specific mode allowlist — it runs for every mode except Select, so Insert mode (the exact reported repro) is covered without special-casing it', () => {
  const deselectLine = touchesDownBody.match(/if \(activeMode !== 'select' && point[^{]+\{/);
  assert.ok(deselectLine, 'deselect check must exist');
  assert.doesNotMatch(deselectLine[0], /activeMode === 'write'|activeMode === 'insert'/, 'must not be a positive allowlist of specific modes — that was the Round 1 gap');
});

check('nothing between "numberOfTouches > 1" and the deselect check can return/fail early for a single-touch tap — Insert mode reaches the deselect unconditionally', () => {
  // Selection Interaction Phase: a second finger may upgrade a selection move to a scale, then returns.
  const multiTouchGuardIdx = touchesDownBody.indexOf('if (event.numberOfTouches > 1) {');
  const multiTouchGuard = 'if (event.numberOfTouches > 1) {\n            beginFingerScaleIfEligible(event, manager);\n            return;\n          }';
  assert.ok(touchesDownBody.includes(multiTouchGuard), 'the multi-touch branch only ever calls the scale helper and returns');
  const deselectIdx = touchesDownBody.indexOf("if (activeMode !== 'select' && point");
  assert.ok(multiTouchGuardIdx > 0 && deselectIdx > multiTouchGuardIdx);
  const between = touchesDownBody.slice(multiTouchGuardIdx + multiTouchGuard.length, deselectIdx);
  // Strip comments first — the explanatory comment in this exact block
  // legitimately mentions "manager.fail()" in prose, which must not be
  // mistaken for actual code by this check.
  const code = between.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /manager\.fail\(\)|return;/, 'no early exit may sit between the single-touch guard and the deselect check for any mode, including Insert');
});

console.log('\nRuntime trace diagnostics for the selection-dismissal investigation (per-transition, not polling)');

check('a one-shot trace fires on every touch-down while a selection exists, capturing mode/pointerType/hit-test/willDeselect', () => {
  const traceIdx = touchesDownBody.indexOf("console.info('[NotebookSelection] touch-down-with-selection'");
  assert.ok(traceIdx > 0);
  const traceBlock = touchesDownBody.slice(traceIdx - 200, traceIdx + 400);
  assert.match(traceBlock, /mode: activeMode/);
  assert.match(traceBlock, /pointerType: event\.pointerType/);
  assert.match(traceBlock, /hitImageId: hitImage\?\.id \?\? null/);
  assert.match(traceBlock, /willDeselect/);
});

check('a confirmation trace fires only when the deselect branch actually executes', () => {
  const idx = touchesDownBody.indexOf("console.info('[NotebookSelection] deselected-on-blank-tap'");
  assert.ok(idx > 0);
});

check('selectImage traces which mode was active at the moment of selection, so a later "still selected" report can be correlated back to it', () => {
  const start = canvas.indexOf('const selectImage = useCallback((id: string) => {');
  const end = canvas.indexOf('}, []);', start);
  const body = canvas.slice(start, end);
  assert.match(body, /console\.info\('\[NotebookSelection\] image-tap-select'/);
  assert.match(body, /mode: modeRef\.current/);
});

check('the deselect check is scoped OUT of Select mode, which already owns deselection via the full selection bounding box (strokes + images + padding)', () => {
  // The condition now spans lines (it also spares a tapped shape's handles/outline and finger-downs).
  const deselectLine = touchesDownBody.match(/if \(activeMode !== 'select' && point[^{]+\{/);
  assert.ok(deselectLine, 'deselect check must exist');
  assert.match(deselectLine[0], /activeMode !== 'select'/);
});

check('the deselect check clears BOTH the ref and the state, matching every other deselect site in the file', () => {
  const idx = touchesDownBody.indexOf("if (activeMode !== 'select' && point && selectedIdsRef.current.size > 0");
  const block = touchesDownBody.slice(idx, idx + 600);
  // Selection Interaction Phase: the deselect is the explicit TAP_BLANK event; the ONE dispatcher
  // then clears BOTH the ref and the state (no more ad-hoc clear sites).
  assert.match(block, /dispatchSelection\(\{ type: 'TAP_BLANK' \}/);
  const dispatcher = canvas.slice(canvas.indexOf('const dispatchSelection = useCallback'), canvas.indexOf('const selectionShapeRef'));
  assert.match(dispatcher, /selectedIdsRef\.current = next;\s*setSelectedIds\(next\);/);
});

check('the check only clears when the touch is NOT on any image — tapping a different image must still be free to select it via that image\'s own Tap gesture', () => {
  const idx = touchesDownBody.indexOf("if (activeMode !== 'select' && point");
  assert.match(touchesDownBody.slice(idx, idx + 200), /!findImageAtPoint\(point\)/);
});

console.log('\nResult 2 — image insertion uses the currently visible viewport, correctly, at any zoom level');

const pickImageStart = canvas.indexOf('const pickImage = useCallback(async () => {');
const pickImageEnd = canvas.indexOf('}, [recordHistory]);', pickImageStart);
const pickImageBody = canvas.slice(pickImageStart, pickImageEnd);

check('insertion position is computed via screenToCanvasPoint — the same scale/translateX-aware transform every touch uses — not a raw scrollOffsetYRef arithmetic shortcut', () => {
  assert.match(pickImageBody, /const canvasAnchor = screenToCanvasPoint\(/);
  assert.match(pickImageBody, /canvasScaleRef\.current/, 'must read the live zoom scale');
  assert.match(pickImageBody, /canvasTranslateXRef\.current/, 'must read the live horizontal pan');
  assert.doesNotMatch(pickImageBody, /const cy = scrollOffsetYRef\.current \+ 60;/, 'the old scale-unaware formula must be gone');
});

check('the screen-space anchor accounts for the on-screen (scaled) footprint of the image being centered, not its unscaled canvas width', () => {
  assert.match(pickImageBody, /const displayScreenW = displayW \* canvasScaleRef\.current;/);
  assert.match(pickImageBody, /const screenX = Math\.max\(MARGIN_X, \(cs\.width - displayScreenW\) \/ 2\);/);
});

check('the final image object is still clamped into the page bounds, same as every other geometry-producing path (duplicate, drag, resize)', () => {
  assert.match(pickImageBody, /const img: NoteImage = clampImageGeometry\(/);
  assert.match(pickImageBody, /pageGeomRef\.current\.canvasHeight/);
});

check('canvasAnchor.x/.y (not the pre-transform screenX/screenY) are what end up on the image object', () => {
  assert.match(pickImageBody, /const cx = canvasAnchor\.x;/);
  assert.match(pickImageBody, /const cy = canvasAnchor\.y;/);
});

console.log(`\nnotebook-image-viewport-fixes: ${passed} checks passed`);
