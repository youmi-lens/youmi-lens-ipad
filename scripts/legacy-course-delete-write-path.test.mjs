/**
 * P0 — legacy Course delete write-path (real two-device incident).
 *
 * Real staging evidence (user 9789fb5e-…): "Gg" and "Test" have NO row in
 * `courses` at all — both are pre-Stage-4, name-derived from an old
 * `recordings.course` string (course_id = NULL), and the one recording each
 * carries is itself already soft-deleted. Deleting the *course* on iPad only
 * ever mutated local state:
 *
 *   1. A legacy course's client-side id is stableIdFromName('cloud_course',
 *      name) — e.g. "cloud_course_gg" — never a UUID.
 *   2. writeCourseDeletion sent `UPDATE courses ... WHERE id = 'cloud_course_gg'`.
 *      Confirmed directly against staging: courses.id is a uuid column, so
 *      Postgres rejects this outright (22P02 invalid input syntax for uuid),
 *      every time, for both the primary write and its "minimal" retry.
 *   3. The failure was only console.info'd — never surfaced — so the delete
 *      had nowhere durable to live.
 *   4. The next merge on ANY device (including iPad itself, after a relaunch)
 *      re-derives the course fresh and active from the still-present
 *      recordings.course string (mergeRemoteRecordingsIntoStore step 2),
 *      because nothing recorded that it was ever deleted.
 *
 * This is distinct from (and fires *after*) the prior P0 fix documented in
 * cloud-sync-p0-course-reconcile.test.mjs, which reconciles an ACTIVE legacy
 * course to the cloud but explicitly skips anything already deleted locally
 * (`if (course.deletedAt) continue;`) — so a legacy course deleted before
 * that reconciliation ever ran falls into a gap neither fix covered: never
 * synced active, and (until this fix) never syncable deleted either.
 *
 * Fix: classify canonical (UUID courses.id) vs legacy (synthetic id) BEFORE
 * any write — never by reacting to a caught error. Canonical courses are
 * untouched (still just UPDATE). A legacy course's delete/restore routes to
 * writeLegacyCourseDeletion, which looks up any existing row by name first
 * (the merge's own de-dup key) and only INSERTs a fresh canonical tombstone
 * row when a DELETE finds no existing row — never on a lookup/insert failure,
 * never on restore of something with no durable row to restore.
 *
 * Source-level guards (store is a React module, not unit-importable); the
 * real round-trip needs the owner's two-device acceptance pass.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const store = read('../lib/store.tsx');

const writeCourseDeletion = store.slice(
  store.indexOf('function writeCourseDeletion'),
  store.indexOf('function writeCourseDeletion') + store.slice(store.indexOf('function writeCourseDeletion')).indexOf('\n}\n') + 3,
);
const writeLegacyCourseDeletion = store.slice(
  store.indexOf('async function writeLegacyCourseDeletion'),
  store.indexOf('function mergeRemoteRecordingsIntoStore'),
);
const deleteCourseFn = store.slice(store.indexOf('const deleteCourse = useCallback'), store.indexOf('const restoreCourse = useCallback'));
const restoreCourseFn = store.slice(store.indexOf('const restoreCourse = useCallback'), store.indexOf('const restoreLecture = useCallback'));
const createCourseFn = store.slice(store.indexOf('const createCourse ='), store.indexOf('const createLecture ='));
const mergeStep1 = store.slice(store.indexOf('for (const cr of remoteCourses)'), store.indexOf('// 2. Legacy name-derived courses'));
const mergeStep2 = store.slice(store.indexOf('// 2. Legacy name-derived courses'), store.indexOf('// 3. Local-only courses'));

console.log('1 — classification happens before any write, on id format, not on error');
check('CANONICAL_COURSE_ID_RE (uuid format) is checked first and routes legacy ids away from UPDATE', () => {
  assert.match(store, /const CANONICAL_COURSE_ID_RE = \/\^\[0-9a-f\]\{8\}/);
  assert.match(writeCourseDeletion, /if \(!CANONICAL_COURSE_ID_RE\.test\(courseId\)\) \{\s*void writeLegacyCourseDeletion/);
});
check('the routing decision is unconditional on id format — not inside a .catch/.then error handler', () => {
  const beforeFirstSupabaseCall = writeCourseDeletion.slice(0, writeCourseDeletion.indexOf('void supabase'));
  assert.match(beforeFirstSupabaseCall, /CANONICAL_COURSE_ID_RE\.test/);
});

console.log('2 — canonical (UUID) Course delete is byte-for-byte the pre-existing UPDATE path');
check('canonical branch still only UPDATEs courses, with the original retry-minimal fallback', () => {
  assert.match(writeCourseDeletion, /\.update\(\{ deleted_at: deletedAt, deletion_updated_at: now, updated_at: now \}\)/);
  assert.match(writeCourseDeletion, /\.update\(\{ deleted_at: deletedAt \}\)/); // minimal retry, unchanged
  assert.match(writeCourseDeletion, /\.eq\('id', courseId\)\s*\.eq\('user_id', userId\)/);
});
check('canonical branch never inserts — a UUID course delete cannot create a second row', () => {
  const canonicalOnly = writeCourseDeletion.slice(writeCourseDeletion.indexOf('void supabase'));
  assert.doesNotMatch(canonicalOnly, /\.insert\(/);
});

console.log('3 — legacy Course delete creates exactly one canonical tombstone row');
check('existence is checked FIRST, by the same name-normalization the merge itself uses', () => {
  const beforeInsert = writeLegacyCourseDeletion.slice(0, writeLegacyCourseDeletion.indexOf('if (!deletedAt)'));
  assert.match(beforeInsert, /normalizedCourseName\(courseName\)/);
  assert.match(beforeInsert, /\.select\('id,name,deleted_at'\)\s*\.eq\('user_id', userId\)/);
  assert.match(beforeInsert, /const existing = /);
});
check('an existing row (repeated delete, or a name collision) is UPDATEd, never re-inserted', () => {
  assert.match(writeLegacyCourseDeletion, /if \(existing\) \{[\s\S]*?\.update\(\{ deleted_at: deletedAt, deletion_updated_at: now, updated_at: now \}\)[\s\S]*?return;\s*\}/);
});
check('the insert branch is reachable only after the existing-row branch returns (order proves no duplicate)', () => {
  const existingIdx = writeLegacyCourseDeletion.indexOf('if (existing)');
  const insertIdx = writeLegacyCourseDeletion.indexOf("supabase.from('courses').insert(");
  assert.ok(existingIdx > -1 && insertIdx > -1 && existingIdx < insertIdx);
});
check('restore of a legacy course with no existing row is a local-only no-op, never invents a row', () => {
  assert.match(writeLegacyCourseDeletion, /if \(!deletedAt\) return;/);
});
check('the tombstone insert carries a real UUID id, the same user, the same name, and both deletion-clock fields', () => {
  const insertCall = writeLegacyCourseDeletion.slice(writeLegacyCourseDeletion.indexOf("supabase.from('courses').insert("));
  assert.match(insertCall, /id: makeUuid\(\)/);
  assert.match(insertCall, /user_id: userId/);
  assert.match(insertCall, /\bname,/);
  assert.match(insertCall, /deleted_at: deletedAt/);
  assert.match(insertCall, /deletion_updated_at: now/);
});
check('a lookup or insert failure is logged and skipped — never falls through to a different write', () => {
  assert.match(writeLegacyCourseDeletion, /if \(error\) \{\s*console\.info\('\[store\] legacy course deletion lookup skipped/);
  assert.match(writeLegacyCourseDeletion, /if \(insertError\) \{\s*console\.info\('\[store\] legacy course tombstone insert skipped/);
});

console.log('4 — legacy identity reservation: a merge cannot re-derive a tombstoned Course as active');
check('cloud courses (step 1) are reserved by id AND name regardless of deletion state — not filtered to active-only first', () => {
  assert.doesNotMatch(mergeStep1, /remoteCourses\s*\.filter\(\(c\) => !c\.deleted_at\)/);
  assert.match(mergeStep1, /cloudCourseIds\.add\(cr\.id\)/);
  assert.match(mergeStep1, /addCourse\(/);
});
check('legacy name-derivation (step 2) skips any name already reserved in step 1, unconditionally', () => {
  assert.match(mergeStep2, /if \(coursesByName\.has\(nameKey\)\) continue;/);
});

console.log('5 — call sites pass the Course name through, and canonical Course lifecycle is untouched');
check('deleteCourse resolves the name from local state and passes it to writeCourseDeletion', () => {
  assert.match(deleteCourseFn, /const courseName = coursesRef\.current\.find\(\(c\) => c\.id === id\)\?\.name/);
  assert.match(deleteCourseFn, /writeCourseDeletion\(currentUserId, id, courseName, now, now\)/);
});
check('restoreCourse resolves the name from local state and passes it to writeCourseDeletion', () => {
  assert.match(restoreCourseFn, /const courseName = coursesRef\.current\.find\(\(c\) => c\.id === id\)\?\.name/);
  assert.match(restoreCourseFn, /writeCourseDeletion\(currentUserId, id, courseName, null, now\)/);
});
check('createCourse — the "delete then recreate with the same name" path — is unmodified by this fix', () => {
  assert.match(createCourseFn, /id: makeUuid\(\)/);
  assert.match(createCourseFn, /supabase\.from\('courses'\)\.insert\(full\)/);
});

console.log(`\nlegacy course delete write-path: ${passed} checks passed`);
console.log(
  '\nNOT provable from source alone — needs the owner\'s real two-device pass:\n' +
  '  6. iPad deletes a disposable legacy Course → iPhone refresh/realtime → Course disappears\n' +
  '  7. relaunch both devices → no resurrection\n' +
  '  8. staging acceptance on the real "Gg" / "Test" rows: durable tombstone exists, both gone on both devices, no active duplicate fork\n',
);
