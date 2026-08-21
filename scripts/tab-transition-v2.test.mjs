/**
 * Main tab transition V2.
 *
 * Owner feedback on V1 (heading-only ContentReveal): "still too abrupt —
 * the page body still appears instantly, so the transition feels
 * disconnected." The fix is coverage, not speed: PageShellTransition wraps
 * the WHOLE page shell (heading + the dynamic body below it) in one
 * translate-only settle, so title and body move together. It is a
 * DIFFERENT component from ContentReveal, and that difference is load-
 * bearing — PageShellTransition never touches opacity, so it is safe to
 * wrap a mutation-driven collection (the Courses grid) in it, which
 * ContentReveal (opacity-based) is explicitly forbidden to do — see
 * course-delete-interaction.test.mjs and the white-screen regression it
 * guards against.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const shellSource = stripComments(read('../components/PageShellTransition.tsx'));
const motionSource = read('../constants/motion.ts');
const sidebar = read('../components/YLSidebar.tsx');
const courses = stripComments(read('../app/(tabs)/courses.tsx'));
const home = stripComments(read('../app/(tabs)/index.tsx'));
const settings = stripComments(read('../app/(tabs)/settings.tsx'));

// Every <Tag>...</Tag> span for a given component name, paired in document
// order. indexOf() would only ever find the first occurrence.
const spansOf = (source, name) => {
  const opens = [...source.matchAll(new RegExp(`<${name}\\b`, 'g'))].map((m) => m.index);
  const closes = [...source.matchAll(new RegExp(`</${name}>`, 'g'))].map((m) => m.index);
  assert.equal(opens.length, closes.length, `${name} open/close tag count mismatch`);
  return opens.map((open, i) => [open, closes[i]]);
};

console.log('PageShellTransition — translate-only, opacity never touched');

check('the component never sets an opacity style, animated or otherwise', () => {
  // The whole safety case for wrapping dynamic content in this (instead of
  // ContentReveal) rests on this being categorically true, not just true in
  // the common case — so this checks the entire file, not just one branch.
  assert.equal(/opacity/.test(shellSource), false, 'PageShellTransition must never reference opacity');
});

check('it only ever produces a translateY transform', () => {
  assert.match(shellSource, /transform: \[\s*\{\s*translateY:/);
  assert.equal(/scale/.test(shellSource), false, 'no scale — translate only, per the V2 spec');
});

check('it reads its timing from tokens, not literals', () => {
  assert.match(shellSource, /motion\.pageShellDuration/);
  assert.match(shellSource, /motion\.pageShellOffset/);
  assert.equal(/duration:\s*\d+/.test(shellSource), false, 'literal duration in PageShellTransition');
});

check('it runs on the native driver only', () => {
  assert.match(shellSource, /useNativeDriver: true/);
  assert.equal(/useNativeDriver: false/.test(shellSource), false);
});

check('Reduced Motion: no transform is applied — content sits at rest immediately, opacity was never a variable to begin with', () => {
  assert.match(shellSource, /reduceMotion\s*\n?\s*\?\s*null/);
});

check('a cancelled/interrupted settle stops cleanly rather than stacking — rapid focus changes redirect, never queue', () => {
  assert.match(shellSource, /animation\.stop\(\);/);
  assert.match(shellSource, /progress\.setValue\(1\);/);
});

check('tokens are within the V2 agreed range (180–220ms, 6–10pt)', () => {
  const ms = Number(motionSource.match(/pageShellDuration:\s*(\d+)/)[1]);
  const offset = Number(motionSource.match(/pageShellOffset:\s*(\d+)/)[1]);
  assert.ok(ms >= 180 && ms <= 220, `pageShellDuration ${ms}ms outside the V2 range`);
  assert.ok(offset >= 6 && offset <= 10, `pageShellOffset ${offset}pt outside the V2 range`);
});

console.log('coverage — the body transitions too, not just the heading (the actual V2 fix)');

for (const [name, source, bodyMarker] of [
  ['Courses', courses, '<View style={styles.grid}'],
  ['Record/Home', home, 'recentLectures.length'],
  ['Settings', settings, 'SettingRow icon="person-outline"'],
]) {
  check(`${name}: PageShellTransition wraps both the heading and the dynamic body below it`, () => {
    const spans = spansOf(source, 'PageShellTransition');
    assert.ok(spans.length >= 1, `${name} has no PageShellTransition`);
    const headingIdx = source.indexOf('<PageHeading');
    const bodyIdx = source.indexOf(bodyMarker);
    assert.ok(headingIdx > -1, `${name}: PageHeading not found`);
    assert.ok(bodyIdx > -1, `${name}: body marker not found`);
    const coversBoth = spans.some(([open, close]) => open < headingIdx && bodyIdx < close);
    assert.ok(coversBoth, `${name}: no single PageShellTransition span covers both the heading and the body — V1's heading-only bug would be back`);
  });
}

console.log('Courses white-screen hard guard — still absolute under V2');

check('the grid sits inside PageShellTransition (safe, translate-only) but outside every ContentReveal span (opacity-risk)', () => {
  const gridStart = courses.indexOf('<View style={styles.grid}>');
  assert.ok(gridStart > -1);

  const shellSpans = spansOf(courses, 'PageShellTransition');
  assert.ok(
    shellSpans.some(([open, close]) => open < gridStart && gridStart < close),
    'the grid must be inside PageShellTransition — that is the whole V2 fix for Courses',
  );

  const revealOpens = [...courses.matchAll(/<ContentReveal\b/g)].map((m) => m.index);
  const revealCloses = [...courses.matchAll(/<\/ContentReveal>/g)].map((m) => m.index);
  assert.equal(revealOpens.length, revealCloses.length, 'ContentReveal open/close tag count mismatch');
  for (let i = 0; i < revealOpens.length; i += 1) {
    assert.ok(
      !(revealOpens[i] < gridStart && gridStart < revealCloses[i]),
      `a ContentReveal span [${revealOpens[i]}, ${revealCloses[i]}] wraps the grid at ${gridStart}`,
    );
  }
});

check('no second, PageShellTransition-flavoured opacity wrapper was smuggled in around the grid via inline style', () => {
  const gridStart = courses.indexOf('<View style={styles.grid}>');
  const gridBlockEnd = courses.indexOf('</PageShellTransition>');
  const gridRegion = courses.slice(gridStart, gridBlockEnd);
  assert.equal(/opacity:\s*(0|progress|indicator|focusKey)/.test(gridRegion), false);
});

check('the grid remains a plain, unkeyed View — courses.length/lectures.length never drive any reveal', () => {
  assert.doesNotMatch(courses, /revealKey=\{courses\.length\}/);
  assert.doesNotMatch(courses, /revealKey=\{lectures\.length\}/);
});

console.log('tab selected-state feedback — immediate; only the decorative indicator eases');

check('icon color is a plain synchronous ternary, not an Animated/interpolated value — the state change itself is instant', () => {
  const codeOnly = sidebar.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const occurrences = (codeOnly.match(/color=\{item\.selected \? colors\.accent : colors\.textSecondary\}/g) ?? []).length;
  assert.equal(occurrences, 2, 'expected exactly one instant color ternary in SidebarNavRow and one in BottomTabItem');
});

check('navigation fires synchronously from onPress — never delayed by the indicator animation', () => {
  assert.match(sidebar, /onPress: \(\) => \{\s*\n\s*const event = navigation\.emit/);
  assert.doesNotMatch(sidebar, /setTimeout[\s\S]{0,60}navigation\.navigate/);
});

check('the selected indicator (background tint / active bar / pill) is what animates, via opacity, separately from the instant state change', () => {
  assert.match(sidebar, /function useSelectedIndicator/);
  assert.match(sidebar, /Animated\.timing\(progress, \{/);
  assert.match(sidebar, /toValue: selected \? 1 : 0/);
  assert.match(sidebar, /useNativeDriver: true/);
  assert.match(sidebar, /style=\{\[styles\.navRowActiveOverlay, \{ opacity: indicator \}\]\}/);
  assert.match(sidebar, /style=\{\[styles\.bottomTabActiveOverlay, \{ opacity: indicator \}\]\}/);
});

check('the indicator reads its duration from a token, not a literal', () => {
  assert.match(sidebar, /motion\.tabIndicatorDuration/);
  assert.match(motionSource, /tabIndicatorDuration:\s*\d+/);
});

check('rapid tab switching cannot stack indicator animations — no sequence/loop/delay construct exists', () => {
  assert.equal(/Animated\.sequence|Animated\.loop|Animated\.delay/.test(sidebar), false);
});

console.log(`\ntab transition V2: ${passed} checks passed`);
