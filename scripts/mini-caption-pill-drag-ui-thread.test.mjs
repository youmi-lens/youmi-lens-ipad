/**
 * Collapsed mini-caption pill drag — UI-thread gesture migration.
 *
 * Real classroom observation (after the feed-list memoization fix already
 * landed and clearly helped): overall popup performance improved a lot, but
 * dragging the COLLAPSED pill still felt slightly janky.
 *
 * Root cause: this component still re-renders every ~250ms regardless of
 * collapsed/expanded state — `useRecordingNotes()` (which subscribes to
 * currentDurationMillis) is called unconditionally, above the
 * `if (!panelVisible)` early return that produces the collapsed pill. The
 * pill's drag used PanResponder, whose touch handling runs on the JS
 * thread — so any concurrent JS-thread work (even a now-cheap re-render)
 * could delay the touch-move -> transform round trip, showing up as a small
 * but real drag stutter. Gesture.Pan()'s onUpdate worklet runs entirely on
 * the UI thread and cannot be delayed by JS-thread work at all.
 *
 * Source-level: FloatingMiniCaption is a React Native component with no
 * Node-runnable unit test surface, so this asserts the actual shipped
 * source implements the required invariants — the same approach used by
 * floating-caption-render-isolation.test.mjs and other RN-component tests
 * in this repo.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const source = read('../components/FloatingMiniCaption.tsx');

console.log('The collapsed pill drag is a Gesture.Pan() worklet, not PanResponder');

check('PanResponder is no longer used for the listening pill (only the main panel drag/resize keep it — unchanged, unaffected)', () => {
  assert.doesNotMatch(source, /listeningPillResponder/, 'the old PanResponder-based pill drag must be fully removed');
  assert.doesNotMatch(source, /listeningPillPan\b/, 'the old core-Animated ValueXY must be fully removed');
  assert.match(source, /const listeningPillGesture = useMemo\(\(\) => \{/);
});

check('position is tracked with Reanimated shared values, applied via useAnimatedStyle transforms', () => {
  assert.match(source, /const listeningPillX = useSharedValue\(initialListeningPill\.current\.x\);/);
  assert.match(source, /const listeningPillY = useSharedValue\(initialListeningPill\.current\.y\);/);
  assert.match(source, /const listeningPillAnimatedStyle = useAnimatedStyle\(\(\) => \(\{\s*\n\s*transform: \[\{ translateX: listeningPillX\.value \}, \{ translateY: listeningPillY\.value \}\],/);
});

check('the continuous-move handler (onUpdate) never calls runOnJS — it stays entirely on the UI thread', () => {
  const idx = source.indexOf('.onUpdate((event) => {');
  const onUpdateBlock = source.slice(idx, source.indexOf('.onFinalize', idx));
  assert.match(onUpdateBlock, /'worklet';/);
  assert.doesNotMatch(onUpdateBlock, /runOnJS/, 'onUpdate must not bounce to the JS thread on every frame — that would reintroduce the exact stutter being fixed');
});

check('runOnJS is used only at gesture start/end — to commit the tap-suppression flag and the final settled position, not per-frame', () => {
  const startIdx = source.indexOf('.onStart(() => {');
  const startBlock = source.slice(startIdx, source.indexOf('.onUpdate', startIdx));
  assert.match(startBlock, /runOnJS\(beginListeningPillDrag\)\(\)/);
  const finalizeIdx = source.indexOf('.onFinalize((event) => {');
  const finalizeBlock = source.slice(finalizeIdx, finalizeIdx + 800);
  assert.match(finalizeBlock, /runOnJS\(commitListeningPillDrag\)\(nextX, nextY\)/);
});

check('the gesture is wired via GestureDetector + Reanimated.View at the actual JSX call site', () => {
  const idx = source.indexOf('if (!panelVisible) {');
  const block = source.slice(idx, source.indexOf('return (\n      <View', idx));
  assert.match(block, /<GestureDetector gesture=\{listeningPillGesture\}>/);
  assert.match(block, /<Reanimated\.View style=\{\[styles\.listeningPillWrap, listeningPillAnimatedStyle\]\}>/);
});

console.log('\nBehavior preservation — same drag feel/bounds/tap-suppression semantics, only the execution thread changed');

check('drag movement stays unclamped mid-gesture (matches the previous PanResponder behavior) — only the settled release position is clamped', () => {
  const idx = source.indexOf('.onUpdate((event) => {');
  const block = source.slice(idx, source.indexOf('.onFinalize', idx));
  assert.doesNotMatch(block, /Math\.min|Math\.max/, 'live drag must stay unclamped, exactly like the prior implementation');
  const finalizeIdx = source.indexOf('.onFinalize((event) => {');
  const finalizeBlock = source.slice(finalizeIdx, finalizeIdx + 400);
  assert.match(finalizeBlock, /Math\.min\(Math\.max\(listeningPillStartX\.value \+ event\.translationX, EDGE_MARGIN\), maxX\)/);
});

check('the settled position springs back into place (withSpring), matching the previous Animated.spring settle behavior', () => {
  const finalizeIdx = source.indexOf('.onFinalize((event) => {');
  const finalizeBlock = source.slice(finalizeIdx, finalizeIdx + 800);
  assert.match(finalizeBlock, /listeningPillX\.value = withSpring\(nextX,/);
  assert.match(finalizeBlock, /listeningPillY\.value = withSpring\(nextY,/);
});

check('tap-suppression (drag must not also trigger the pill\'s onPress) is preserved with the same 120ms window', () => {
  const idx = source.indexOf('const commitListeningPillDrag = useCallback(');
  const block = source.slice(idx, idx + 300);
  assert.match(block, /listeningPillWasDraggedRef\.current = false;\s*\n\s*\}, 120\);/);
  assert.match(source, /if \(listeningPillWasDraggedRef\.current\) return;\s*\n\s*setPanelVisible\(true\);/);
});

check('a minimum drag distance still gates the gesture (a short tap must not be captured as a drag)', () => {
  assert.match(source, /Gesture\.Pan\(\)\s*\n\s*\.minDistance\(5\)/);
});

console.log(`\nmini-caption pill drag UI-thread migration: ${passed} checks passed`);
