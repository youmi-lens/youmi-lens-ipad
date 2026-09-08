/**
 * Notes reliability loop, round 3 — Copy/Delete unreliability + Pencil-over-image.
 *
 * Issue 1 root cause (proven by reading components/NotebookCanvas.tsx): the
 * floating Copy/Delete action bar renders as a sibling INSIDE the same
 * gesture-wrapped canvas the Round 2 blank-paper-deselect fix runs in. From
 * findImageAtPoint's perspective, the action bar's own buttons ARE "blank
 * paper" (they sit just outside the image's rect, above or below it) — so a
 * touch-down on Copy/Delete satisfied the deselect condition and cleared
 * selectedIds immediately, which unmounts the action bar (imageActionBar is
 * derived from selectedIds) before the native Pressable's onPress could ever
 * fire on touch-up. In Select mode specifically, the same touch would
 * instead fall through to manager.activate() and start a fresh rect/lasso
 * selection, for the same underlying reason (no image at that point).
 * Fixed by excluding the action bar's own bounds from both the deselect
 * check and gesture activation.
 *
 * Round 3a runtime crash (physically reproduced): the first attempt tracked
 * the action bar's bounds via `const imageActionBarRef = useRef(imageActionBar)`
 * declared AFTER drawGesture's useMemo in source order, and read as
 * `imageActionBarRef.current` from inside drawGesture's onTouchesDown —
 * which crashed with "Cannot read property 'current' of undefined" on a
 * real device. Every OTHER ref this same handler already reads
 * (selectedIdsRef, imagesRef, containerSizeRef, pageGeomRef) is declared
 * BEFORE drawGesture; imageActionBarRef was the one exception. Rather than
 * chase the exact runtime mechanism further, the bar's bounds are now
 * recomputed inline inside onTouchesDown from that same set of
 * already-proven-working, pre-drawGesture refs (plus a new editableRef,
 * for the same reason) — mirroring imageActionBar's own layout math exactly
 * rather than depending on that memo's output at all.
 *
 * Issue 2 root cause, round 1 (proven by reading components/NotebookCanvas.tsx):
 * neither the canvas's drawGesture (its findImageAtPoint deferral) nor
 * NotebookImageObjectBase's own tap/pan/corner gestures filtered by pointer
 * type — an Apple Pencil touch landing on an image was treated exactly like
 * a finger touch: drawGesture yielded to the image, and the image's own
 * gestures then selected/moved it. Fixed drawGesture symmetrically (only
 * yields to an image for a non-stylus pointer, or in Select mode) and added
 * a failIfStylus onTouchesDown rejection to the image's own tap/pan/corner
 * gestures.
 *
 * Issue 2 round 2 (physically reproduced): the onTouchesDown-only rejection
 * was insufficient — a Pencil stroke starting inside an image produced one
 * ink dot, then lost continuous ink; image translation confirmed the image's
 * own pan gesture was still activating. Hypothesized root cause: pan/the
 * corner gestures were plain (non-manual-activation) Gesture.Pan()s, and a
 * native-thread minDistance auto-activation racing a JS-thread
 * onTouchesDown rejection seemed like the mechanism.
 *
 * Issue 2 round 3 (physically reproduced): converting pan and every corner
 * gesture to manualActivation(true), with an explicit distance-threshold
 * manager.activate(), was tried as the fix for round 2. It PHYSICALLY BROKE
 * NORMAL FINGER DRAGGING and did NOT fix the Pencil-starts-inside-image
 * case — proof the "native-thread race" theory was wrong, or at least not
 * the actual/whole mechanism. Reverted entirely: pan and the corner
 * gestures are back to plain auto-activation (minDistance) exactly as they
 * worked before round 2, plus the onTouchesDown-based stylus rejection
 * (harmless — proven present in the version where finger-drag worked).
 *
 * New evidence from this round narrows the search: a Pencil stroke that
 * STARTS outside an image and crosses into one draws continuous ink fine;
 * only a stroke that STARTS inside an image loses continuity after one dot.
 * Since drawGesture's own onTouchesDown demonstrably runs and calls
 * manager.activate() for this case (unchanged from round 1), the leading
 * hypothesis is that touch-move delivery itself — not gesture
 * activation/rejection — differs based on where the touch originated, when
 * that origin is inside a nested descendant view (the image) versus the
 * ancestor ScrollView directly. This is NOT yet proven; no further gesture
 * logic has been changed for it this round. Diagnostics were added instead:
 * touch-on-image (routing decision), canvas-gesture-activated (proof
 * drawGesture did activate, with the touch id), image-gesture-touches-down
 * (fires for EVERY image-side gesture's touch-down, tagged tap/pan/
 * corner-N, so it's directly visible whether the image side also saw and
 * rejected the same touch), and ink-stroke-end's moveSampleCount (0 would
 * directly prove drawGesture's onTouchesMove never fired for that touch
 * despite activation — the smoking gun for the touch-ownership hypothesis;
 * nonzero would point somewhere else entirely, e.g. rendering).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const canvas = read('components/NotebookCanvas.tsx');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const touchesDownStart = canvas.indexOf('.onTouchesDown((event, manager) => {');
const touchesDownEnd = canvas.indexOf('.onTouchesMove((event) => {', touchesDownStart);
const touchesDownBody = canvas.slice(touchesDownStart, touchesDownEnd);

console.log('Issue 1 — Copy/Delete action bar taps no longer misclassified as blank-paper taps');

check('the fragile imageActionBarRef pattern that crashed physically ("Cannot read property \'current\' of undefined") is gone from actual code — no declaration, no usage (a comment may still name it in prose, explaining the history)', () => {
  const code = canvas.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /imageActionBarRef/, 'this identifier must not appear in actual code — it was a ref declared AFTER drawGesture\'s useMemo but read from inside it, which crashed on-device');
});

check('the action bar bounds are recomputed inline inside onTouchesDown, using only refs already proven to work from inside this exact closure (selectedIdsRef, imagesRef, containerSizeRef, pageGeomRef, selectionMoveOffsetRef, editableRef) — none of them declared after drawGesture', () => {
  assert.match(touchesDownBody, /const bar = \(\(\) => \{/);
  assert.match(touchesDownBody, /if \(!editableRef\.current \|\| selectedIdsRef\.current\.size !== 1\) return null;/);
  assert.match(touchesDownBody, /imagesRef\.current\.find\(\(image\) => image\.id === selectedId\)/);
  assert.match(touchesDownBody, /containerSizeRef\.current\.width/);
  assert.match(touchesDownBody, /pageGeomRef\.current\.canvasHeight/);
  assert.match(touchesDownBody, /selectionMoveOffsetRef\.current/);
  for (const ref of ['selectedIdsRef', 'imagesRef', 'containerSizeRef', 'pageGeomRef', 'editableRef']) {
    const declMatch = canvas.match(new RegExp(`const ${ref} = useRef(?:<[^(]*)?\\(`));
    const drawGestureIdx = canvas.indexOf('const drawGesture = useMemo(');
    assert.ok(declMatch && declMatch.index < drawGestureIdx, `${ref} must be declared before drawGesture's useMemo, matching every other ref this closure already reads successfully`);
  }
});

check('a touch inside the recomputed action bar bounds is detected using the same rect math as before', () => {
  assert.match(touchesDownBody, /point\.x >= bar\.left && point\.x <= bar\.left \+ IMAGE_ACTION_BAR_WIDTH/);
  assert.match(touchesDownBody, /point\.y >= bar\.top && point\.y <= bar\.top \+ IMAGE_ACTION_BAR_HEIGHT/);
});

check('the inline computation mirrors imageActionBar\'s own layout math (clamp, IMAGE_ACTION_BAR_EDGE/GAP, above/below flip) rather than depending on that memo\'s output', () => {
  const barFnStart = touchesDownBody.indexOf('const bar = (() => {');
  const barFnEnd = touchesDownBody.indexOf('})();', barFnStart);
  const barFnBody = touchesDownBody.slice(barFnStart, barFnEnd);
  assert.match(barFnBody, /clamp\(centerX - IMAGE_ACTION_BAR_WIDTH \/ 2, IMAGE_ACTION_BAR_EDGE, maxLeft\)/);
  assert.match(barFnBody, /above < IMAGE_ACTION_BAR_EDGE \? below : above/);
});

check('the blank-paper deselect check excludes a bar hit — the exact bug: Copy/Delete taps were clearing the selection that owns them', () => {
  assert.match(touchesDownBody, /activeMode !== 'select' && point && selectedIdsRef\.current\.size > 0 && !findImageAtPoint\(point\) && !barHit/);
});

check('a bar hit fails the canvas gesture unconditionally, in every mode — including Select, where nothing else would have stopped a fresh rect/lasso selection from starting on the button', () => {
  const idx = touchesDownBody.indexOf('if (barHit) {');
  assert.ok(idx > 0, 'unconditional barHit guard must exist');
  const failGateIdx = touchesDownBody.indexOf("activeMode !== 'write' && activeMode !== 'highlight'");
  assert.ok(idx < failGateIdx, 'the barHit guard must run before the mode gate, covering every mode uniformly');
});

check('[NotebookImageAction] traces exist for callback entry/completion on both Copy and Delete, so a future "still unreliable" report is directly diagnosable', () => {
  assert.match(canvas, /console\.info\('\[NotebookImageAction\] delete callback-entered'/);
  assert.match(canvas, /console\.info\('\[NotebookImageAction\] delete callback-completed'/);
  assert.match(canvas, /console\.info\('\[NotebookImageAction\] copy callback-entered'/);
  assert.match(canvas, /console\.info\('\[NotebookImageAction\] copy callback-completed'/);
});

console.log('\nIssue 1 — Copy/Delete contract itself (data level, unaffected by the touch-routing fix)');

const deleteStart = canvas.indexOf('const deleteSelectedObjects = useCallback(() => {');
const deleteEnd = canvas.indexOf('}, [recordHistory]);', deleteStart);
const deleteBody = canvas.slice(deleteStart, deleteEnd);

check('delete removes only the selected ids, leaving unrelated images and strokes untouched', () => {
  assert.match(deleteBody, /strokesRef\.current\.filter\(\(stroke\) => !ids\.has\(stroke\.id\)\)/);
  assert.match(deleteBody, /imagesRef\.current\.filter\(\(image\) => !ids\.has\(image\.id\)\)/);
});

check('delete does not touch the durable image file — only the NoteImage object reference is dropped, so a Copy sharing the same uri is unaffected', () => {
  assert.doesNotMatch(deleteBody, /FileSystem|persistNotebookImage|\.delete\(\)/);
});

check('delete is one logical history operation (single recordHistory call), not per-item', () => {
  const recordHistoryCount = (deleteBody.match(/recordHistory\(\)/g) ?? []).length;
  assert.equal(recordHistoryCount, 1);
});

const duplicateStart = canvas.indexOf('const duplicateSelected = useCallback(() => {');
const duplicateEnd = canvas.indexOf('}, [recordHistory]);', duplicateStart);
const duplicateBody = canvas.slice(duplicateStart, duplicateEnd);

check('copy gives the duplicate a new unique id via makeImageId(), never reusing the original id', () => {
  assert.match(duplicateBody, /const newId = makeImageId\(\);/);
});

check('copy offsets the duplicate visibly from the original (not an exact overlap)', () => {
  assert.match(duplicateBody, /const OFFSET = 18;/);
  assert.match(duplicateBody, /x: img\.x \+ OFFSET, y: img\.y \+ OFFSET/);
});

check('copy reuses the SAME durable uri — it does not re-copy image bytes or invoke persistNotebookImage again', () => {
  assert.match(duplicateBody, /\{ \.\.\.img, id: newId, x: img\.x \+ OFFSET, y: img\.y \+ OFFSET, createdAt: new Date\(\)\.toISOString\(\) \}/, 'the spread carries the original uri forward unchanged');
  assert.doesNotMatch(duplicateBody, /persistNotebookImage/);
});

check('the original image object is never mutated — duplicateSelected only ever appends new objects', () => {
  assert.match(duplicateBody, /onImagesChangeRef\.current\(\[\.\.\.imagesRef\.current, \.\.\.extraImages\]\)/, 'append-only, original array entries untouched');
});

check('copy is one logical history operation, not per duplicated item', () => {
  const recordHistoryCount = (duplicateBody.match(/recordHistory\(\)/g) ?? []).length;
  assert.equal(recordHistoryCount, 1);
});

console.log('\nIssue 2 — Apple Pencil draws through an image instead of selecting/moving it');

check('drawGesture only yields to an image for a NON-stylus touch (or in Select mode, where Pencil should still select) — not unconditionally', () => {
  assert.match(touchesDownBody, /const stylusDrawingOverImage = activeMode !== 'select' && event\.pointerType === PointerType\.STYLUS;/);
  assert.match(touchesDownBody, /if \(hitImageForInkRouting && !stylusDrawingOverImage\)/);
  assert.doesNotMatch(touchesDownBody, /if \(findImageAtPoint\(point\)\) \{\s*\n\s*manager\.fail\(\);/, 'the old unconditional-on-any-pointer-type version must be gone');
});

check('the routing decision is traced once per touch-on-image, not per frame', () => {
  assert.match(touchesDownBody, /console\.info\('\[NotebookImageAction\] touch-on-image'/);
  assert.match(touchesDownBody, /routedTo: stylusDrawingOverImage \? 'ink' : 'image-gesture'/);
});

const imageObjectStart = canvas.indexOf('function NotebookImageObjectBase(');
const imageObjectEnd = canvas.indexOf('\nfunction ModeIconBase(');
const imageObjectBody = canvas.slice(imageObjectStart, imageObjectEnd);

check('makeFailIfStylus is a UI worklet: it fails a stylus synchronously, while diagnostics cross to JS explicitly', () => {
  assert.match(imageObjectBody, /const makeFailIfStylus = \(source: string\) => \(event: \{ pointerType: PointerType \}, manager: \{ fail: \(\) => void \}\) => \{/);
  assert.match(imageObjectBody, /'worklet';/);
  assert.match(imageObjectBody, /runOnJS\(traceImageGestureTouch\)\(source, event\.pointerType, isStylus\);/);
  assert.match(imageObjectBody, /console\.info\('\[NotebookImageAction\] image-gesture-touches-down'/);
  assert.match(imageObjectBody, /if \(isStylus\) manager\.fail\(\);/);
});

check('no image gesture is forced onto JS: that made GestureStateManager.fail() a no-op on physical iPad', () => {
  assert.doesNotMatch(imageObjectBody, /\.runOnJS\(true\)/);
  assert.match(imageObjectBody, /runOnJS\(selectImageFromGesture\)\(\)/);
  assert.match(imageObjectBody, /runOnJS\(beginPanFromGesture\)\(\)/);
  assert.match(imageObjectBody, /runOnJS\(updatePanFromGesture\)\(/);
  assert.match(imageObjectBody, /runOnJS\(beginCornerFromGesture\)\(corner\)/);
});

check('the image\'s own tap gesture (select) rejects a stylus touch via onTouchesDown, tagged "tap"', () => {
  const tapStart = imageObjectBody.indexOf('const tap = Gesture.Tap()');
  const tapEnd = imageObjectBody.indexOf('const makeCornerGesture');
  const tapBody = imageObjectBody.slice(tapStart, tapEnd);
  assert.match(tapBody, /\.onTouchesDown\(makeFailIfStylus\('tap'\)\)/);
});

console.log('\nIssue 2 round 3 — the manualActivation attempt for pan/corners is REVERTED (it broke finger-drag and did not fix the remaining case)');

const panStart = imageObjectBody.indexOf('const pan = Gesture.Pan()');
const panEnd = imageObjectBody.indexOf('const pinch = Gesture.Pinch()');
const panBody = imageObjectBody.slice(panStart, panEnd);

check('the image\'s own pan gesture (move) is back to plain auto-activation via minDistance — manualActivation is gone', () => {
  assert.match(panBody, /\.minDistance\(IMAGE_DRAG_MIN_DISTANCE\)/);
  assert.doesNotMatch(panBody, /\.manualActivation\(true\)/, 'manual activation broke normal finger dragging and must not be reintroduced without proof it is the correct fix');
  assert.match(panBody, /\.onTouchesDown\(makeFailIfStylus\('pan'\)\)/);
});

const cornerStart = imageObjectBody.indexOf('const makeCornerGesture = (corner: ImageCorner) => {');
const cornerEnd = imageObjectBody.indexOf('const corners: Record<ImageCorner');
const cornerBody = imageObjectBody.slice(cornerStart, cornerEnd);

check('every corner-resize gesture is likewise back to plain auto-activation via minDistance, tagged per corner', () => {
  assert.match(cornerBody, /\.minDistance\(IMAGE_DRAG_MIN_DISTANCE\)/);
  assert.doesNotMatch(cornerBody, /\.manualActivation\(true\)/);
  assert.match(cornerBody, /\.onTouchesDown\(makeFailIfStylus\(`corner-\$\{corner\}`\)\)/);
});

check('pan/corner activation is still traced (image-pan-activated / image-corner-activated) — should never fire for a stylus-initiated touch, whatever the underlying activation mechanism', () => {
  assert.match(imageObjectBody, /console\.info\('\[NotebookImageAction\] image-pan-activated'/);
  assert.match(imageObjectBody, /console\.info\('\[NotebookImageAction\] image-corner-activated'/);
  assert.match(panBody, /runOnJS\(beginPanFromGesture\)\(\)/);
  assert.match(cornerBody, /runOnJS\(beginCornerFromGesture\)\(corner\)/);
});

console.log('\nIssue 2 round 3 — deep touch-ownership diagnostics for the Pencil-starts-inside-image case (no fix yet, tracing only)');

check('drawGesture explicitly traces its own activation, including the touch id and whether it started over an image, so it is directly provable that drawGesture DID activate for that touch', () => {
  const idx = touchesDownBody.indexOf('manager.activate();');
  const nearby = touchesDownBody.slice(idx, idx + 400);
  assert.match(nearby, /console\.info\('\[NotebookImageAction\] canvas-gesture-activated', \{/);
  assert.match(nearby, /touchId: touch\.id,/);
  assert.match(nearby, /startedOverImageId: hitImageForInkRouting\?\.id \?\? null,/);
});

const endStrokeStart = canvas.indexOf('const endStroke = useCallback(() => {');
const endStrokeEnd = canvas.indexOf('}, [commitLasso,', endStrokeStart);
const endStrokeBody = canvas.slice(endStrokeStart, endStrokeEnd);

check('a stroke starting over an image is tagged at ink-begin and summarized once at stroke end, with a total move-sample count — 0 would directly prove onTouchesMove never fired for that touch despite activation, the key open question', () => {
  assert.match(canvas, /strokeStartedOverImageRef\.current = hitImageForInkRouting\?\.id \?\? null;/);
  assert.match(canvas, /strokeMoveSampleCountRef\.current \+= 1;/);
  assert.match(endStrokeBody, /console\.info\('\[NotebookImageAction\] ink-stroke-end'/);
  assert.match(endStrokeBody, /startedOverImageId: strokeStartedOverImageRef\.current/);
  assert.match(endStrokeBody, /moveSampleCount: strokeMoveSampleCountRef\.current/);
});

check('the move-sample counter itself is only ever incremented, never logged, inside onTouchesMove — no logging in the high-frequency move handler', () => {
  const touchesMoveStart = canvas.indexOf('.onTouchesMove((event) => {');
  const touchesMoveEnd = canvas.indexOf('.onTouchesUp((event) => {', touchesMoveStart);
  const touchesMoveBody = canvas.slice(touchesMoveStart, touchesMoveEnd);
  assert.doesNotMatch(touchesMoveBody, /console\.info/, 'no logging inside the high-frequency move handler');
});

console.log(`\nnotebook-image-action-pencil-routing: ${passed} checks passed`);
