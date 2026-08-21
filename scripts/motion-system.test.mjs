/**
 * The shared motion language.
 *
 * These are source-level guards, not render tests: the point is that timings
 * live in ONE place and that the two shared primitives keep their contracts —
 * native-driver only, container-level reveal, Reduce Motion honoured without
 * ever making a state change slower.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
};

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// Every <ContentReveal>...</ContentReveal> span in a file, paired in document
// order. indexOf() would only ever find the FIRST occurrence — blind to a
// second, illegitimate ContentReveal usage once one legitimate one (around a
// page heading) already exists in the same file.
const contentRevealSpans = (source) => {
  const opens = [...source.matchAll(/<ContentReveal\b/g)].map((m) => m.index);
  const closes = [...source.matchAll(/<\/ContentReveal>/g)].map((m) => m.index);
  assert.equal(opens.length, closes.length, 'ContentReveal open/close tag count mismatch');
  return opens.map((open, i) => [open, closes[i]]);
};

const motionSource = read('../constants/motion.ts');
const revealSource = read('../components/ContentReveal.tsx');
const skeletonSource = read('../components/ContentSkeleton.tsx');
const pressableSource = read('../components/PressableScale.tsx');

console.log('motion tokens');

check('every shared timing is defined once, in constants/motion.ts', () => {
  for (const token of [
    'pressScale',
    'pressOpacity',
    'pressInDuration',
    'pressOutDuration',
    'contentRevealDuration',
    'contentRevealOffset',
    'fastFadeDuration',
  ]) {
    assert.match(motionSource, new RegExp(`\\b${token}:`), `missing token ${token}`);
  }
});

check('tokens match the values PressableScale already shipped', () => {
  // The motion language was lifted FROM the accepted press feedback, not
  // invented alongside it. If PressableScale is retuned, retune these together.
  assert.match(motionSource, /pressScale:\s*0\.98/);
  assert.match(motionSource, /pressOpacity:\s*0\.94/);
  assert.match(motionSource, /pressInDuration:\s*70/);
  assert.match(motionSource, /pressOutDuration:\s*150/);
  assert.match(pressableSource, /scaleTo = 0\.98/);
  assert.match(pressableSource, /opacityTo = 0\.94/);
  assert.match(pressableSource, /duration: 70/);
  assert.match(pressableSource, /duration: 150/);
});

check('press feedback stays subtle — no bounce, no big scale', () => {
  const scale = Number(motionSource.match(/pressScale:\s*([\d.]+)/)[1]);
  assert.ok(scale >= 0.96 && scale < 1, `press scale ${scale} is too pronounced`);
  const inMs = Number(motionSource.match(/pressInDuration:\s*(\d+)/)[1]);
  assert.ok(inMs <= 80, `press-in ${inMs}ms must read as immediate`);
});

check('content reveal is restrained', () => {
  const ms = Number(motionSource.match(/contentRevealDuration:\s*(\d+)/)[1]);
  const offset = Number(motionSource.match(/contentRevealOffset:\s*(\d+)/)[1]);
  assert.ok(ms >= 140 && ms <= 220, `reveal ${ms}ms outside the agreed range`);
  assert.ok(offset > 0 && offset <= 10, `reveal offset ${offset}pt is too much travel`);
});

console.log('primitives');

check('ContentReveal and PressableScale animate on the native driver only', () => {
  for (const [name, source] of [
    ['ContentReveal', revealSource],
    ['PressableScale', pressableSource],
  ]) {
    assert.ok(source.includes('useNativeDriver: true'), `${name} must use the native driver`);
    assert.equal(
      source.includes('useNativeDriver: false'),
      false,
      `${name} must never animate on the JS thread`,
    );
  }
});

check('ContentReveal reads its timings from the tokens, not literals', () => {
  assert.match(revealSource, /motion\.contentRevealDuration/);
  assert.match(revealSource, /motion\.contentRevealOffset/);
  // No hand-rolled durations.
  assert.equal(/duration:\s*\d+/.test(revealSource), false, 'literal duration in ContentReveal');
});

console.log('reduce motion');

check('Reduce Motion drops translation but never delays the state change', () => {
  assert.match(revealSource, /useReduceMotion/);
  // With reduced motion the reveal jumps straight to fully visible.
  assert.match(revealSource, /reduceMotion[\s\S]{0,120}progress\.setValue\(1\)/);
  // ...and the transform is omitted entirely rather than merely shortened.
  assert.match(revealSource, /reduceMotion\s*\?\s*\{\s*opacity: progress\s*\}/);
});

// P0 regression guard — see scripts/perceived-loading.test.mjs for the full
// story. An interrupted reveal must never strand content at partial opacity.
check('a cancelled reveal always settles at fully visible', () => {
  assert.match(revealSource, /animation\.stop\(\);\s*\n\s*progress\.setValue\(1\);/);
});

check('there is exactly one reveal behaviour — no partial-opacity variant', () => {
  // A `swap` mode that started at 0.55 was the source of the gray-Summary
  // regression. Reveals start transparent and finish opaque; nothing else.
  assert.equal(/SWAP_START_OPACITY/.test(revealSource), false);
  assert.equal(/isSwap/.test(revealSource), false);
  assert.match(revealSource, /progress\.setValue\(0\);/);
});

check('rapid re-reveals cancel rather than stack', () => {
  assert.match(revealSource, /\}, \[progress, reduceMotion, revealKey\]\);/);
});

check('the Reduce Motion hook tracks live changes, not just the initial value', () => {
  assert.match(motionSource, /AccessibilityInfo\.isReduceMotionEnabled/);
  assert.match(motionSource, /addEventListener\('reduceMotionChanged'/);
  assert.match(motionSource, /sub\.remove\(\)/); // no listener leak
});

console.log('loading philosophy');

check('skeletons are content-shaped and static, not spinners', () => {
  assert.match(skeletonSource, /CourseCardSkeleton/);
  // Assert against what the module IMPORTS — the prose above these components
  // names both of these deliberately, so a whole-file match would be prose, not
  // behaviour. A pulsing placeholder is animation carrying no information.
  const imports = skeletonSource.match(/^import[\s\S]*?;$/gm)?.join('\n') ?? '';
  assert.equal(/\bAnimated\b/.test(imports), false, 'skeletons must not animate');
  assert.equal(/\bActivityIndicator\b/.test(imports), false, 'skeletons must not spin');
});

check('skeletons are hidden from VoiceOver', () => {
  assert.match(skeletonSource, /accessibilityElementsHidden/);
  assert.match(skeletonSource, /importantForAccessibility="no-hide-descendants"/);
});

check('Courses uses a stable, non-animated collection container', () => {
  const courses = read('../app/(tabs)/courses.tsx');
  assert.equal(
    /ActivityIndicator/.test(courses),
    false,
    'Courses must use content-shaped skeletons, not a centred spinner',
  );
  assert.match(courses, /CourseCardSkeleton/);
  assert.match(courses, /<View style=\{styles\.grid\}>/);
  // ContentReveal may wrap the static page heading above the grid (keyed on
  // tab focus only), but the grid itself must stay a stable plain View.
  const gridStart = courses.indexOf('<View style={styles.grid}>');
  for (const [open, close] of contentRevealSpans(courses)) {
    assert.ok(
      !(open < gridStart && gridStart < close),
      `a ContentReveal span [${open}, ${close}] wraps the grid at ${gridStart}`,
    );
  }
  assert.equal(/LayoutAnimation\.configureNext/.test(courses), false);
});

console.log(`\nmotion system: ${passed} checks passed`);
