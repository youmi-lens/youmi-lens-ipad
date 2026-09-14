/**
 * PRODUCT DECISION (2026-09-13): a Course that still contains active lectures
 * CANNOT be deleted. An earlier pass classified `course_not_empty` as stale
 * legacy and removed it; that was wrong for product behavior, so the guard is
 * restored — in BOTH layers, with the store authoritative so a bypassed or
 * stale screen can never tombstone a course that still holds content.
 *
 * Nothing else about course deletion changed: the durable UUID-keyed
 * pending/failed sync, exact-UUID/user cloud confirmation, semantic timestamp
 * confirmation, multi-same-name create guard, and restore collision handling
 * are all still enforced (see course-delete-recreate-contract.test.mjs,
 * course-create-guard-multi-samename.test.mjs and
 * course-deletion-confirm-timestamp.test.mjs).
 *
 * Cases A-F from the task are covered here: A/B (non-empty rejected, nothing
 * written, nothing synced), C (all-lectures-deleted counts as empty), D/E
 * (empty course deletes and its name frees up), F (prior fixes still present).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const store = read('../lib/store.tsx');
const coursesUi = read('../app/(tabs)/courses.tsx');
const deleteFn = store.slice(store.indexOf('const deleteCourse ='), store.indexOf('const retryCourseDeletion ='));

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

/**
 * The store's non-empty rule, extracted exactly as written in deleteCourse:
 *   lecturesRef.current.filter((l) => l.courseId === id && !l.deletedAt).length
 * Kept in lockstep with the assertion below, so if the store's predicate ever
 * changes shape this file fails rather than quietly testing a stale copy.
 */
const activeLectureCount = (lectures, courseId) =>
  lectures.filter((lecture) => lecture.courseId === courseId && !lecture.deletedAt).length;
const deleteAllowed = (lectures, courseId) => activeLectureCount(lectures, courseId) === 0;

check('the store predicate under test is byte-for-byte the one deleteCourse uses', () => {
  assert.match(deleteFn, /lecturesRef\.current\.filter\(\s*\n?\s*\(lecture\) => lecture\.courseId === id && !lecture\.deletedAt,\s*\n?\s*\)/);
  assert.match(deleteFn, /\)\.length;/);
});

check('Release A note: the temporary runtime-evidence diagnostic from the original investigation is NOT part of this release', () => {
  // The 2026-09-13 physical FAIL (owner deleted non-empty courses while a
  // stale process ran old JS) was root-caused as a process/bundle-freshness
  // issue, not a defect in this guard — the guard itself was already
  // correct. The bounded diagnostic recorder built to prove that is
  // deliberately excluded from this stabilization release as unnecessary
  // shipped surface area; the guard is verified here purely behaviorally.
  assert.doesNotMatch(deleteFn, /recordCourseDeleteStoreDecision/);
  assert.doesNotMatch(coursesUi, /recordCourseDeleteUiCheck/);
});

const COURSE = 'a07b2831-7bb4-4a66-8a46-8cac8b91b5b5';
const OTHER = '8c2882d0-b65e-4390-a359-c5b2ad79aa9d';
const active = (id, courseId) => ({ id, courseId, deletedAt: null });
const deleted = (id, courseId) => ({ id, courseId, deletedAt: '2026-09-13T03:42:49.974Z' });

console.log('A/B — a course holding active lectures cannot be deleted');

check('A: exactly one active lecture blocks deletion', () => {
  const lectures = [active('l1', COURSE)];
  assert.equal(activeLectureCount(lectures, COURSE), 1);
  assert.equal(deleteAllowed(lectures, COURSE), false);
});

check('B: multiple active lectures block deletion', () => {
  const lectures = [active('l1', COURSE), active('l2', COURSE), active('l3', COURSE)];
  assert.equal(activeLectureCount(lectures, COURSE), 3);
  assert.equal(deleteAllowed(lectures, COURSE), false);
});

check('A/B: rejection happens BEFORE any local tombstone, pending state, or cloud call', () => {
  // The early return must precede every mutation and the sync call, so a
  // rejected delete leaves no deletedAt, no deletionSyncState, and issues no
  // Supabase UPDATE.
  const rejectIdx = deleteFn.indexOf("return { ok: false, reason: 'course_not_empty'");
  assert.ok(rejectIdx > -1, 'the rejection must exist');
  for (const mutation of ['setCourses(', 'deletedAt: now', "deletionSyncState: currentUserId ? 'pending'", 'syncCourseDeletion(id, now, now)', 'setSelectedCourseId(']) {
    const idx = deleteFn.indexOf(mutation);
    assert.ok(idx > rejectIdx, `"${mutation}" must come after the course_not_empty return`);
  }
});

check('the count is scoped to this course UUID — a sibling course\'s lectures never block it', () => {
  const lectures = [active('l1', OTHER), active('l2', OTHER)];
  assert.equal(deleteAllowed(lectures, COURSE), true);
});

console.log('\nC — a course whose lectures are all in Recently Deleted IS empty');

check('C: only-deleted lectures do not count, so deletion is allowed', () => {
  const lectures = [deleted('l1', COURSE), deleted('l2', COURSE)];
  assert.equal(activeLectureCount(lectures, COURSE), 0);
  assert.equal(deleteAllowed(lectures, COURSE), true);
});

check('C: a mix of active and deleted still blocks while any active one remains', () => {
  const lectures = [deleted('l1', COURSE), active('l2', COURSE)];
  assert.equal(activeLectureCount(lectures, COURSE), 1);
  assert.equal(deleteAllowed(lectures, COURSE), false);
});

console.log('\nD/E — an empty course still deletes, syncs, and frees its name');

check('D: a course with no lectures at all is deletable', () => {
  assert.equal(deleteAllowed([], COURSE), true);
});

check('D: the empty-course path still stamps the durable pending state and syncs the exact UUID', () => {
  assert.match(deleteFn, /deletionSyncState: currentUserId \? 'pending' : undefined/);
  assert.match(deleteFn, /void syncCourseDeletion\(id, now, now\)/);
  assert.match(deleteFn, /deletedAt: now,[\s\S]*deletionUpdatedAt: now/);
});

check('E: recreate-after-confirmed-delete is still governed by the multi-same-name guard', () => {
  const createFn = store.slice(store.indexOf('const createCourse ='), store.indexOf('const createLecture ='));
  assert.match(createFn, /sameNameCreateBlock\(coursesRef\.current, normalizedName, normalizedCourseName\)/);
  assert.match(createFn, /id: makeUuid\(\)/);
});

console.log('\nStore stays authoritative even if the UI is bypassed');

check('the guard lives in the store, not only in the screen', () => {
  assert.match(deleteFn, /reason: 'course_not_empty', activeLectureCount/);
  assert.match(store, /\| \{ ok: false; reason: 'course_not_empty'; activeLectureCount: number \}/);
});

check('the screen blocks up front AND re-checks the store result', () => {
  assert.match(coursesUi, /if \(activeLectureCount > 0\) \{\s*\n\s*showCourseNotEmptyAlert\(\);/);
  assert.match(coursesUi, /if \(!result\.ok\) showCourseNotEmptyAlert\(\)/);
});

check('the not-empty copy exists in every shipped locale', () => {
  for (const locale of ['en', 'es', 'fr', 'ja', 'ko', 'zh-Hans']) {
    const file = read(`../lib/locales/${locale}.mjs`);
    assert.match(file, /'courses\.notEmptyTitle':/, `${locale} missing notEmptyTitle`);
    assert.match(file, /'courses\.notEmptyBody':/, `${locale} missing notEmptyBody`);
  }
});

console.log('\nF — the fixes this restore must not roll back');

check('F: semantic timestamp confirmation is still in place (no byte-string equality)', () => {
  assert.match(store, /confirmed = row != null && confirmsDeletionWrite\(\{/);
  assert.doesNotMatch(store, /row\.deletion_updated_at === deletionUpdatedAt/);
});

check('F: exact UUID + user cloud confirmation is still in place', () => {
  const syncFn = store.slice(store.indexOf('const syncCourseDeletion ='), store.indexOf('const applyRemoteRecordings ='));
  assert.match(syncFn, /\.eq\('id', courseId\)/);
  assert.match(syncFn, /\.eq\('user_id', currentUserId\)/);
});

check('F: Recently Deleted retry and restore collision handling are still in place', () => {
  assert.match(store, /const retryCourseDeletion = useCallback/);
  assert.match(store, /reason: 'name_conflict'/);
});

check('F: fallback create still carries icon/tint/accent', () => {
  const createFn = store.slice(store.indexOf('const createCourse ='), store.indexOf('const createLecture ='));
  const fallback = createFn.slice(createFn.indexOf("if (error.code === '23505') return;"));
  assert.match(fallback, /icon: course\.icon, tint: course\.tint, accent: course\.accent/);
});

console.log(`\ncourse-non-empty-delete-guard: ${passed} checks passed`);
