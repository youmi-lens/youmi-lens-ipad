/**
 * Caption window behavior consistency: Notes vs Course Material.
 *
 * Physical owner retest: Course Material's Caption window (rendered via
 * components/FloatingMiniCaption.tsx) resized/behaved differently from the
 * Notes Caption window (app/mini-caption.tsx's own floating panel) — because
 * they were two separate, independently-written implementations.
 * FloatingMiniCaption still had the ORIGINAL, unoptimized resize path
 * (`onPanResponderMove` calling `setPanelSize` — React state — on every touch
 * sample), while mini-caption.tsx had already been fixed to the
 * owner-approved ghost-outline architecture (content-free preview during the
 * drag, real panel frozen, one committed layout pass on release).
 *
 * Fix: ported the same ghost-outline architecture into
 * components/FloatingMiniCaption.tsx — same panelSizeAnim/resizeLiveSizeRef/
 * isResizeGhostVisible mechanics, same two-nested-Animated.View split (so a
 * native-driven transform and non-native-driver-eligible width/height are
 * never mixed on one view), same MIN/MAX size constraints (already
 * identical between the two files even before this fix).
 *
 * These are structural source-level guards comparing the two files directly
 * (this is a gesture-driven native layout interaction; actual on-device feel
 * can only be judged physically — see the task's own runtime-validation
 * requirement).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const notes = read('../app/mini-caption.tsx');
const material = read('../components/FloatingMiniCaption.tsx');

console.log('Shared resize size constraints (already identical, still verified)');

check('MIN_PANEL_WIDTH / MIN_PANEL_HEIGHT / EDGE_MARGIN match exactly between the two files', () => {
  for (const name of ['MIN_PANEL_WIDTH', 'MIN_PANEL_HEIGHT', 'EDGE_MARGIN', 'DEFAULT_PANEL_WIDTH', 'DEFAULT_PANEL_HEIGHT']) {
    const notesValue = notes.match(new RegExp(`const ${name} = (\\d+);`))?.[1];
    const materialValue = material.match(new RegExp(`const ${name} = (\\d+);`))?.[1];
    assert.ok(notesValue, `${name} must exist in mini-caption.tsx`);
    assert.equal(materialValue, notesValue, `${name} must match between Notes and Course Material Caption`);
  }
});

check('the resize max-size formula (0.96 width / 0.88 height headroom) matches in both', () => {
  assert.match(notes, /const maxWidth = Math\.max\(MIN_PANEL_WIDTH, width \* 0\.96\);/);
  assert.match(notes, /const maxHeight = Math\.max\(MIN_PANEL_HEIGHT, height \* 0\.88\);/);
  assert.match(material, /const maxWidth = Math\.max\(MIN_PANEL_WIDTH, width \* 0\.96\);/);
  assert.match(material, /const maxHeight = Math\.max\(MIN_PANEL_HEIGHT, height \* 0\.88\);/);
});

console.log('\nShared drag-time ghost-preview behavior');

for (const [label, src] of [['Notes (app/mini-caption.tsx)', notes], ['Course Material (FloatingMiniCaption.tsx)', material]]) {
  const resizeResponderBlock = src.slice(src.indexOf('const resizeResponder = useMemo'));

  check(`${label}: onPanResponderMove never calls setPanelSize (no per-frame React state / real layout)`, () => {
    const moveHandler = resizeResponderBlock.slice(resizeResponderBlock.indexOf('onPanResponderMove: (_e, g) => {'), resizeResponderBlock.indexOf('onPanResponderRelease:'));
    assert.doesNotMatch(moveHandler, /setPanelSize\(/);
    assert.match(moveHandler, /panelSizeAnim\.setValue\(\{ x: next\.width, y: next\.height \}\);/);
  });

  check(`${label}: a content-free ghost element exists, split across two Animated.Views (transform vs size never mixed)`, () => {
    assert.match(src, /isResizeGhostVisible \? \(/);
    assert.match(src, /styles\.resizeGhostPositioner/);
    assert.match(src, /styles\.resizeGhost,/);
    const ghostBlock = src.slice(src.indexOf('isResizeGhostVisible ? ('), src.indexOf('isResizeGhostVisible ? (') + 900);
    const outerWrapper = ghostBlock.slice(ghostBlock.indexOf('styles.resizeGhostPositioner'), ghostBlock.indexOf('<Animated.View', ghostBlock.indexOf('styles.resizeGhostPositioner')));
    assert.match(outerWrapper, /transform: pan\.getTranslateTransform\(\)/);
    assert.doesNotMatch(outerWrapper, /panelSizeAnim/);
  });
}

console.log('\nShared release-time single size commit');

for (const [label, src] of [['Notes', notes], ['Course Material', material]]) {
  const resizeResponderBlock = src.slice(src.indexOf('const resizeResponder = useMemo'));

  check(`${label}: onPanResponderRelease commits the final size to React state exactly once and hides the ghost`, () => {
    const releaseHandler = resizeResponderBlock.slice(resizeResponderBlock.indexOf('onPanResponderRelease: () => {'), resizeResponderBlock.indexOf('onPanResponderTerminate:'));
    assert.match(releaseHandler, /setPanelSize\(finalSize\);/);
    assert.match(releaseHandler, /setIsResizeGhostVisible\(false\);/);
  });

  check(`${label}: a cancelled gesture also hides the ghost and resyncs its preview to the last committed size`, () => {
    const terminateHandler = resizeResponderBlock.slice(resizeResponderBlock.indexOf('onPanResponderTerminate: () => {'));
    assert.match(terminateHandler, /setIsResizeGhostVisible\(false\);/);
    assert.match(terminateHandler, /panelSizeAnim\.setValue\(\{ x: panelSizeRef\.current\.width, y: panelSizeRef\.current\.height \}\);/);
  });
}

console.log('\nShared minimize/reopen semantics');

check('both files use the same panelVisible boolean pattern for minimize (collapse to a listening pill) / reopen', () => {
  for (const src of [notes, material]) {
    assert.match(src, /const \[panelVisible, setPanelVisible\] = useState/);
    assert.match(src, /setPanelVisible\(false\)/, 'minimize action must exist');
    assert.match(src, /setPanelVisible\(true\)/, 'reopen action must exist');
  }
});

console.log(`\ncaption-window-behavior-parity: ${passed} checks passed`);
