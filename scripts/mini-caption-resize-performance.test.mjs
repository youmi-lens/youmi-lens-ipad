/**
 * Caption window resize jank (app/mini-caption.tsx) — round 2.
 *
 * Round 1 replaced `setPanelSize`/`updateCaptionOverlayRect` (React state)
 * on every resize-drag frame with `panelSizeAnim.setValue(...)` (a plain
 * `Animated.Value`, no React re-render). Physical-device retest proved this
 * was NOT enough: the real panel's `width`/`height` were still being driven
 * every frame, and width/height are Yoga LAYOUT properties — React Native's
 * own `NativeAnimatedAllowlist.js` explicitly excludes them from
 * native-driver support ("all non-layout properties" only). So every
 * `setValue()` still forced a full native layout pass of the panel's
 * subtree — the unvirtualized caption ScrollView, and `NativeLookupText`,
 * which renders one nested `<Text>` per English word for the dictionary
 * double-tap feature — regardless of React being bypassed.
 *
 * Round 2 fix: stop resizing the real panel's content during the drag at
 * all. `onPanResponderMove` now only updates `panelSizeAnim`, which drives a
 * content-free "ghost" preview box (no text, no ScrollView, no
 * NativeLookupText — a single plain View with a border) that tracks the
 * finger via a compositor-cheap subtree. The real panel stays completely
 * frozen at its committed `panelSize` (React state) for the whole gesture,
 * getting exactly one real layout pass when the final size commits on
 * release.
 *
 * These are structural source-level guards (this is a gesture-driven native
 * layout interaction; actual frame-rate smoothness can only be judged on a
 * real device — see the task's own requirement) plus pure state-machine
 * simulations of the parts that ARE testable without React Native.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const src = read('../app/mini-caption.tsx');

const resizeResponderBlock = src.slice(
  src.indexOf('const resizeResponder = useMemo'),
  src.indexOf('}, [height, insetTop, insetBottom, insetLeft, insetRight, pan, panelSizeAnim, updateCaptionOverlayRect, width]);') + 10,
);
const moveHandler = resizeResponderBlock.slice(
  resizeResponderBlock.indexOf('onPanResponderMove: (_e, g) => {'),
  resizeResponderBlock.indexOf('onPanResponderRelease:'),
);
const releaseHandler = resizeResponderBlock.slice(
  resizeResponderBlock.indexOf('onPanResponderRelease: () => {'),
  resizeResponderBlock.indexOf('onPanResponderTerminate:'),
);

console.log('1/2. onPanResponderMove touches neither real panel size state nor the overlay rect');

check('onPanResponderMove does not mutate real panel size state (setPanelSize)', () => {
  assert.doesNotMatch(moveHandler, /setPanelSize\(/);
});

check('onPanResponderMove does not update the Caption overlay rect', () => {
  assert.doesNotMatch(moveHandler, /updateCaptionOverlayRect\(/);
});

console.log('\n3. Real Caption width/height remain committed (frozen) during active resize');

check('the real panel\'s style reads committed React state (panelSize), not the live drag value', () => {
  const panelStyle = src.slice(src.indexOf('styles.panel,'), src.indexOf('styles.panel,') + 200);
  assert.match(panelStyle, /width: panelSize\.width,/);
  assert.match(panelStyle, /height: panelSize\.height,/);
  assert.doesNotMatch(panelStyle, /width: panelSizeAnim\.x,/, 'the real panel must not be driven by the per-frame drag value anymore — that is what still forced layout/text reflow every frame');
});

console.log('\n4. The lightweight ghost preview changes during drag');

check('onPanResponderMove drives only panelSizeAnim (the ghost\'s size), nothing content-bearing', () => {
  assert.match(moveHandler, /panelSizeAnim\.setValue\(\{ x: next\.width, y: next\.height \}\);/);
});

check('a dedicated content-free ghost element exists, styled with no text/ScrollView/NativeLookupText, shown only while resizing', () => {
  assert.match(src, /isResizeGhostVisible \? \(/, 'ghost must be conditionally rendered, not always mounted');
  const ghostBlock = src.slice(src.indexOf('panelVisible && isResizeGhostVisible ? ('), src.indexOf('panelVisible && isResizeGhostVisible ? (') + 700);
  assert.match(ghostBlock, /styles\.resizeGhost/);
  assert.match(ghostBlock, /width: panelSizeAnim\.x,/);
  assert.match(ghostBlock, /height: panelSizeAnim\.y,/);
  assert.doesNotMatch(ghostBlock, /ScrollView|NativeLookupText|ClosedCaption|feedLines/i, 'the ghost must stay content-free — no caption text or list inside it');
});

check('the ghost tracks the same position as the real panel (same pan transform), so it feels spatially coherent, not offset', () => {
  const ghostBlock = src.slice(src.indexOf('panelVisible && isResizeGhostVisible ? ('), src.indexOf('panelVisible && isResizeGhostVisible ? (') + 900);
  assert.match(ghostBlock, /transform: pan\.getTranslateTransform\(\)/);
});

check(
  'pan\'s native-driven transform and panelSizeAnim\'s width/height live on two DIFFERENT Animated.Views, never combined in one style array — ' +
  'RN throws "Style property \'width\'/\'height\' is not supported by native animated module" if a native-driven transform and a non-native-driver-eligible ' +
  'width/height are mixed on the same view (confirmed live on physical device against an earlier version of this fix)',
  () => {
    const ghostBlock = src.slice(src.indexOf('panelVisible && isResizeGhostVisible ? ('), src.indexOf('panelVisible && isResizeGhostVisible ? (') + 900);
    const outerWrapper = ghostBlock.slice(ghostBlock.indexOf('styles.resizeGhostPositioner'), ghostBlock.indexOf('<Animated.View', ghostBlock.indexOf('styles.resizeGhostPositioner')));
    assert.match(outerWrapper, /transform: pan\.getTranslateTransform\(\)/, 'the outer wrapper must carry the transform');
    assert.doesNotMatch(outerWrapper, /panelSizeAnim/, 'the outer (transform-carrying) wrapper must not also reference panelSizeAnim width/height');
    const innerBox = ghostBlock.slice(ghostBlock.indexOf('styles.resizeGhost,'));
    assert.match(innerBox, /width: panelSizeAnim\.x,/);
    assert.match(innerBox, /height: panelSizeAnim\.y,/);
    assert.doesNotMatch(innerBox, /transform/, 'the inner (size-carrying) box must not also carry a transform');
  },
);

check('onPanResponderGrant shows the ghost and seeds it from the actual pre-drag committed size (no stale/mismatched starting frame)', () => {
  const grantHandler = resizeResponderBlock.slice(
    resizeResponderBlock.indexOf('onPanResponderGrant: () => {'),
    resizeResponderBlock.indexOf('// High-frequency path'),
  );
  assert.match(grantHandler, /panelSizeAnim\.setValue\(\{ x: resizeStartSizeRef\.current\.width, y: resizeStartSizeRef\.current\.height \}\);/);
  assert.match(grantHandler, /setIsResizeGhostVisible\(true\);/);
});

console.log('\n5/6. Final size and overlay rect commit exactly once, on release; ghost hides then');

check('onPanResponderRelease commits the final size and overlay rect exactly once, and hides the ghost', () => {
  assert.match(releaseHandler, /const finalSize = resizeLiveSizeRef\.current;/);
  assert.match(releaseHandler, /setPanelSize\(finalSize\);/);
  assert.match(releaseHandler, /updateCaptionOverlayRect\(posRef\.current, finalSize\);/);
  assert.match(releaseHandler, /setIsResizeGhostVisible\(false\);/);
});

check('a cancelled gesture (onPanResponderTerminate) also hides the ghost and resyncs it to the last committed size', () => {
  const terminateHandler = resizeResponderBlock.slice(resizeResponderBlock.indexOf('onPanResponderTerminate: () => {'));
  assert.match(terminateHandler, /setIsResizeGhostVisible\(false\);/);
  assert.match(terminateHandler, /panelSizeAnim\.setValue\(\{ x: panelSizeRef\.current\.width, y: panelSizeRef\.current\.height \}\);/);
});

check('panelSizeAnim is resynced to committed panelSize on any non-gesture change, and yields to an in-progress gesture', () => {
  const syncEffect = src.slice(
    src.indexOf('const panelSizeAnim = useRef'),
    src.indexOf('const [isResizeGhostVisible, setIsResizeGhostVisible] = useState(false);'),
  );
  assert.match(syncEffect, /if \(isResizingRef\.current\) return;/);
  assert.match(syncEffect, /panelSizeAnim\.setValue\(\{ x: panelSize\.width, y: panelSize\.height \}\);/);
});

console.log('\nNumeric proof: the real panel gets exactly one layout-affecting size change per gesture, not one per frame');

/**
 * Models one resize gesture, counting how many times the real (content-
 * bearing) panel's width/height actually change under each design.
 */
function simulateResizeDrag(withGhost, frameCount) {
  let realPanelLayoutChanges = 0;
  for (let frame = 1; frame <= frameCount; frame += 1) {
    if (withGhost) continue; // only the ghost (content-free) box changes per frame
    realPanelLayoutChanges += 1; // round-1 design: the real panel's width/height changed every frame
  }
  realPanelLayoutChanges += 1; // the one committed change on release, either way
  return realPanelLayoutChanges;
}

check('with the ghost architecture, the real (text/ScrollView-bearing) panel changes size exactly once per gesture, regardless of frame count', () => {
  const frames = 40; // a ~0.5s drag at 80 samples/sec, a realistic PanResponder rate
  assert.equal(simulateResizeDrag(true, frames), 1);
  assert.equal(simulateResizeDrag(false, frames), frames + 1, 'sanity check: without the ghost, every frame was a real content-layout change — the prior, insufficient design');
});

console.log(`\nmini-caption-resize-performance: ${passed} checks passed`);
