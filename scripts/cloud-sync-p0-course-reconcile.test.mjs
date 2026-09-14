/**
 * P0 — iPad → Cloud sync integrity (real-device incident).
 *
 * Real staging evidence: local Courses (Gg, Test, Test666) never reached cloud
 * `courses`, and their recordings carried course_id = NULL; Test666's audio
 * upload additionally failed. Proven root causes:
 *   A. No reliable path created a cloud `courses` row for a course the user
 *      already had locally (createCourse's insert only fires at create time, and
 *      legacy courses carry non-UUID local ids) → the course stayed local-only.
 *   B. The upload pipeline never sends course_id (uploadRecording.ts), so a row
 *      is inserted with course_id = NULL; it can only be healed once the course
 *      is a cloud course — which A prevented.
 *   C. Environmental: Test666's audio upload to the local dev backend was
 *      unreachable; the app degraded correctly (local kept, retry available).
 *
 * Fix: a best-effort course reconciliation in applyRemoteRecordings inserts a
 * cloud `courses` row (stable UUID) for every active local course missing from
 * the cloud; the existing merge adopts the UUID and courseIdFixups links the
 * recordings. Local-first, idempotent, production-tolerant. No schema change,
 * no upload/server change, Course identity stays courses.id UUID.
 *
 * Source-level guards (store/orchestrator are React modules); the live round-trip
 * is proven by youmi-lens/scripts/cloud-sync-p0-live-staging.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const store = read('../lib/store.tsx');
const orchestrator = read('../lib/useProcessingOrchestrator.ts');
const resume = read('../lib/processingResume.mjs');
const upload = read('../lib/uploadRecording.ts');
const serverUpload = read('../../youmi-lens/server/uploadAudio.mjs');

const createCourse = store.slice(store.indexOf('const createCourse ='), store.indexOf('const createLecture ='));
// Renamed in the canonical course_id follow-up (Phase 6): this block is now
// explicitly scoped as legacy-only compatibility healing, not the go-forward path.
const reconcile = store.slice(store.indexOf('// LEGACY COMPATIBILITY HEAL ONLY'), store.indexOf('// Heal legacy recordings whose course'));

console.log('A/2/3 — cloud Course creation is reliable and UUID-keyed');
check('1. createCourse is local-first: sets local state, cloud insert is fire-and-forget', () => {
  assert.match(createCourse, /setCourses\(\(prev\) => \[\.\.\.prev, course\]\)/);
  assert.match(createCourse, /void supabase\.from\('courses'\)\.insert\(full\)/);
  // local id IS the cloud id (UUID), no re-keying.
  assert.match(createCourse, /id: makeUuid\(\)/);
});
check('2. reconciliation inserts only when no cloud row reserves the local name', () => {
  assert.ok(reconcile.length > 0, 'reconciliation block must exist');
  assert.match(reconcile, /const knownCloudCourseNames = new Set\(/);
  assert.match(reconcile, /\.from\('courses'\)\s*\.insert\(\{ id: cloudId, user_id: currentUserId, name, icon: course\.icon/);
});
check('3. course identity is a stable UUID (reuse local UUID, else mint one)', () => {
  // Release A (#8): the inline uuidRe.test(course.id) check was hoisted into
  // isCanonicalCourse, computed once and reused for both the block-suppression
  // decision and this identity choice — same behavior, named once.
  assert.match(reconcile, /const isCanonicalCourse = uuidRe\.test\(course\.id\);/);
  assert.match(reconcile, /const cloudId = isCanonicalCourse \? course\.id : makeUuid\(\)/);
  // merge keys courses by the cloud courses.id.
  assert.match(store, /cloudCourseIds\.add\(cr\.id\);/);
});
check('reconciliation is scoped: active, non-Unfiled, non-purged, tombstone-reserving, guarded', () => {
  assert.match(reconcile, /if \(course\.deletedAt\) continue;/);
  assert.match(reconcile, /if \(nameKey === UNFILED_COURSE_NAME\.toLowerCase\(\)\) continue;/);
  assert.match(reconcile, /remoteCourses\s*\.map\(/);
  assert.doesNotMatch(reconcile, /remoteCourses\s*\.filter\(\(c\) => !c\.deleted_at\)/);
  // Release A (#8): canonical (UUID-id) courses are now suppressed by exact
  // cloud UUID, never by name — a soft-deleted predecessor sharing the name
  // must never block a new same-name UUID's retry insert (the delete/recreate
  // race this fix exists for). Legacy name-derived courses (no stable cloud
  // id of their own) keep the conservative name-based guard.
  assert.match(reconcile, /if \(isCanonicalCourse\s*\n\s*\? knownCloudCourseIds\.has\(course\.id\)\s*\n\s*: knownCloudCourseNames\.has\(nameKey\)\) continue;/);
  // A legacy recording's historical course_id may retain this display name
  // forever — that must not block a different, newly-created canonical UUID.
  assert.match(reconcile, /if \(!isCanonicalCourse && linkedCourseNames\.has\(nameKey\)\) continue;/);
  // isPurgedCourseName expects a toTombstoneIndex(...) result (index.courseNames
  // is a Set), not the raw tombstones object (courseNames is a plain array).
  // Passing tombstonesRef.current directly threw `courseNames.has is not a
  // function` every time this line was reached — silently swallowed by the
  // caller's try/catch, so the tombstone check was permanently a no-op and the
  // whole reconcile (and therefore every downstream course-list update) never
  // completed. Proven live: real device / simulator session, staging account.
  // Release A (#8): also scoped to legacy courses only — a canonical UUID may
  // legitimately reuse a permanently-deleted display name.
  assert.match(reconcile, /if \(!isCanonicalCourse && isPurgedCourseName\(toTombstoneIndex\(tombstonesRef\.current\), name\)\) continue;/);
  assert.match(reconcile, /if \(syncingCoursesRef\.current\.has\(nameKey\)\) continue;/);
});
check('reconciliation retries on a real write failure, but never retries a genuine duplicate-name collision', () => {
  // Release A: the retry used to drop to a name-only insert unconditionally on
  // ANY error — which obscured a real 23505 (duplicate active name) behind an
  // unrelated icon-not-null failure on the current schema, and retrying could
  // never resolve a genuine name collision anyway. It now keeps the full
  // visual-field payload on the bounded compatibility retry, and skips
  // retrying entirely when the error IS the duplicate-name collision.
  assert.match(reconcile, /if \(res\.error && res\.error\.code !== '23505'\) \{/);
  assert.match(reconcile, /res = await supabase\s*\n\s*\.from\('courses'\)\s*\n\s*\.insert\(\{ id: cloudId, user_id: currentUserId, name, icon: course\.icon, tint: course\.tint, accent: course\.accent \}\);/);
});

console.log('B/4/5/6 — course_id association');
check('4. createLecture carries the courseId into the local lecture', () => {
  assert.match(store, /const createLecture = useCallback\(\(input: NewLectureInput\): Lecture => \{[\s\S]{0,200}courseId: input\.courseId/);
});
check('5. root cause B is FIXED (canonical follow-up): upload now sends course_id, not just the legacy name', () => {
  // Superseded by the canonical course_id follow-up — see
  // cloud-sync-canonical-course-id.test.mjs for the full go-forward contract.
  // This block keeps asserting the fix stays in place.
  assert.match(upload, /formData\.append\('course_id', courseId\)/);
  assert.match(upload, /formData\.append\('course', course\)/); // legacy name label retained for compatibility
});
check('6. cloud recordings.course_id is ALSO healed for legacy rows once the course is a cloud course', () => {
  assert.match(store, /for \(const fix of merged\.courseIdFixups\)/);
  assert.match(store, /\.from\('recordings'\)\s*\.update\(\{ course_id: fix\.course_id \}\)/);
});

console.log('C/7/8/9 — upload resilience + ASR decoupling');
check('7. an upload failure keeps the local lecture (upload_failed is terminal, not destructive)', () => {
  assert.match(resume, /'upload_failed' waits for the manual Retry Upload/);
  assert.match(resume, /Boolean\(lecture\.localAudioUri\)/);
  // the merge never nulls a local audio file.
  assert.match(store, /localAudioUri: local\?\.localAudioUri \?\? null/);
});
check('8. retry preserves the same lecture identity (remoteRecordingId is stable)', () => {
  assert.match(store, /remoteRecordingId: makeUuid\(\)/);       // minted once at createLecture
  assert.match(store, /remoteRecordingId: row\.id/);            // merge keeps it
  assert.match(orchestrator, /if \(uploadingRef\.current\.has\(lectureId\)\) return;/); // no duplicate upload
});
check('9. DashScope unavailable does NOT fail the audio upload (server sets ai_status pending)', () => {
  assert.match(serverUpload, /ai_status: 'pending'/);
  // the upload response path does not await a transcription provider.
  assert.doesNotMatch(serverUpload, /await\s+(transcribe|dashscope|runAsr|startTranscription)/i);
});

console.log('10 — a cloud failure is never reported as success');
check('10. cloud Course failures log "kept local" and never flip a success state', () => {
  assert.match(createCourse, /course cloud insert skipped \(kept local\)/);
  assert.match(reconcile, /course reconcile skipped \(kept local\)/);
});

console.log(`\ncloud sync P0 course reconcile: ${passed} checks passed`);
