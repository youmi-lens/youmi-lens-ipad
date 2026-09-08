/**
 * Cloud Library Stage 3 — second-client cross-device acceptance.
 *
 * Proves that a SECOND client, sharing one staging account, converges on the
 * exact state a first client wrote — for every field the account-level library
 * owns. AI generation is intentionally unavailable in staging, so transcript /
 * translation / summary are exercised as FIXTURES (a row that already contains
 * them), never generated.
 *
 * How this is proven WITHOUT hitting the network (and therefore with production
 * writes provably ZERO): the second-client "ingest" is the real, exported merge
 * DECISION layer that lib/store.tsx's `mergeRemoteRecordingsIntoStore` composes
 * field-by-field — `resolveMergedLectureTitle`, `resolveDeletionState`,
 * `keepLocalIfRemoteContentEmpty`. We feed each the fixture a first client would
 * have written (client A) plus a stale/empty second-client cache (client B) and
 * assert B's resolved value. The scenarios that live in React/server orchestration
 * (the write payloads, the notes/marks freshness, the audio endpoint, the
 * local-audio invariant, and the two KNOWN course-lifecycle gaps) are pinned by
 * source assertions against the real modules so they cannot silently regress.
 *
 * Matrix (task section 4): A create course · B create lecture · C rename course ·
 * D rename lecture · E notes · F marks · G delete · H restore · I delete course ·
 * J audio · K fixture transcript/translation/summary. Section 5 stale-cache is
 * folded in where the same decision function governs it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveMergedLectureTitle } from '../lib/lectureTitle.mjs';
import { resolveDeletionState, applyDeletionDecision, isDeleted } from '../lib/deletionSync.mjs';
import { keepLocalIfRemoteContentEmpty } from '../lib/remoteRecordingColumns.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const store = read('../lib/store.tsx');
const audioRoute = read('../../youmi-lens/server/lectureAudioRoutes.mjs');

const T1 = '2026-08-11T09:00:00.000Z'; // older
const T2 = '2026-08-11T10:00:00.000Z'; // newer

// ── B. Lecture create → Client B sees it ────────────────────────────────────
// A records + uploads: the shared row is keyed by the client-supplied UUID
// (recordings.id = remoteRecordingId). B, with no local copy, adopts it whole.
console.log('B — Client A creates a Lecture → Client B sees it');
check('a remote-only row (no local counterpart) is ingested as a full lecture', () => {
  // B has no local for this id → title/content/audio come straight from the row.
  const title = resolveMergedLectureTitle({ localTitle: undefined, remoteTitle: 'Week 3 — Neural Nets', remoteTitleUpdatedAt: T1 });
  assert.equal(title.title, 'Week 3 — Neural Nets');
  assert.equal(title.source, 'remote');
  // storage_path present → B classifies it uploaded, for the ordinary case
  // where B has no pending local media revision of its own (mergedUploadStatus's
  // remote-authoritative branch — see media-revision-freshness.test.mjs for
  // the revision-aware gate added around this).
  assert.match(store, /: \(row\.storage_path \? 'uploaded' : local\?\.uploadStatus \?\? 'not_uploaded'\);/);
});

// ── D. Lecture rename → Client B sees new title (+ §5 stale title) ──────────
console.log('D — Client A renames a Lecture → Client B sees the new title');
check('A rename (newer title_updated_at) beats B stale title', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Old Title', localTitleUpdatedAt: T1,
    remoteTitle: 'New Title', remoteTitleUpdatedAt: T2,
  });
  assert.equal(r.title, 'New Title');
  assert.equal(r.source, 'remote');
});
check('§5 a STALE local title (older stamp) can never overwrite a newer remote rename', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Stale Local', localTitleUpdatedAt: T1,
    remoteTitle: 'Authoritative', remoteTitleUpdatedAt: T2,
  });
  assert.equal(r.title, 'Authoritative');
});
check('§5 a remote PLACEHOLDER can never replace a real local title, whatever the clock', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Real Lecture Name', localTitleUpdatedAt: T1,
    remoteTitle: 'Untitled Lecture', remoteTitleUpdatedAt: T2, // newer but a placeholder
  });
  assert.equal(r.title, 'Real Lecture Name');
  assert.equal(r.source, 'local');
});

// ── G. Delete → Client B sees deleted (+ §5 no resurrection) ────────────────
console.log('G — Client A deletes a Lecture → Client B sees the deleted state');
check('A delete (has clock) beats B stale ACTIVE (no clock) — B goes deleted', () => {
  const del = applyDeletionDecision(true, T2); // { deleted_at: T2, deletion_updated_at: T2 }
  const r = resolveDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: undefined,          // B stale active
    remoteDeletedAt: del.deletedAt, remoteDeletionUpdatedAt: del.deletionUpdatedAt,
  });
  assert.equal(isDeleted(r.deletedAt), true);
  assert.equal(r.source, 'remote');
});
check('§5 a stale ACTIVE snapshot can NEVER resurrect a newer tombstone', () => {
  const r = resolveDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: T1,                 // B: active, older clock
    remoteDeletedAt: T2, remoteDeletionUpdatedAt: T2,                 // A: deleted, newer
  });
  assert.equal(isDeleted(r.deletedAt), true, 'newer delete wins over stale active');
});

// ── H. Restore → Client B sees restored (only an explicit newer restore) ────
console.log('H — Client A restores a Lecture → Client B sees the restored state');
check('A restore (newer clock, deleted_at null) beats B stale DELETED', () => {
  const restore = applyDeletionDecision(false, T2); // { deleted_at: null, deletion_updated_at: T2 }
  const r = resolveDeletionState({
    localDeletedAt: T1, localDeletionUpdatedAt: T1,                   // B: still deleted (stale)
    remoteDeletedAt: restore.deletedAt, remoteDeletionUpdatedAt: restore.deletionUpdatedAt,
  });
  assert.equal(r.deletedAt, null, 'explicit newer restore un-deletes');
  assert.equal(r.source, 'remote');
});
check('§5 hydration/refresh is NOT a restore — an older active clock cannot undo a newer delete', () => {
  // Same as the no-resurrection case, framed as B re-hydrating: newer delete stands.
  const r = resolveDeletionState({
    localDeletedAt: null, localDeletionUpdatedAt: undefined,
    remoteDeletedAt: T2, remoteDeletionUpdatedAt: T2,
  });
  assert.equal(isDeleted(r.deletedAt), true);
});

// ── K. Fixture transcript / translation / summary → B reads identical ───────
// No DashScope/OpenAI: the row already holds these (synthetic fixture). B copies
// them verbatim, and a transient EMPTY remote never erases content B already has.
console.log('K — Fixture transcript/translation/summary → Client B reads identical content');
check('B copies fixture transcript / translation / summary verbatim', () => {
  const fixture = {
    transcript: 'FIXTURE transcript body',
    translated_transcript: '固定译文',
    summary_en: 'FIXTURE English summary',
    summary_zh: '固定中文摘要',
  };
  assert.equal(keepLocalIfRemoteContentEmpty(fixture.transcript, undefined), 'FIXTURE transcript body');
  assert.equal(keepLocalIfRemoteContentEmpty(fixture.translated_transcript, undefined), '固定译文');
  assert.equal(keepLocalIfRemoteContentEmpty(fixture.summary_en, undefined), 'FIXTURE English summary');
  assert.equal(keepLocalIfRemoteContentEmpty(fixture.summary_zh, undefined), '固定中文摘要');
});
check('§5 an empty/early remote read never erases content B already cached', () => {
  assert.equal(keepLocalIfRemoteContentEmpty('', 'B already has this'), 'B already has this');
  assert.equal(keepLocalIfRemoteContentEmpty(null, 'kept'), 'kept');
  assert.equal(keepLocalIfRemoteContentEmpty(undefined, 'kept'), 'kept');
});

// ── Orchestration + write wiring (real store.tsx / server) ──────────────────
// The decisions above are only cross-device if the first client actually WRITES
// the governing columns and the merge READS them. Pin both against source.
console.log('Write/read wiring — the first client persists what the second client reads');

check('D write: lecture rename pushes title + title_updated_at (+updated_at compat)', () => {
  assert.match(store, /pushRecordingPatch\(\s*\{ title: trimmed, title_updated_at: now, updated_at: now \}/);
});
check('G write: delete sends deleted_at + deletion_updated_at atomically, with no compatibility field stripping', () => {
  const deletionWriter = store.slice(store.indexOf('const syncLectureDeletion ='), store.indexOf('const updateLecture ='));
  assert.match(deletionWriter, /\.update\(\{ deleted_at: deletedAt, deletion_updated_at: deletionUpdatedAt \}\)/);
  assert.doesNotMatch(deletionWriter, /pushRecordingPatch|delete next\[key\]|retrying without/);
});
check('H write: restore preserves the existing explicit deletion freshness write', () => {
  assert.match(store, /pushRecordingPatch\(\{ deleted_at: null, deletion_updated_at: now \}/);
});
check('E/F write: notes & marks push notes/marked_timestamps + their freshness clocks', () => {
  assert.match(store, /cloud\.notes = patch\.notes[\s\S]{0,60}cloud\.notes_updated_at = now/);
  assert.match(store, /cloud\.marked_timestamps = patch\.markedTimestamps[\s\S]{0,60}cloud\.marks_updated_at = now/);
});
check('E/F read: merge resolves notes & marks by their freshness clocks', () => {
  assert.match(store, /notes_updated_at/);
  assert.match(store, /const preferRemoteMarks =[\s\S]{0,160}marks_updated_at/);
  assert.match(store, /resolveDeletionState\(\{/);           // deletion merge is wired
  assert.match(store, /resolveMergedLectureTitle\(\{/);      // title merge is wired
});
check('§5 the merge NEVER nulls localAudioUri while a local record exists', () => {
  assert.match(store, /localAudioUri: local\?\.localAudioUri \?\? null/);
});

// ── C. Course rename → Client B sees new name (Stage 4: authoritative by id) ──
console.log('C — Client A renames a Course → Client B sees the new name (same id)');
check('course rename updates authoritative courses.name by stable id (+ legacy label)', () => {
  // Stage 4: the id-keyed courses.name write is what makes an empty-course rename
  // persist and keeps the id fixed; the recordings.course label is the compat dual-write.
  assert.match(store, /\.from\('courses'\)\s*\.update\(\{ name: trimmed, updated_at: now \}\)\s*\.eq\('id', courseId\)/);
  assert.match(store, /\.from\('recordings'\)\s*\.update\(\{ course: trimmed, updated_at: now \}\)/);
});

// ── Course identity: merge keys by course_id first (Stage 4) ─────────────────
console.log('Course identity — merge associates lectures by stable course_id first');
check('merge resolves a lecture course by course_id before name, and heals missing course_id', () => {
  assert.match(store, /const courseById = row\.course_id \? coursesById\.get\(row\.course_id\) : undefined;/);
  assert.match(store, /const course = courseById \?\? coursesByName\.get\(courseName\.toLowerCase\(\)\);/);
  assert.match(store, /courseIdFixups\.push\(\{ id: row\.id, course_id: course\.id \}\)/);
});

// ── J. Audio → Client B retrieves authenticated audio ───────────────────────
console.log('J — Audio uploaded by A → Client B retrieves authenticated audio');
check('audio endpoint is owner-scoped: verifies JWT, 404s a non-owned/missing id, signs short-TTL', () => {
  assert.match(audioRoute, /const user = await verifyJwt\(token\)/);
  assert.match(audioRoute, /status\(401\)/);
  assert.match(audioRoute, /status\(404\)/);          // non-owned / missing → 404, no existence leak
  assert.match(audioRoute, /createSignedUrl/);        // service key never leaves the server
});

// ── A / I. Course lifecycle is now ACCOUNT-LEVEL (Stage 4 — gaps closed) ─────
console.log('A / I — course create/delete/restore are account-level (Stage 4)');
check('A: createCourse inserts an authoritative courses row keyed by a stable UUID (empty course syncs)', () => {
  const fn = store.slice(store.indexOf('const createCourse ='), store.indexOf('const createLecture ='));
  assert.match(fn, /id: makeUuid\(\)/);                              // id === courses.id
  assert.match(fn, /supabase\.from\('courses'\)\.insert\(full\)/);   // cloud insert (icon/tint/accent)
  assert.match(fn, /insert\(\{ id: course\.id, user_id: currentUserId, name: course\.name \}\)/); // prod fallback
});
check('I: deleteCourse/restoreCourse write account-level courses deletion with a freshness clock', () => {
  const del = store.slice(store.indexOf('const deleteCourse ='), store.indexOf('const restoreCourse ='));
  const res = store.slice(store.indexOf('const restoreCourse ='), store.indexOf('const restoreLecture ='));
  assert.match(del, /writeCourseDeletion\(currentUserId, id, courseName, now, now\)/);
  assert.match(res, /writeCourseDeletion\(currentUserId, id, courseName, null, now\)/);
});
check('writeCourseDeletion targets courses.deleted_at + deletion_updated_at, with a prod-minimal retry', () => {
  const at = store.indexOf('function writeCourseDeletion');
  const fn = store.slice(at, at + 1000);
  assert.match(fn, /\.from\('courses'\)/);
  assert.match(fn, /deleted_at: deletedAt, deletion_updated_at: now, updated_at: now/);
  assert.match(fn, /\.update\(\{ deleted_at: deletedAt \}\)/);       // minimal retry where freshness col absent
});
check('applyRemoteRecordings heals missing course_id pointers server-side (fire-and-forget)', () => {
  assert.match(store, /for \(const fix of merged\.courseIdFixups\)/);
  assert.match(store, /\.update\(\{ course_id: fix\.course_id \}\)/);
});

console.log(`\ncloud-library cross-device acceptance: ${passed} checks passed`);
