/**
 * Cloud Sync — canonical course_id upload contract.
 *
 * Frozen rule: courses.id UUID is canonical; recordings.course_id → courses.id;
 * name is presentation only. The Lecture↔Course link must be correct at the
 * FIRST cloud insert — no name lookup, no second sync. This pins the go-forward
 * path (client sends course_id; backend writes it at insert with ownership
 * validation) and confirms the legacy name-based reconciliation stays isolated.
 *
 * Source + mutation guards; the live round-trip + ownership negative test live in
 * youmi-lens/scripts/cloud-sync-canonical-live-staging.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const store = read('../lib/store.tsx');
const upload = read('../lib/uploadRecording.ts');
const orchestrator = read('../lib/useProcessingOrchestrator.ts');
const recording = read('../app/recording.tsx');
const server = read('../../youmi-lens/server/uploadAudio.mjs');

const createCourse = store.slice(store.indexOf('const createCourse ='), store.indexOf('const createLecture ='));
const reconcile = store.slice(store.indexOf('// LEGACY COMPATIBILITY HEAL ONLY'), store.indexOf('// Heal legacy recordings whose course'));

console.log('Course + Lecture identity (UUID, inherited)');
check('1/2. new Course id is a UUID and the cloud insert uses that same id', () => {
  assert.match(createCourse, /id: makeUuid\(\)/);
  assert.match(createCourse, /supabase\.from\('courses'\)\.insert\(full\)/);
  assert.match(createCourse, /const full = \{ id: course\.id, user_id: currentUserId/);
});
check('3/4. Start Lecture preserves the Course UUID into Lecture.courseId before upload', () => {
  assert.match(recording, /sessionCourseIdRef = useRef\(resumeLecture\?\.courseId \?\? params\.courseId \?\? ''\)/);
  assert.match(store, /const createLecture = useCallback\(\(input: NewLectureInput\): Lecture => \{[\s\S]{0,200}courseId: input\.courseId/);
});

console.log('Upload contract (client sends course_id)');
check('5. upload request appends course_id (UUID-gated)', () => {
  assert.match(upload, /courseId\?: string \| null;/);
  assert.match(upload, /formData\.append\('course_id', courseId\)/);
  assert.match(upload, /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/i);
});
check('6. upload still sends the legacy course name (compatibility, not identity)', () => {
  assert.match(upload, /formData\.append\('course', course\)/);
});
check('10. orchestrator passes lecture.courseId — no name-based linkage for new data', () => {
  assert.match(orchestrator, /courseId: lecture\.courseId/);
});

console.log('Backend insert (course_id written at first insert, owner-validated)');
check('7. backend writes recordings.course_id in the insert payload', () => {
  assert.match(server, /course_id: rawCourseId/);                                   // read from body
  assert.match(server, /\.\.\.\(ownedCourseId \? \{ course_id: ownedCourseId \} : \{\}\)/); // written at insert
});
check('11/12. backend validates course ownership (service-role bypasses RLS) and drops non-owned/invalid', () => {
  assert.match(server, /\.from\('courses'\)\s*\.select\('id'\)\s*\.eq\('id', rawCourseId\)\s*\.eq\('user_id', userId\)/);
  assert.match(server, /course_id not owned by user — dropping/);
  // never substitute a course by name
  assert.doesNotMatch(server, /courses[\s\S]{0,40}\.eq\('name'/);
});
check('backend is production-tolerant: strip course_id + retry if the column is absent', () => {
  assert.match(server, /course_id column absent — retrying without it/);
  assert.match(server, /const \{ course_id: _dropped, \.\.\.withoutCourseId \} = recordingPayload/);
});
check('15. DashScope absence does not fail the upload (ai_status pending; no sync ASR)', () => {
  assert.match(server, /ai_status: 'pending'/);
  assert.doesNotMatch(server, /await\s+(transcribe|dashscope|runAsr)/i);
});

console.log('Legacy reconciliation stays isolated (Phase 6)');
check('16. reconciliation is explicitly legacy-only and cannot fork a linked or tombstoned course', () => {
  assert.match(reconcile, /LEGACY COMPATIBILITY HEAL ONLY/);
  assert.match(reconcile, /const linkedCourseNames = new Set\(/);
  assert.match(reconcile, /if \(linkedCourseNames\.has\(nameKey\)\) continue;/);
  assert.match(reconcile, /const knownCloudCourseNames = new Set\(/);
  assert.match(reconcile, /if \(knownCloudCourseNames\.has\(nameKey\)\) continue;/);
  assert.doesNotMatch(reconcile, /remoteCourses\s*\.filter\(\(c\) => !c\.deleted_at\)/);
});
check('9. rename keeps Course identity (updates courses.name by id, never re-keys)', () => {
  assert.match(store, /\.from\('courses'\)\s*\.update\(\{ name: trimmed, updated_at: now \}\)\s*\.eq\('id', courseId\)/);
});

console.log('MUTATION guards (each safeguard must be present or these fail)');
check('M1. removing course_id from the upload payload would fail (append present)', () => {
  assert.ok(upload.includes("formData.append('course_id', courseId)"), 'client must send course_id');
});
check('M2. removing the backend ownership check would fail (owner select present)', () => {
  assert.ok(/\.eq\('id', rawCourseId\)[\s\S]{0,40}\.eq\('user_id', userId\)/.test(server), 'backend must validate course ownership');
});
check('M3. reverting new Course identity to name-based would fail (UUID id required)', () => {
  assert.ok(createCourse.includes('id: makeUuid()'), 'new Course id must be a UUID, not name-derived');
  assert.doesNotMatch(createCourse, /id: stableIdFromName/);
});

console.log(`\ncloud sync canonical course_id: ${passed} checks passed`);
