/**
 * Courses collection stability: after initial visibility, create/delete/
 * restore/rename/cloud replacement must update children inside a stable grid
 * that has no collection-wide opacity or layout animation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const courses = read('../app/(tabs)/courses.tsx');
const store = read('../lib/store.tsx');

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
};

// Every <ContentReveal>...</ContentReveal> span in the file, paired in
// document order. Using indexOf() for this would only ever find the FIRST
// occurrence — blind to a second, illegitimate ContentReveal usage once one
// legitimate one (around the heading) already exists in the file.
const contentRevealSpans = (source) => {
  const opens = [...source.matchAll(/<ContentReveal\b/g)].map((m) => m.index);
  const closes = [...source.matchAll(/<\/ContentReveal>/g)].map((m) => m.index);
  assert.equal(opens.length, closes.length, 'ContentReveal open/close tag count mismatch');
  return opens.map((open, i) => [open, closes[i]]);
};

console.log('courses mutation visibility');

check('the live Course collection uses a stable plain View', () => {
  assert.match(courses, /<View style=\{styles\.grid\}>[\s\S]*courses\.map/);
});

check('the grid is never wrapped in ContentReveal — only the static page heading may be, keyed on tab focus, never on course/lecture data', () => {
  const gridStart = courses.indexOf('<View style={styles.grid}>');
  assert.ok(gridStart > -1);

  // Every ContentReveal span in the file — not just the first — must close
  // before the grid opens. A wrap-around (`<ContentReveal>` before the grid,
  // `</ContentReveal>` after it) would otherwise slip past a check that only
  // inspects the first occurrence of the opening or closing tag.
  for (const [open, close] of contentRevealSpans(courses)) {
    assert.ok(
      !(open < gridStart && gridStart < close),
      `a ContentReveal span [${open}, ${close}] wraps the grid at ${gridStart}`,
    );
  }

  const revealIdx = courses.indexOf('<ContentReveal');
  if (revealIdx > -1) {
    assert.ok(revealIdx < gridStart, 'any ContentReveal usage must appear before the grid, wrapping only the heading');
    const revealRegion = courses.slice(revealIdx, gridStart);
    assert.match(revealRegion, /<PageHeading/, 'ContentReveal above the grid must wrap PageHeading, nothing data-shaped');
    assert.match(revealRegion, /revealKey=\{focusKey\}/, 'must key on the focus-only counter');
    assert.doesNotMatch(revealRegion, /revealKey=\{courses\.length\}|revealKey=\{lectures\.length\}/);
  }
});

check('focusKey is bumped only by tab focus, never by course/lecture mutations', () => {
  assert.match(courses, /const \[focusKey, setFocusKey\] = useState\(0\);/);
  const focusEffect = courses.slice(
    courses.indexOf('useFocusEffect('),
    courses.indexOf('const openCourse ='),
  );
  assert.match(focusEffect, /setFocusKey\(\(key\) => key \+ 1\);/);
  assert.doesNotMatch(focusEffect, /courses\.length|lectures\.length|deleteCourse|createCourse/);
});

check('no global next-layout animation can spill into a later transaction', () => {
  assert.equal(/LayoutAnimation/.test(courses), false);
  assert.equal(/configureNext/.test(courses), false);
});

check('the grid has no whole-collection invisible style', () => {
  const gridStyle = courses.match(/grid:\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.equal(/opacity|height:\s*0|display|position:\s*'absolute'/.test(gridStyle), false);
});

check('the store commits local soft-delete before starting its cloud write', () => {
  const remove = store.slice(store.indexOf('const deleteCourse ='), store.indexOf('const restoreCourse ='));
  const localCommit = remove.indexOf('setCourses((prev) =>');
  const remoteWrite = remove.indexOf('writeCourseDeletion(currentUserId, id, courseName, now, now)');
  assert.ok(localCommit >= 0 && remoteWrite > localCommit, 'local state must commit before remote sync');
  assert.equal(/await\s+writeCourseDeletion/.test(remove), false, 'UI must never wait for cloud deletion');
});

check('create and delete both mutate the same continuously-rendered array', () => {
  assert.match(courses, /courses\.length/);
  assert.match(courses, /courses\.map\(\(course, index\)/);
  assert.match(store, /setCourses\(\(prev\) => \[\.\.\.prev, course\]\)/);
  assert.match(store, /c\.id === id \? \{ \.\.\.c, deletedAt:/);
});

console.log(`\ncourses mutation visibility: ${passed} checks passed`);
