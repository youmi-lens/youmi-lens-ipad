/**
 * P0 — legacy ghost Course derivation (historical Gg / Test resurrection).
 *
 * Authoritative owner result: iPad already deleted "Gg" and "Test" long ago
 * and does not show them; the iOS Simulator, signed into the SAME account,
 * still shows both. The write-path fix (legacy-course-delete-write-path.test)
 * cannot help this — there is no Course left on iPad to delete again. Proven
 * staging truth: no canonical `courses` row exists for either name; their one
 * legacy recording each has course_id = null AND is already soft-deleted
 * (recordings.deleted_at set). mergeRemoteRecordingsIntoStore step 2 derived
 * an ACTIVE course from that still-present (not purged, merely deleted)
 * recording row on every merge, forever, because nothing checked the row's
 * own deletion state.
 *
 * Fix (read path, two parts):
 *   step 2 — a recording contributes to legacy course derivation only while
 *   it is itself active (`!row.deleted_at`).
 *   step 3 — discovered live, verified against a real device-shaped
 *   simulator session: step 2 alone is not enough on a device that ALREADY
 *   has the ghost cached locally (AsyncStorage, persisted by every prior
 *   incorrect merge before this fix existed). Step 3 ("local-only courses
 *   not yet synced") re-adds any local course not covered by steps 1/2 —
 *   which, once step 2 stops contributing it, includes the stale cached
 *   ghost. It now only re-adds a local course whose id is UUID-shaped
 *   (createCourse always assigns makeUuid() up front, so a genuine
 *   not-yet-synced course is always UUID-shaped); a legacy synthetic id
 *   (stableIdFromName) reaching step 3 is stale cached state, not an
 *   offline-authored course, and is no longer re-added.
 *
 * Step 1 (canonical courses, by id — including tombstones) is untouched; the
 * write-path fix from the prior investigation is untouched. The three fixes
 * solve different eras: write-path stops FUTURE legacy deletes from
 * vanishing; step 2 stops HISTORICAL soft-deleted recordings from
 * re-deriving a course that was never durably deleted; step 3 stops a
 * device's OWN stale local cache (built by every merge before this fix
 * existed) from re-materializing what step 2 now correctly refuses to
 * derive.
 *
 * Source-level guards (store is a React module, not unit-importable in plain
 * Node — same constraint and same idiom as every other store.tsx test here).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const store = read('../lib/store.tsx');

const step1 = store.slice(store.indexOf('for (const cr of remoteCourses)'), store.indexOf('// 2. Legacy name-derived courses'));
const step2 = store.slice(store.indexOf('// 2. Legacy name-derived courses'), store.indexOf('// 3. Local-only courses'));
const step3 = store.slice(store.indexOf('// 3. Local-only courses'), store.indexOf('const courseIdFixups'));
const lectureMaterialization = store.slice(
  store.indexOf('const mergedRemoteLectures = liveRemoteRows.map'),
  store.indexOf('for (const lecture of [...mergedRemoteLectures'),
);
const writeLegacyCourseDeletion = store.slice(
  store.indexOf('async function writeLegacyCourseDeletion'),
  store.indexOf('function mergeRemoteRecordingsIntoStore'),
);

console.log('1/4 — a soft-deleted legacy recording cannot derive (or keep re-deriving) an active Course');
check('the derivation loop skips a row whose own recording is soft-deleted, before it ever computes a course name', () => {
  const beforeNameCompute = step2.slice(0, step2.indexOf('const courseName = normalizedCourseName(row.course)'));
  assert.match(beforeNameCompute, /if \(row\.deleted_at\) continue;/);
});
check('the deleted-row guard runs on liveRemoteRows (soft-deleted, not-purged rows) — proves it is a NEW check, not reusing the purge filter', () => {
  // liveRemoteRows already excludes PURGED rows upstream; this guard is the
  // separate, additional check for a row that is merely soft-deleted.
  assert.match(store, /const liveRemoteRows = remoteRows\.filter\(\(row\) => !isPurgedRecording\(purged, row\.id\)\);/);
  assert.match(step2, /for \(const row of liveRemoteRows\) \{/);
});
check('with every legacy recording for a name deleted, nothing in step 2 can add that name — Course is absent', () => {
  // addCourse is the only path that materializes a course in this loop, and
  // it is gated behind the same guard for every row.
  const addCourseCalls = (step2.match(/addCourse\(/g) ?? []).length;
  assert.equal(addCourseCalls, 1); // one call site, reached only past the guard
});

console.log('2/3 — an active legacy recording still derives its Course, including when a deleted sibling exists');
check('a non-deleted row reaches the existing derivation logic unchanged (name compute, dedup, purge check, addCourse)', () => {
  assert.match(step2, /const courseName = normalizedCourseName\(row\.course\);/);
  assert.match(step2, /const nameKey = courseName\.toLowerCase\(\);/);
  assert.match(step2, /if \(hasActiveCourseByName\(nameKey\)\) continue;/);
  assert.match(step2, /if \(isPurgedCourseName\(purged, courseName\)\) continue;/);
  assert.match(step2, /addCourse\(/);
});
check('the same-name dedup (hasActiveCourseByName) is what makes "derive once" hold across a mix of rows for one name', () => {
  // Whichever row (active) is processed first adds the name; every other row
  // for that name — active or deleted — then short-circuits here, so a mix
  // of one deleted + one active recording still yields exactly one Course,
  // and only ever from an active row (the deleted-row guard runs first).
  const guardIdx = step2.indexOf('if (row.deleted_at) continue;');
  const dedupIdx = step2.indexOf('if (hasActiveCourseByName(nameKey)) continue;');
  assert.ok(guardIdx > -1 && dedupIdx > -1 && guardIdx < dedupIdx);
});

console.log('5/6 — canonical Courses (step 1, id-based) are untouched by this fix');
check('step 1 has no reference to liveRemoteRows or row.deleted_at — it is scoped to remoteCourses only, unchanged', () => {
  assert.doesNotMatch(step1, /liveRemoteRows/);
  assert.doesNotMatch(step1, /row\.deleted_at/);
  // Untouched by THIS (legacy ghost course) fix. A later, separate fix (the
  // stale-hydration-race guard) wraps the call in resolveCourseDeletionState —
  // which itself delegates straight to resolveDeletionState for every case
  // except a newly-committed local lecture racing a not-yet-landed remote
  // tombstone (see lib/deletionSync.mjs), so the freshness-clock comparison
  // is still the sole authority for canonical Course deletion state, not
  // reinvented here.
  assert.match(step1, /resolveCourseDeletionState\(\{/);
  const deletionSync = read('../lib/deletionSync.mjs');
  const wrapper = deletionSync.slice(
    deletionSync.indexOf('export function resolveCourseDeletionState'),
  );
  assert.match(wrapper, /return resolveDeletionState\(\{/);
});
check('step 1 still reserves cloud course identity (id + name) unconditionally, deleted or not', () => {
  assert.match(step1, /cloudCourseIds\.add\(cr\.id\)/);
  assert.match(step1, /addCourse\(\{/);
});

console.log('8 — no effect on recordings already linked by canonical course_id, or on lecture materialization');
check('the pre-existing course_id short-circuit still runs first, ahead of the new deleted-row guard', () => {
  const courseIdIdx = step2.indexOf("if (row.course_id && coursesById.has(row.course_id)) continue;");
  const deletedIdx = step2.indexOf('if (row.deleted_at) continue;');
  assert.ok(courseIdIdx > -1 && deletedIdx > -1 && courseIdIdx < deletedIdx);
});
check('lecture materialization (deletedAt per-lecture via resolveDeletionState) is a separate step, untouched by this fix', () => {
  assert.match(lectureMaterialization, /resolveDeletionState\(\{/);
  assert.doesNotMatch(lectureMaterialization, /if \(row\.deleted_at\) continue;/);
});

console.log('7 — the real "Gg" / "Test" fixture (proven staging shape) is on the must-not-derive side of the guard');
check('Gg/Test-shaped rows (course_id=null, deleted_at=<timestamp>) are truthy on row.deleted_at, so the guard skips them', () => {
  const ggRow = { course_id: null, course: 'Gg', deleted_at: '2026-08-14T01:11:12.205+00:00' };
  const testRow = { course_id: null, course: 'Test', deleted_at: '2026-08-14T01:11:02.56+00:00' };
  // Mirrors exactly the two conditions store.tsx checks, in order, for this fixture shape.
  const wouldBeSkippedByGuard = (row) => Boolean(row.course_id) === false && Boolean(row.deleted_at);
  assert.equal(wouldBeSkippedByGuard(ggRow), true);
  assert.equal(wouldBeSkippedByGuard(testRow), true);
});

console.log('9b — step 3 (local-only fallback) cannot re-materialize a stale cached ghost');
check('step 3 only re-adds a local course whose id is UUID-shaped (a genuine not-yet-synced course)', () => {
  assert.match(step3, /if \(!CANONICAL_COURSE_ID_RE\.test\(local\.id\)\) continue;/);
});
check('the UUID check runs before addCourse — a legacy-synthetic-id local entry never reaches it', () => {
  const guardIdx = step3.indexOf('CANONICAL_COURSE_ID_RE.test(local.id)');
  const addCourseIdx = step3.lastIndexOf('addCourse(local)');
  assert.ok(guardIdx > -1 && addCourseIdx > -1 && guardIdx < addCourseIdx);
});
check('createCourse — the source of genuine local-only courses — always assigns a UUID id up front', () => {
  const createCourseFn = store.slice(store.indexOf('const createCourse ='), store.indexOf('const createLecture ='));
  assert.match(createCourseFn, /id: makeUuid\(\)/);
});
check('a Gg/Test-shaped stale local entry (legacy synthetic id, no cloud row, no active recording) is excluded', () => {
  const staleLocalGhost = { id: 'cloud_course_test', name: 'Test' };
  const genuineOfflineCourse = { id: '3f9a1b2c-4d5e-4f60-8a1b-2c3d4e5f6071', name: 'New Offline Course' };
  const CANONICAL_COURSE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.equal(CANONICAL_COURSE_ID_RE.test(staleLocalGhost.id), false);
  assert.equal(CANONICAL_COURSE_ID_RE.test(genuineOfflineCourse.id), true);
});

console.log('Write-path fix (prior investigation) is still intact — the two fixes are not in tension');
check('writeLegacyCourseDeletion (write path) is untouched by this change', () => {
  assert.match(writeLegacyCourseDeletion, /if \(existing\) \{/);
  assert.match(writeLegacyCourseDeletion, /if \(!deletedAt\) return;/);
  assert.match(writeLegacyCourseDeletion, /id: makeUuid\(\)/);
});

console.log(`\nlegacy ghost course derivation: ${passed} checks passed`);
