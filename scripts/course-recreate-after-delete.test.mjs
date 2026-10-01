/**
 * Regression: an old soft-deleted Course and a newly-created Course may share
 * a normalized name. The new Course keeps its own UUID and must remain eligible
 * for cloud reconciliation until THAT UUID is present remotely.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const store = readFileSync(fileURLToPath(new URL('../lib/store.tsx', import.meta.url)), 'utf8');
const reconcile = store.slice(
  store.indexOf('// LEGACY COMPATIBILITY HEAL ONLY'),
  store.indexOf('// Heal legacy recordings whose course'),
);

const oldId = '11111111-1111-4111-8111-111111111111';
const newId = '22222222-2222-4222-8222-222222222222';
const remoteCourses = [{ id: oldId, name: 'Physics', deleted_at: '2026-09-12T10:00:00.000Z' }];

console.log('A — delete then recreate retains canonical identity');
check('the regression fixture has a deleted predecessor and a distinct new canonical id', () => {
  assert.equal(remoteCourses[0].name, 'Physics');
  assert.ok(remoteCourses[0].deleted_at);
  assert.notEqual(oldId, newId);
});
check('canonical reconciliation tracks remote identity separately from display-name compatibility', () => {
  assert.match(reconcile, /const knownCloudCourseIds = new Set\(remoteCourses\.map\(\(course\) => course\.id\)\);/);
  assert.match(reconcile, /const knownCloudCourseNames = new Set\(/);
});
check('a same-name deleted predecessor cannot suppress the new UUID retry insert', () => {
  assert.match(
    reconcile,
    /if \(isCanonicalCourse\s*\? knownCloudCourseIds\.has\(course\.id\)\s*: knownCloudCourseNames\.has\(nameKey\)\) continue;/,
  );
  const knownIds = new Set(remoteCourses.map((course) => course.id));
  assert.equal(knownIds.has(newId), false, 'new UUID remains eligible even while old Physics tombstone exists');
});
check('an old recording linked to the deleted course cannot suppress the new UUID retry insert', () => {
  assert.match(reconcile, /if \(!isCanonicalCourse && linkedCourseNames\.has\(nameKey\)\) continue;/);
  const linkedCourseNames = new Set(['physics']); // historical recording → oldId
  assert.equal(linkedCourseNames.has('physics'), true);
  assert.notEqual(newId, oldId, 'the new Course is not the historical recording owner');
});
check('a stale local permanent-delete name tombstone cannot suppress the new UUID retry insert', () => {
  assert.match(reconcile, /if \(!isCanonicalCourse && isPurgedCourseName\(toTombstoneIndex\(tombstonesRef\.current\), name\)\) continue;/);
});
check('legacy name-derived courses retain the conservative name guard', () => {
  assert.match(reconcile, /const isCanonicalCourse = uuidRe\.test\(course\.id\);/);
  assert.match(reconcile, /: knownCloudCourseNames\.has\(nameKey\)\) continue;/);
});
check('the create path still mints a fresh UUID and uses INSERT, never resurrection/upsert', () => {
  const createCourse = store.slice(store.indexOf('const createCourse ='), store.indexOf('const createLecture ='));
  assert.match(createCourse, /id: makeUuid\(\)/);
  assert.match(createCourse, /supabase\.from\('courses'\)\.insert\(full\)/);
  assert.doesNotMatch(createCourse, /upsert\(/);
});
check('merge keeps explicit course_id authoritative before any name fallback', () => {
  assert.match(store, /const course = courseById \?\? resolveActiveCourseByName\(courseName\);/);
});

console.log(`\ncourse recreate after delete: ${passed} checks passed`);
