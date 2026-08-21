/**
 * Main tab transition V3 — real outgoing/incoming crossfade.
 *
 * Owner feedback on V2: "better, but still slightly abrupt... the remaining
 * issue is likely continuity between outgoing and incoming views, not
 * insufficient entrance duration." V1/V2 only ever animated the INCOMING
 * screen; the outgoing one vanished instantly the moment focus moved.
 *
 * Architecture audit finding (see app/(tabs)/_layout.tsx's own comment, and
 * node_modules/@react-navigation/bottom-tabs/lib/module/views/BottomTabView.js):
 * every tab screen stays mounted, and the library has a REAL, native,
 * overlapping opacity crossfade built in via the `animation`/`transitionSpec`
 * screen options — both the outgoing and incoming route's `tabAnims` value
 * animate in the SAME `Animated.parallel` call, native driver. This is not a
 * custom reimplementation; it is the library's own tested mechanism, and per
 * `hasAnimation()` in that same file, a screen whose OWN `animation` option
 * is left at the default `'none'` has its scene container's opacity
 * structurally never interpolated, in either direction, regardless of what
 * any other tab does. That is what makes it safe to turn on for Record and
 * Settings while leaving Courses off entirely — the crossfade cannot leak
 * into a sub-tree; it is scene-container-wide, so it either applies to a
 * WHOLE screen (safe: Record, Settings — no dynamic collection) or not at
 * all (Courses, which keeps its own V1/V2 ContentReveal(heading-only) +
 * PageShellTransition(translate-only shell) treatment instead).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const layout = stripComments(read('../app/(tabs)/_layout.tsx'));
const sidebar = read('../components/YLSidebar.tsx');
const motionSource = read('../constants/motion.ts');

const screenBlock = (name) => {
  const start = layout.indexOf(`name="${name}"`);
  assert.ok(start > -1, `Tabs.Screen name="${name}" not found`);
  const end = layout.indexOf('/>', start);
  return layout.slice(start, end);
};

console.log('crossfade is enabled on Record and Settings only');

check('index (Record) and settings both opt into the crossfade animation', () => {
  assert.match(screenBlock('index'), /animation: crossfadeAnimation/);
  assert.match(screenBlock('settings'), /animation: crossfadeAnimation/);
});

check('courses has NO animation option at all — defaults to the library\'s own \'none\', never interpolated', () => {
  const coursesBlock = screenBlock('courses');
  assert.doesNotMatch(coursesBlock, /animation/);
  assert.doesNotMatch(coursesBlock, /transitionSpec/);
});

check('the crossfade spec has no scale and no slide — opacity only, via the \'fade\' preset (not \'shift\', which adds translateX)', () => {
  assert.doesNotMatch(layout, /animation: 'shift'/);
  assert.doesNotMatch(layout, /sceneStyleInterpolator/, 'a custom interpolator would mean scale/slide was hand-added — the plain \'fade\' preset is opacity-only by construction');
  assert.doesNotMatch(layout, /scale/);
});

console.log('duration — within the V3 target, shared with the page-shell settle so both layers move in the same window');

check('the crossfade duration comes from a token, not a literal, and reuses pageShellDuration so scene-fade and shell-settle are synchronized', () => {
  assert.match(layout, /duration: motion\.pageShellDuration/);
  const ms = Number(motionSource.match(/pageShellDuration:\s*(\d+)/)[1]);
  assert.ok(ms >= 180 && ms <= 220, `pageShellDuration ${ms}ms outside the V3 target range`);
});

console.log('Reduced Motion — the crossfade has no built-in awareness, so it must be switched off from the outside');

check('animation resolves to \'none\' under Reduced Motion, \'fade\' otherwise — computed once, applied to both screens', () => {
  assert.match(layout, /const reduceMotion = useReduceMotion\(\);/);
  assert.match(layout, /const crossfadeAnimation = reduceMotion \? 'none' : 'fade';/);
});

check('Reduced Motion routes through the library\'s own zero-duration \'none\' preset — an instant swap, not a shortened animation', () => {
  // NAMED_TRANSITIONS_PRESETS.none in BottomTabView.js hard-codes duration 0;
  // confirmed here only by proving 'none' is genuinely selectable, not that
  // node_modules behaves correctly (that's the library's own contract).
  assert.match(layout, /reduceMotion \? 'none'/);
});

console.log('no artificial delay anywhere near navigation');

check('no setTimeout/delay wraps navigation dispatch in the tab layer', () => {
  assert.doesNotMatch(layout, /setTimeout/);
  assert.doesNotMatch(sidebar, /setTimeout[\s\S]{0,80}navigation\.navigate/);
  assert.doesNotMatch(sidebar, /Animated\.delay/);
});

check('navigation.navigate is still called synchronously from onPress — the animation is a reaction to the state change, not a gate before it', () => {
  assert.match(sidebar, /if \(!selected && !event\.defaultPrevented\) navigation\.navigate\(route\.name\);/);
});

console.log(`\ntab transition V3: ${passed} checks passed`);
