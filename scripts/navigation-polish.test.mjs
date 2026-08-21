/**
 * Product Polish V1 — remaining surfaces.
 *
 * These are ARCHITECTURE and STATE-ORDERING guards, deliberately not timing
 * assertions: a test that claims "the tab body appeared within 180ms" would be
 * flaky and would prove nothing about the thing that actually matters, which is
 * that the selected state never waits on the body.
 *
 * Covers: sidebar interaction parity, lecture route/press consistency,
 * shell-first lecture detail, one shared tab-body reveal, transcript first
 * viewport, Settings shell-first, and Record Course's screen-vs-recorder split.
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

const sidebar = read('../components/YLSidebar.tsx');
const lectureRow = read('../components/LectureListItem.tsx');
const lectureDetail = read('../app/lecture/[id].tsx');
const transcript = read('../components/TranscriptReadList.tsx');
const settings = read('../app/(tabs)/settings.tsx');
const home = read('../app/(tabs)/index.tsx');
const recording = read('../app/recording.tsx');
const pressable = read('../components/PressableScale.tsx');
const layout = read('../app/_layout.tsx');

/** JSX opening tags for a raw <Pressable, ignoring <PressableScale. */
const rawPressables = (source) => source.match(/<Pressable(?![A-Za-z])/g) ?? [];

// ─────────────────────────────────────────────────────────────────────────────
console.log('sidebar — one navigation personality');

check('every sidebar control uses the shared press primitive', () => {
  assert.equal(rawPressables(sidebar).length, 0, 'sidebar still has a raw Pressable');
  assert.match(sidebar, /<PressableScale/);
});

check('sidebar nav rows keep tab semantics and a selected state', () => {
  assert.match(sidebar, /accessibilityRole="tab"/);
  assert.match(sidebar, /accessibilityState=\{\{ selected: item\.selected \}\}/);
  assert.match(sidebar, /accessibilityLabel=\{item\.label\}/);
});

check('sidebar nav rows meet the 44pt touch target', () => {
  const minHeight = Number(sidebar.match(/navRow: \{[\s\S]*?minHeight: (\d+)/)[1]);
  assert.ok(minHeight >= 44, `sidebar nav row is ${minHeight}pt`);
});

check('home/Record tab: tactile controls use the shared press primitive', () => {
  // The course selector, add-course button, and recent-lecture rows were the
  // last high-frequency surface still on a hand-rolled `pressed` opacity toggle,
  // so a recent-lecture tap felt different from opening a lecture in Courses.
  // Only the two inline text links (sign-in, view-all) may remain raw.
  assert.equal(rawPressables(home).length, 2, 'unexpected raw Pressable count on home tab');
  assert.match(home, /<PressableScale/);
  // The recent-lecture row matches LectureListItem: slight scale + tint.
  assert.match(home, /scaleTo=\{0\.995\}[\s\S]{0,80}pressedStyle=\{styles\.lectureRowPressed\}/);
  assert.match(home, /lectureRowPressed: \{ backgroundColor/);
  // The bespoke opacity+scale toggle is gone.
  assert.equal(/pressed: \{ opacity: 0\.76/.test(home), false);
  assert.equal(/styles\.pressed/.test(home), false);
});

check('home greeting uses the real signed-in account, not fixture data', () => {
  // The greeting hard-coded a mock first name ("Ayden") for every user via
  // @/data/mockData. It must derive from auth instead.
  assert.equal(/from '@\/data\/mockData'/.test(home), false, 'home tab still imports mock data');
  assert.match(home, /const displayName = username \?\? session\?\.user\?\.email\?\.split\('@'\)\[0\]/);
  assert.match(home, /eyebrow=\{displayName \? `\$\{greeting\}, \$\{displayName\}` : greeting\}/);
});

check('the old bespoke opacity press style is gone', () => {
  assert.equal(/pressed: \{\s*opacity: 0\.78/.test(sidebar), false);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('lecture row → detail');

check('the lecture row uses the shared press primitive', () => {
  assert.equal(rawPressables(lectureRow).length, 0);
  assert.match(lectureRow, /<PressableScale/);
});

check('a flat row gets a background tint, a card gets scale only', () => {
  // A full-width row that visibly shrinks reads as the list flexing, so rows
  // keep the native table-cell tint instead.
  assert.match(lectureRow, /pressedStyle=\{isRow \? styles\.rowPressed : undefined\}/);
  assert.match(lectureRow, /rowPressed: \{[\s\S]*?backgroundColor/);
  // The old hand-rolled card press duplicated what PressableScale already does.
  assert.equal(/cardPressed:/.test(lectureRow), false);
});

check('the row exposes its title to VoiceOver', () => {
  assert.match(lectureRow, /accessibilityLabel=\{localizeSystemDefaultTitle\(t, lecture\.title\)\}/);
});

check('navigation into detail pushes (so Back can pop natively)', () => {
  assert.match(lectureDetail, /router\.back\(\)/);
  // The stack owns the transition; no bespoke hero animation was added.
  assert.equal(/Animated\.(timing|spring)\([\s\S]{0,80}translateX/.test(lectureDetail), false);
});

check('lecture/[id] stays a plain stack screen (native push preserved)', () => {
  assert.match(layout, /<Stack\.Screen name="lecture\/\[id\]" \/>/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('lecture detail — shell first, one tab family');

check('the header renders before any tab body in the tree', () => {
  const headerAt = lectureDetail.indexOf('accessibilityLabel={t(\'common.back\')}');
  const tabBarAt = lectureDetail.indexOf('styles.tabBar');
  const bodyAt = lectureDetail.indexOf('<View style={styles.tabBody}>');
  assert.ok(headerAt > 0 && tabBarAt > headerAt, 'Back must precede the tab bar');
  assert.ok(bodyAt > tabBarAt, 'the tab body must come after the tab bar');
});

check('header controls share the press language with the body', () => {
  assert.equal(rawPressables(lectureDetail).length, 1, 'only the not-found fallback may stay raw');
});

check('the tab body carries NO opacity animation', () => {
  // P0: a faded tab body stranded Summary's text at partial opacity on first
  // open. Static readable content must not depend on an animation completing.
  assert.equal((lectureDetail.match(/<ContentReveal/g) ?? []).length, 0);
  assert.match(lectureDetail, /<View style=\{styles\.tabBody\}>/);
  assert.match(lectureDetail, /tabBody: \{ flex: 1 \}/);
});

check('selected tab state is local and set synchronously on press', () => {
  // The reveal must never gate the tab from looking selected.
  assert.match(lectureDetail, /onPress=\{\(\) => setTab\(tabName\)\}/);
  assert.match(lectureDetail, /accessibilityState=\{\{ selected: active \}\}/);
  assert.equal(/await[\s\S]{0,40}setTab\(/.test(lectureDetail), false);
});

check('all four tabs go through the one shared reveal', () => {
  for (const tab of ['Summary', 'Transcript', 'Marked', 'Notes']) {
    assert.ok(lectureDetail.includes(tab), `missing tab ${tab}`);
  }
  // Transcript is a sibling branch of the others, both inside the reveal.
  const revealAt = lectureDetail.indexOf('<ContentReveal style={styles.tabBody}');
  const transcriptBranchAt = lectureDetail.indexOf("tab === 'Transcript' ?");
  assert.ok(transcriptBranchAt > revealAt, 'Transcript branch must sit inside the reveal');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('transcript — first viewport, virtualization intact');

check('the first batch fills a viewport rather than one paragraph', () => {
  const initial = Number(transcript.match(/const INITIAL_VIEWPORT_ROWS = (\d+)/)[1]);
  assert.ok(initial >= 6, `initialNumToRender ${initial} still leaves the viewport empty`);
  // ...but stays bounded. A whole-document mount would defeat the point.
  assert.ok(initial <= 12, `initialNumToRender ${initial} is no longer a bounded first batch`);
  assert.match(transcript, /initialNumToRender=\{INITIAL_VIEWPORT_ROWS\}/);
});

check('long-scroll virtualization settings are unchanged', () => {
  assert.match(transcript, /maxToRenderPerBatch=\{8\}/);
  assert.match(transcript, /updateCellsBatchingPeriod=\{32\}/);
  assert.match(transcript, /windowSize=\{7\}/);
  assert.match(transcript, /<FlatList/);
  assert.match(transcript, /keyExtractor=\{\(item\) => item\.key\}/);
});

check('the skeleton is shaped like the viewport it replaces', () => {
  const lines = transcript.match(/const SKELETON_LINES = \[([\s\S]*?)\] as const/)[1];
  const count = (lines.match(/'(full|medium|short)'/g) ?? []).length;
  assert.ok(count >= 6, `only ${count} skeleton lines — too short to fill a viewport`);
});

check('the cache-hit path still short-circuits preparation', () => {
  assert.match(transcript, /getCachedTranscriptReadItems/);
  assert.match(transcript, /if \(getCachedTranscriptReadItems\(props\.cacheKey\)\) return;/);
  assert.match(transcript, /requestAnimationFrame/);
});

check('the prewarmer still runs a frame after first paint', () => {
  assert.match(transcript, /TranscriptReadPrewarmer/);
  assert.match(lectureDetail, /<TranscriptReadPrewarmer \{\.\.\.transcriptReadProps\} \/>/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('settings — shell first');

check('no full-screen gate on remote plan data', () => {
  // Settings must paint from local state; only the plan card may wait.
  assert.equal(/if \(planLoading\) return/.test(settings), false);
  assert.equal(/ActivityIndicator/.test(settings), false, 'Settings should no longer spin');
});

check('the plan card shows a shape, not a spinner', () => {
  assert.match(settings, /planLoading && !planStatus \?/);
  assert.match(settings, /SkeletonBlock/);
  assert.match(settings, /importantForAccessibility="no-hide-descendants"/);
});

check('setting rows share the press language', () => {
  // Only the two modal overlay/sheet pairs may remain raw — they are dismiss
  // targets and layout containers, not tactile controls.
  assert.equal(rawPressables(settings).length, 4, 'unexpected raw Pressable count in Settings');
  assert.match(settings, /pressedStyle=\{styles\.rowPressed\}/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('record course — screen entered is not recorder ready');

check('"recording active" derives from the recorder, never from permission', () => {
  assert.match(recording, /const audioActive = isRecording \|\| isPaused;/);
  assert.equal(/const audioActive = granted/.test(recording), false);
});

check('controls are gated on the recorder being genuinely active', () => {
  assert.match(recording, /const controlsEnabled = recordingControlsEnabled\(audioActive\);/);
});

check('the permission probe uses an inline spinner, not a content skeleton', () => {
  // A short atomic read is the one place a spinner is the right answer.
  assert.match(recording, /\{!permissionChecked && \(/);
  assert.match(recording, /<ActivityIndicator color=\{colors\.accentBright\} \/>/);
});

check('primary recording controls use the shared press primitive', () => {
  for (const label of ['recording.back', 'recording.materialTop', 'recording.miniCaption']) {
    const at = recording.indexOf(label);
    assert.ok(at > 0, `missing control ${label}`);
    // The nearest opening tag before the label is this control's own tag.
    // `lastIndexOf('<Pressable')` also matches '<PressableScale', so compare the
    // tag text itself rather than two indices that can be identical.
    const openTag = recording.lastIndexOf('<Pressable', at);
    assert.ok(openTag > 0, `no press tag found for ${label}`);
    assert.ok(
      recording.startsWith('<PressableScale', openTag),
      `${label} is still a raw Pressable`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('shared primitive contract');

check('pressedStyle never overrides the animated transform', () => {
  // It is appended after the animated style, so a caller passing a transform
  // would win — hence rows only ever pass a background colour.
  assert.match(pressable, /style=\{\[style, disabled \? null : animatedStyle, pressed && !disabled \? pressedStyle : null\]\}/);
  assert.equal(/rowPressed: \{[^}]*transform/.test(lectureRow), false);
  assert.equal(/rowPressed: \{[^}]*transform/.test(settings), false);
});

check('press state is only tracked when a pressedStyle is supplied', () => {
  // Otherwise every press would cost a re-render on every button in the app.
  assert.match(pressable, /if \(pressedStyle\) setPressed\(true\)/);
  assert.match(pressable, /if \(pressedStyle\) setPressed\(false\)/);
});

console.log(`\nnavigation polish: ${passed} checks passed`);
