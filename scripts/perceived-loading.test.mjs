/**
 * Native-feel refinement — perceived loading.
 *
 * Three places still let the user watch technical work happen:
 *
 *   1. Store hydration flipped `loaded` only AFTER the Supabase round-trip, so
 *      Courses sat on skeletons for the whole request while the on-device cache
 *      was already in hand.
 *   2. The lecture tab body dropped to opacity 0 on every tab switch, blinking
 *      between two tabs the user perceives as siblings.
 *   3. TranscriptReadList started `listMountReady` at false unconditionally, so
 *      even a warm cache rendered a frame of skeleton over prepared text.
 *
 * These are ordering/state guards, not timing assertions.
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

/**
 * Strip comments before any ordering analysis.
 *
 * These files explain themselves in prose that quotes the very identifiers
 * being asserted on ("...after `await applyRemoteRecordings(...)`..."), so a
 * raw indexOf finds the comment, not the code, and silently compares the wrong
 * positions. Ordering claims must be made about code only.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

const storeRaw = read('../lib/store.tsx');
const store = stripComments(storeRaw);
const reveal = read('../components/ContentReveal.tsx');
const transcript = read('../components/TranscriptReadList.tsx');
const courses = stripComments(read('../app/(tabs)/courses.tsx'));

// The hydration effect only — from the sequence bump to the foreground-refresh
// effect that follows it.
const hydration = store.slice(
  store.indexOf('const sequence = ++hydrateSequence.current;'),
  store.indexOf('const subscription = AppState.addEventListener'),
);

// ─────────────────────────────────────────────────────────────────────────────
console.log('store hydration — stale-while-revalidate');

check('local cache is committed and `loaded` flips BEFORE the remote await', () => {
  const commitAt = hydration.indexOf('setLectures(normalizedLocalLectures)');
  const remoteAt = hydration.indexOf('await applyRemoteRecordings');
  assert.ok(commitAt > 0 && remoteAt > 0, 'hydration shape changed');
  assert.ok(commitAt < remoteAt, 'local cache must be committed before the cloud request');
  // Specifically the setLoaded that follows the local commit — the file also
  // has an early-return one for the signed-out scope and a final safety net in
  // the `finally`, and matching either of those would prove nothing.
  const loadedAfterCommit = hydration.indexOf('setLoaded(true)', commitAt);
  assert.ok(loadedAfterCommit > 0, 'no setLoaded after the local commit');
  assert.ok(loadedAfterCommit < remoteAt, '`loaded` must not wait on the cloud request');
});

check('the remote result reconciles into visible content, never behind a skeleton', () => {
  const remoteAt = hydration.indexOf('await applyRemoteRecordings');
  const tail = hydration.slice(remoteAt);
  assert.match(tail, /setCourses\(merged\.courses\)/);
  assert.match(tail, /setLectures\(merged\.lectures\)/);
  // Nothing may clear content or re-gate the UI once it is already visible.
  assert.equal(/setLoaded\(false\)/.test(tail), false, 'must not re-gate after first paint');
  assert.equal(/setCourses\(\[\]\)/.test(tail), false, 'must not clear visible content');
});

check('the merge reads primed live refs, not the post-reset empty arrays', () => {
  // The ref-sync effect only runs after a render, so without priming these
  // would still be `[]` and the merge would drop every not-yet-uploaded
  // lecture as "absent locally".
  const primeCourses = hydration.indexOf('coursesRef.current = storedCourses');
  const primeLectures = hydration.indexOf('lecturesRef.current = normalizedLocalLectures');
  const remoteAt = hydration.indexOf('await applyRemoteRecordings');
  assert.ok(primeCourses > 0 && primeCourses < remoteAt, 'coursesRef primed before merge');
  assert.ok(primeLectures > 0 && primeLectures < remoteAt, 'lecturesRef primed before merge');
  assert.match(hydration, /applyRemoteRecordings\(coursesRef\.current, lecturesRef\.current\)/);
});

check('the sequence + mounted guard is re-checked after the await', () => {
  const remoteAt = hydration.indexOf('await applyRemoteRecordings');
  const tail = hydration.slice(remoteAt);
  assert.match(tail, /if \(!mounted \|\| hydrateSequence\.current !== sequence\) return;/);
});

check('a failed cloud restore keeps the local cache visible', () => {
  // Checked against the raw source: this one is deliberately about the
  // documented intent sitting on the catch block.
  assert.match(storeRaw, /catch \{[\s\S]{0,240}Never fall back to global cache/);
  // And structurally: the reconcile's own catch must not clear or re-gate
  // anything. Slice to its closing brace — a fixed-width window would run on
  // into the outer catch and the `finally`'s setLoaded safety net.
  const remoteAt = hydration.indexOf('await applyRemoteRecordings');
  const catchAt = hydration.indexOf('catch {', remoteAt);
  const catchBody = hydration.slice(catchAt, hydration.indexOf('}', catchAt));
  assert.equal(/set(Courses|Lectures|Loaded)\(/.test(catchBody), false, catchBody);
});

check('the reconcile preserves the user’s selected course', () => {
  // Re-deriving unconditionally would yank the selection when the response lands.
  const remoteAt = hydration.indexOf('await applyRemoteRecordings');
  const tail = hydration.slice(remoteAt);
  assert.match(tail, /setSelectedCourseId\(\(current\) =>/);
  assert.match(tail, /merged\.courses\.some\(\(course\) => course\.id === current && !course\.deletedAt\)/);
});

check('account-switch isolation is untouched — state still clears up front', () => {
  // Stale-while-revalidate must never mean one user briefly sees another's data.
  const resetAt = store.indexOf('setLoaded(false)');
  const commitAt = store.indexOf('setLectures(normalizedLocalLectures)');
  assert.ok(resetAt > 0 && resetAt < commitAt, 'scope reset must still precede any commit');
  assert.match(store, /setCourses\(\[\]\);\s*\n\s*setLectures\(\[\]\);/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('courses — no skeleton over real content');

check('the skeleton is shown only when the store is genuinely not loaded', () => {
  assert.match(courses, /\{!loaded \?/);
  // No second, refresh-driven skeleton path.
  assert.equal((courses.match(/CourseCardSkeleton/g) ?? []).length, 2, 'import + one render site');
});

check('Course collection mutations cannot replay a full-grid reveal', () => {
  assert.match(courses, /<View style=\{styles\.grid\}>/);
  // ContentReveal may wrap the static page heading (keyed on tab focus only —
  // see course-delete-interaction.test.mjs), but never the grid itself.
  const gridStart = courses.indexOf('<View style={styles.grid}>');
  for (const [open, close] of contentRevealSpans(courses)) {
    assert.ok(
      !(open < gridStart && gridStart < close),
      `a ContentReveal span [${open}, ${close}] wraps the grid at ${gridStart}`,
    );
  }
  assert.equal(/LayoutAnimation\.configureNext/.test(courses), false);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('transcript — warm cache never flashes a skeleton');

check('listMountReady starts true when the cache is already warm', () => {
  assert.match(
    transcript,
    /useState\(\s*\(\) => Boolean\(getCachedTranscriptReadItems\(cacheKey\)\),?\s*\)/,
  );
});

check('a cacheKey change only drops to the shell when the new key is cold', () => {
  assert.match(
    transcript,
    /setListMountReady\(Boolean\(getCachedTranscriptReadItems\(cacheKey\)\)\);/,
  );
  assert.equal(/setListMountReady\(false\);/.test(transcript), false);
});

check('the cold path still defers native cells by one frame', () => {
  // The shell-first commit must survive for genuinely cold opens.
  assert.match(transcript, /requestAnimationFrame\(\(\) => setListMountReady\(true\)\)/);
  assert.match(transcript, /if \(!listMountReady \|\| !items\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('reveal modes');

check('the reveal has one behaviour and always ends fully visible', () => {
  // The `swap` mode that started at 0.55 opacity caused the gray-Summary P0
  // and has been removed along with the tab-body reveal that used it.
  assert.equal(/'swap'/.test(reveal), false);
  assert.equal(/SWAP_START_OPACITY/.test(reveal), false);
  assert.match(reveal, /animation\.stop\(\);\s*\n\s*progress\.setValue\(1\);/);
});

check('both modes still run on the native driver', () => {
  assert.match(reveal, /useNativeDriver: true/);
  assert.equal(/useNativeDriver: false/.test(reveal), false);
});

console.log(`\nperceived loading: ${passed} checks passed`);
