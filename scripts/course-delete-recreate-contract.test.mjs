import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const store = readFileSync(fileURLToPath(new URL('../lib/store.tsx', import.meta.url)), 'utf8');
const models = readFileSync(fileURLToPath(new URL('../lib/models.ts', import.meta.url)), 'utf8');
const coursesUi = readFileSync(fileURLToPath(new URL('../app/(tabs)/courses.tsx', import.meta.url)), 'utf8');
let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const deleteFn = store.slice(store.indexOf('const deleteCourse ='), store.indexOf('const retryCourseDeletion ='));
const createFn = store.slice(store.indexOf('const createCourse ='), store.indexOf('const createLecture ='));
const restoreFn = store.slice(store.indexOf('const restoreCourse ='), store.indexOf('const restoreLecture ='));
const syncFn = store.slice(store.indexOf('const syncCourseDeletion ='), store.indexOf('const applyRemoteRecordings ='));

console.log('Course delete / same-name recreate contract');
check('A/E: deleting a course tombstones only the parent UUID and never mutates lectures', () => {
  // The lecture list is now READ (to enforce the non-empty product rule) but
  // must still never be WRITTEN: lectures and their course_id stay intact so
  // historical ownership and restore survive.
  assert.doesNotMatch(deleteFn, /setLectures/);
  // …and that read must be UUID-scoped, never name-based.
  assert.match(deleteFn, /lecture\.courseId === id && !lecture\.deletedAt/);
  assert.match(deleteFn, /deletedAt: now,[\s\S]*deletionUpdatedAt: now/);
  assert.match(deleteFn, /syncCourseDeletion\(id, now, now\)/);
  assert.match(deleteFn, /deletionSyncState: currentUserId \? 'pending' : undefined/);
});
check('B: pending deletion is persisted on Course and retried by cloud refresh', () => {
  assert.match(models, /deletionSyncState\?: 'pending' \| 'failed'/);
  assert.match(store, /if \(!course\.deletedAt \|\| !course\.deletionUpdatedAt \|\| !course\.deletionSyncState\) continue;/);
  assert.match(store, /void syncCourseDeletion\(course\.id, course\.deletedAt, course\.deletionUpdatedAt\)/);
});
check('C/D/H: recreate never creates a transient duplicate while old UUID is pending or active', () => {
  // 2026-09-12 PHYSICAL FAIL: these three reasons used to be asserted inline
  // here while the guard resolved its predecessor with Array#find — the first
  // row sharing the name. With several tombstones under one name the active
  // (or still-pending) row sorts last, so every guard read "clear". The
  // decision now lives in lib/courseCreateGuard.mjs, which considers EVERY
  // same-name row and is exercised behaviourally against the owner's real
  // device state in course-create-guard-multi-samename.test.mjs.
  assert.match(createFn, /sameNameCreateBlock\(coursesRef\.current, normalizedName, normalizedCourseName\)/);
  assert.match(createFn, /if \(blocked\) return \{ ok: false, reason: blocked \}/);
  assert.doesNotMatch(
    createFn,
    /coursesRef\.current\.find\(\(course\) =>/,
    'the same-name predecessor must never be resolved by first match again',
  );
  const guard = readFileSync(fileURLToPath(new URL('../lib/courseCreateGuard.mjs', import.meta.url)), 'utf8');
  assert.match(guard, /return 'same_name_active'/);
  assert.match(guard, /return 'delete_pending'/);
  assert.match(guard, /return 'delete_failed'/);
  assert.match(guard, /\.filter\(/, 'must weigh every same-name row, not just one');
  assert.doesNotMatch(guard, /\.find\(/, 'first-match resolution is the regression this guard exists to prevent');
  assert.match(createFn, /id: makeUuid\(\)/);
});
check('F/G: canonical recording ownership remains UUID-first', () => {
  assert.match(store, /const courseById = row\.course_id \? coursesById\.get\(row\.course_id\) : undefined;/);
  assert.match(store, /const course = courseById \?\? resolveActiveCourseByName\(courseName\);/);
});
check('I: restore conflict leaves old course deleted until cloud confirms', () => {
  assert.match(restoreFn, /await syncCourseDeletion\(id, null, now\)/);
  const cloudRestore = restoreFn.slice(restoreFn.indexOf('// Keep the old UUID deleted locally'));
  assert.doesNotMatch(cloudRestore, /deletedAt: null/);
  assert.match(syncFn, /error\?\.code === '23505' && deletedAt == null/);
});
check('J: schema fallback includes all required visual fields and does not retry 23505', () => {
  assert.match(createFn, /if \(error\.code === '23505'\) return;/);
  assert.match(createFn, /icon: course\.icon, tint: course\.tint, accent: course\.accent/);
  assert.match(store, /if \(res\.error && res\.error\.code !== '23505'\)/);
  assert.doesNotMatch(store, /insert\(\{ id: cloudId, user_id: currentUserId, name \}\)/);
});
// PRODUCT DECISION REVERSAL (2026-09-13): a course containing active lectures
// is NOT deletable. The earlier call to treat `course_not_empty` as stale
// legacy was wrong for product behavior, so this check is inverted — the UI
// must block again, and the store must be authoritative. Everything else in
// this file (durable pending delete, exact-UUID confirmation, same-name
// recreate, restore collision) is unchanged and still enforced above.
check('UI blocks non-empty course delete, before and after the store call', () => {
  assert.match(coursesUi, /showCourseNotEmptyAlert/);
  assert.match(coursesUi, /confirmDeleteCourse = \(courseId: string, activeLectureCount: number\)/);
  assert.match(coursesUi, /if \(activeLectureCount > 0\) \{\s*\n\s*showCourseNotEmptyAlert\(\);/);
  assert.match(coursesUi, /if \(!result\.ok\) showCourseNotEmptyAlert\(\)/);
  assert.match(coursesUi, /confirmDeleteCourse\(course\.id, lectureCount\)/);
});
console.log(`\ncourse delete/recreate contract: ${passed} checks passed`);
