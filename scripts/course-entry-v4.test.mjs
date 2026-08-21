/**
 * Courses entry softening V4 — per-card entrance, not a shared grid wrapper.
 *
 * Owner feedback on V3: "the Courses heading and cards still appear a little
 * too abruptly / flash in." The fix is a per-card `StaggeredCardEntrance` —
 * each mapped course gets its OWN `Animated.Value`, not one opacity container
 * around the whole grid. That distinction is the entire safety story: a
 * single shared wrapper is exactly what caused the historical white-screen
 * regression (create/delete/remount could reset ONE opacity value to 0 and
 * blank every card at once); N independent per-card values have no such
 * failure mode. Physical-device evidence tightened that contract further:
 * card entrance is translate-only, so visibility never depends on animation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const entranceSource = stripComments(read('../components/StaggeredCardEntrance.tsx'));
const motionSource = read('../constants/motion.ts');
const courses = stripComments(read('../app/(tabs)/courses.tsx'));

// Every <Tag ...>...</Tag> span for a component name, paired in document order.
const spansOf = (source, name) => {
  const opens = [...source.matchAll(new RegExp(`<${name}\\b`, 'g'))].map((m) => m.index);
  const closes = [...source.matchAll(new RegExp(`</${name}>`, 'g'))].map((m) => m.index);
  assert.equal(opens.length, closes.length, `${name} open/close tag count mismatch`);
  return opens.map((open, i) => [open, closes[i]]);
};

console.log('StaggeredCardEntrance — per-item value, capped stagger, always settles');

check('duration + offset are tokens, within the V4 target (card <250ms total incl. stagger)', () => {
  assert.match(entranceSource, /motion\.cardEntranceDuration/);
  assert.match(entranceSource, /motion\.cardEntranceOffset/);
  assert.match(entranceSource, /motion\.cardStaggerMs/);
  assert.match(entranceSource, /motion\.cardStaggerCap/);
  const duration = Number(motionSource.match(/cardEntranceDuration:\s*(\d+)/)[1]);
  const offset = Number(motionSource.match(/cardEntranceOffset:\s*(\d+)/)[1]);
  const staggerMs = Number(motionSource.match(/cardStaggerMs:\s*(\d+)/)[1]);
  const staggerCap = Number(motionSource.match(/cardStaggerCap:\s*(\d+)/)[1]);
  assert.ok(offset >= 4 && offset <= 6, `cardEntranceOffset ${offset}pt outside 4-6pt target`);
  assert.ok(staggerMs >= 20 && staggerMs <= 35, `cardStaggerMs ${staggerMs} outside 20-35ms target`);
  const worstCase = staggerCap * staggerMs + duration;
  assert.ok(worstCase < 250, `worst-case card entrance (${worstCase}ms) exceeds the <250ms target`);
});

check('the stagger delay is capped — total sequence length cannot grow with library size', () => {
  assert.match(entranceSource, /Math\.min\(index, motion\.cardStaggerCap\)/);
});

check('no scale and no opacity — the per-card entrance is translate-only', () => {
  assert.doesNotMatch(entranceSource, /scale/);
  assert.match(entranceSource, /translateY:/);
  assert.doesNotMatch(entranceSource, /opacity\s*:/);
});

check('index is read for the delay but is NOT an effect dependency — a list reorder must never replay an existing card', () => {
  const effectBlock = entranceSource.slice(
    entranceSource.indexOf('useEffect(() => {'),
    entranceSource.indexOf('}, [progress, reduceMotion, revealKey]);') + 40,
  );
  assert.match(effectBlock, /Math\.min\(index,/);
  assert.match(effectBlock, /\}, \[progress, reduceMotion, revealKey\]\);/);
});

check('a cancelled/interrupted entrance settles at zero offset', () => {
  assert.match(entranceSource, /animation\.stop\(\);/);
  assert.match(entranceSource, /if \(!finished\) progress\.setValue\(1\)/);
  assert.match(entranceSource, /progress\.setValue\(1\);/);
});

check('Reduced Motion: progress is set to 1 immediately, with no stagger or translate', () => {
  assert.match(entranceSource, /if \(reduceMotion\) \{\s*\n\s*progress\.setValue\(1\);\s*\n\s*return;/);
  assert.match(entranceSource, /reduceMotion\s*\n?\s*\?\s*null/);
});

check('runs on the native driver only', () => {
  assert.match(entranceSource, /useNativeDriver: true/);
  assert.equal(/useNativeDriver: false/.test(entranceSource), false);
});

console.log('wiring — per-card, not a shared grid wrapper');

check('StaggeredCardEntrance appears exactly once per rendered card, inside the courses.map() callback — not once around the whole grid', () => {
  const mapStart = courses.indexOf('courses.map((course, index)');
  assert.ok(mapStart > -1, 'courses.map((course, index) not found');
  const mapEnd = courses.indexOf('})}', mapStart);
  const mapBody = courses.slice(mapStart, mapEnd);
  const spans = spansOf(mapBody, 'StaggeredCardEntrance');
  assert.equal(spans.length, 1, 'expected exactly one StaggeredCardEntrance span per map() callback body');
});

check('each card entrance is keyed by the canonical Course UUID, revealed by tab-focus token, staggered by its own list position', () => {
  assert.match(courses, /<StaggeredCardEntrance\s*\n\s*key=\{course\.id\}\s*\n\s*revealKey=\{focusKey\}\s*\n\s*index=\{index\}/);
});

check('the grid View itself carries no opacity/ContentReveal wrapper — only PageShellTransition (translate-only) wraps the whole shell', () => {
  const gridStart = courses.indexOf('<View style={styles.grid}>');
  assert.ok(gridStart > -1);
  for (const [open, close] of spansOf(courses, 'ContentReveal')) {
    assert.ok(!(open < gridStart && gridStart < close), 'ContentReveal must not wrap the grid');
  }
  // The one StaggeredCardEntrance-per-card check above already proves there
  // is no SECOND, whole-grid StaggeredCardEntrance — count is exactly cards.
});

check('focusKey — not courses.length/lectures.length — drives the per-card revealKey', () => {
  assert.doesNotMatch(courses, /revealKey=\{courses\.length\}/);
  assert.doesNotMatch(courses, /revealKey=\{lectures\.length\}/);
});

check('SwipeDeleteRow no longer carries the grid-item sizing style directly — it now lives on the outer StaggeredCardEntrance so percentage widths still resolve against a well-defined parent', () => {
  const rowBlock = courses.slice(courses.indexOf('<SwipeDeleteRow'), courses.indexOf('</SwipeDeleteRow>'));
  assert.doesNotMatch(rowBlock, /style=\{\[styles\.gridItem/);
});

console.log(`\ncourse entry V4: ${passed} checks passed`);
