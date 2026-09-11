/**
 * P0 — course ownership must never be resolved by name when it can be
 * resolved by id, and a name-based fallback must never guess.
 *
 * Real incident: a course named "Hhh" was soft-deleted, then a brand-new
 * active course was created with the exact same name. mergeRemoteRecordingsIntoStore's
 * old `coursesByName` map was a plain first-write-wins Map<string, Course>,
 * populated from `remoteCourses` (fetched oldest-created-first) regardless of
 * deletion state. The OLDER (deleted) course therefore always claimed the
 * name slot forever, and any recording whose own `course_id` didn't resolve
 * by id fell back to that map — silently re-filing a brand-new recording
 * under a dead course. Because `activeLectures` hides any lecture whose
 * `courseId` maps to a deleted course, the recording appeared to vanish from
 * the UI, even though its audio/transcript/summary were fully intact.
 *
 * Fix (read path): name-based fallback is now `resolveActiveCourseByName`,
 * built from `activeCoursesByName` — a course only ever enters it while
 * active (see `addCourse`'s `if (course.deletedAt) return;` guard), and it
 * only ever returns a course when exactly one active course shares that
 * name. An explicit `row.course_id` is still tried first and is never
 * second-guessed by a name lookup. When neither resolves (missing id AND an
 * ambiguous or absent name match), the lecture keeps its existing local
 * `courseId` rather than being silently reassigned or dropped to Unfiled.
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

const nameResolution = store.slice(
  store.indexOf('const coursesById = new Map<string, Course>();'),
  store.indexOf('// 1. Authoritative cloud courses'),
);
const lectureMaterialization = store.slice(
  store.indexOf('const mergedRemoteLectures = liveRemoteRows.map'),
  store.indexOf('for (const lecture of [...mergedRemoteLectures'),
);

console.log('A/C — a soft-deleted course never claims (or keeps) a name-fallback slot');
check('addCourse always reserves the course by id first, unconditionally', () => {
  assert.match(nameResolution, /const addCourse = \(course: Course\) => \{\s*coursesById\.set\(course\.id, course\);/);
});
check('addCourse returns BEFORE touching the name map when the course is deleted — a deleted course cannot claim or shadow a name slot', () => {
  const addCourseBody = nameResolution.slice(
    nameResolution.indexOf('const addCourse = (course: Course) => {'),
    nameResolution.indexOf('/** True only when exactly one ACTIVE course'),
  );
  const guardIdx = addCourseBody.indexOf('if (course.deletedAt) return;');
  const nameMapWriteIdx = addCourseBody.indexOf('activeCoursesByName.set(');
  assert.ok(guardIdx > -1 && nameMapWriteIdx > -1 && guardIdx < nameMapWriteIdx);
});

console.log('D/E — name fallback resolves only when exactly one active course matches; two active matches is ambiguous, never guessed');
check('resolveActiveCourseByName returns a course only when the active-candidate list has length exactly 1', () => {
  assert.match(
    nameResolution,
    /const resolveActiveCourseByName = \(name: string\): Course \| undefined => \{\s*const candidates = activeCoursesByName\.get\(name\.trim\(\)\.toLowerCase\(\)\);\s*return candidates\?\.length === 1 \? candidates\[0\] : undefined;\s*\};/,
  );
});
check('two (or zero) active candidates for the same name both fall through to undefined — never candidates[0] unconditionally, never an array index guess', () => {
  // The ternary's only "resolved" branch is the length===1 case; every other
  // count (0, 2, 3, ...) takes the `: undefined` branch. A regression that
  // changed this to e.g. `candidates[candidates.length - 1]` (newest-wins) or
  // `candidates[0]` unconditionally would fail this exact string match.
  assert.match(nameResolution, /candidates\?\.length === 1 \? candidates\[0\] : undefined/);
  assert.doesNotMatch(nameResolution, /candidates\[candidates\.length - 1\]/);
});
check('addCourse accumulates every active same-named course into one list (not overwriting), which is what makes ambiguity detectable at all', () => {
  assert.match(
    nameResolution,
    /activeCoursesByName\.set\(key, \[\.\.\.\(activeCoursesByName\.get\(key\) \?\? \[\]\), course\]\);/,
  );
});

console.log('B — an explicit, resolvable course_id is authoritative and is never overridden by a name lookup');
check('the per-recording course resolution tries course_id first; the name lookup is only ever consulted via ??, so it never runs once courseById is truthy', () => {
  assert.match(lectureMaterialization, /const courseById = row\.course_id \? coursesById\.get\(row\.course_id\) : undefined;/);
  assert.match(lectureMaterialization, /const course = courseById \?\? resolveActiveCourseByName\(courseName\);/);
});

console.log('F — legacy/unresolvable course_id + one deleted + one active same-named course resolves to the sole active one');
check('hasActiveCourseByName (used by steps 2 and 3 to avoid deriving a duplicate) is active-scoped, not "any course by this name ever, deleted or not"', () => {
  assert.match(
    nameResolution,
    /const hasActiveCourseByName = \(name: string\): boolean =>\s*\(activeCoursesByName\.get\(name\.trim\(\)\.toLowerCase\(\)\)\?\.length \?\? 0\) > 0;/,
  );
});
check('step 2 (legacy derivation) and step 3 (local-only courses) both gate on hasActiveCourseByName, not raw map membership', () => {
  const step2 = store.slice(store.indexOf('// 2. Legacy name-derived courses'), store.indexOf('// 3. Local-only courses'));
  const step3 = store.slice(store.indexOf('// 3. Local-only courses'), store.indexOf('const courseIdFixups'));
  assert.match(step2, /if \(hasActiveCourseByName\(nameKey\)\) continue;/);
  assert.match(step3, /if \(hasActiveCourseByName\(local\.name\.trim\(\)\.toLowerCase\(\)\)\) continue;/);
});

console.log('4 — when nothing resolves (no id match, ambiguous or absent name match), preserve the existing local relationship rather than guessing or dropping to Unfiled');
check('the final courseId assignment falls back to the existing local lecture courseId before ever reaching Unfiled', () => {
  assert.match(
    lectureMaterialization,
    /courseId: course\?\.id \?\? local\?\.courseId \?\? stableIdFromName\('cloud_course', UNFILED_COURSE_NAME\),/,
  );
});

console.log(`\ncourse-name-collision-ownership: ${passed} checks passed`);
