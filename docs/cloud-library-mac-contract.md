# Youmi Lens Cloud Library — Mac Integration Contract (Stage 3)

Status: **acceptance + integration contract.** No production change, no schema
change, no Desktop change is part of this document. It certifies what the
account-level library guarantees today on staging (`keozbnzainrcuiwhmjae`) and
defines the exact model the Mac (Tauri) client builds against.

Audited 2026-08-11 against: iPad `lib/store.tsx`, `lib/deletionSync.mjs`,
`lib/lectureTitle.mjs`, `lib/remoteRecordingColumns.mjs`,
`lib/useProcessingOrchestrator.ts`; backend `server/lectureAudioRoutes.mjs`,
`server/uploadAudio.mjs`; staging migration
`supabase-staging-migration-cloud-library-stage2.sql`; Desktop
`src/lib/courses/*`, `src/lib/recordingsRepo.ts`, `src/lib/cloudLectureTrash.ts`,
`src/lib/audioSource.ts`, `src/AuthProvider.tsx`, `src/types.ts`.

AI generation (transcript/translation/summary) is intentionally unavailable in
staging (no provider keys) and is **not required** for this phase. Those fields
are validated as **fixtures**: a row that already holds them is read identically
by a second client.

---

## 0. Verdict

**CLOUD LIBRARY ACCEPTED — AI GENERATION NOT REQUIRED IN STAGING.**
The **lecture-level** account library is cross-device-correct and RLS-isolated;
a second client converges on the first client's title, transcript/translation/
summary (fixture), notes, marks, deletion/restore and audio. Mac read-only
library + playback can begin now.

**Qualifier — PARTIAL on two alignment items that MUST land before iPad↔Mac
delete/course parity** (neither blocks Mac M1/M2):

1. **`courses` schema divergence.** Staging has the iPad Stage-2 `courses` shape
   (`deletion_updated_at`, no `icon/tint/accent`). Desktop's repository expects
   the phase-1B shape (`icon/tint/accent`, no `deletion_updated_at`). Neither is
   a superset — a Desktop/Mac `courses` SELECT of `icon,tint,accent` **fails on
   staging today**. Unify the table first (§9 A1).
2. **Deletion model divergence.** iPad deletes account-level via
   `recordings.deleted_at`/`deletion_updated_at`. Desktop deletes device-locally
   via a `localStorage` trash registry and a hard `DELETE` for purge. A delete on
   one is invisible to the other. Unify Desktop onto `recordings.deleted_at`
   (§9 A2).

RLS/ownership is **not** blocked. Tests did **not** fail (see §M).

---

## A. Identity

| Concept | Authority | Keyed by | Cross-device |
|---|---|---|---|
| Account | `auth.users.id` (JWT `sub`) | — | ✅ |
| Lecture | `recordings.id` (client UUID at upload) = `remoteRecordingId` | the durable join key | ✅ |
| Audio asset | `recordings.storage_path` = `${userId}/${recordingId}.${ext}` | private `lecture-audio` bucket | ✅ |
| Course (staging DB) | `courses.id` UUID + `recordings.course_id` | stable UUID | ✅ at DB layer |
| Course (iPad client) | **name** (`recordings.course`) | trimmed, case-folded | ⚠️ name-based (C1) |
| Course (Desktop client) | `course_id`, name fallback | stable UUID | ✅ (but schema mismatch, §0.1) |

The Lecture id is the single durable join key; everything hangs off it. Course
identity is where the two clients disagree (§K).

---

## B. Staging schema (authoritative, `keozbnzainrcuiwhmjae`)

`public.recordings` (Stage-2 columns in **bold**):
`id, user_id, course, title, created_at, duration_sec, mime, storage_path,`
`transcript(+_raw/_zh/_ready), translated_transcript, summary_en/zh/source/translated(+summary_ready),`
`live_transcript(+_raw), translated_live_transcript, source_language, translation_language(+_ready),`
`ai_status/ai_error/ai_updated_at,`
**`course_id, deleted_at, deletion_updated_at, notes, marked_timestamps(jsonb '[]'),`**
**`title_updated_at, notes_updated_at, marks_updated_at`**.
Absent on staging: `updated_at`. (Production is the reverse: has `updated_at`,
lacks the Stage-2 set — the client column ladder handles both, see §H.)

`public.courses` (Stage-2 / staging shape):
`id, user_id, name, created_at, updated_at, deleted_at, deletion_updated_at`.
RLS: owner-only select/insert/update/delete (`auth.uid() = user_id`). Partial
unique index on `(user_id, lower(name)) where deleted_at is null`.
**Missing vs Desktop's expectation: `icon, tint, accent`** (§0.1, §9 A1).

Storage: private bucket `lecture-audio`, object `${userId}/${recordingId}.${ext}`.

---

## C. Per-feature Mac contract

Legend — Read/Write methods are what the Mac client SHOULD use; "Conflict" is the
merge rule already proven on iPad and expected of every client.

### Courses
- **Table/endpoint:** `public.courses` (+ `recordings.course_id` join).
- **ID:** `courses.id` (UUID).
- **Fields:** `id, user_id, name, created_at, updated_at, deleted_at, deletion_updated_at`
  — **plus `icon, tint, accent` once §9 A1 lands** (Desktop already assumes them).
- **Read:** `select … from courses where user_id = auth.uid() and deleted_at is null`
  (probe `courses` first; fall back to name-derivation if the table is absent —
  Desktop's `coursesRepositoryFactory` already does this).
- **Write:** insert/update/soft-delete on `courses`; **dual-write** the legacy
  `recordings.course` label (and `course_id`) so name-only clients (iPad today)
  still see renames. Desktop's `supabaseCoursesRepository` is the reference.
- **Conflict:** name uniqueness by `lower(btrim(name))` among active rows;
  deletion by `deletion_updated_at` freshness once A1 adds that column to the
  unified table. Today Desktop resolves course deletion by `deleted_at` presence.
- **Deletion:** soft (`deleted_at`); only an EMPTY course may be deleted; FK is
  `ON DELETE SET NULL` so a purge never deletes a lecture.
- **Offline/cache:** derived-from-names fallback is a permanent, correct mode in
  local-only sessions — never an error state.

### Lectures
- **Table:** `public.recordings`. **ID:** `recordings.id` (UUID) = `remoteRecordingId`.
- **Fields:** all of §B; the join key is `id`, course link is `course_id` (+ `course` name).
- **Read:** `select <ladder> from recordings where user_id = auth.uid()` (column
  ladder, §H). Map `course_id` → course; fall back to `course` name.
- **Write:** created by upload (§Audio). Field writes are per-column patches (below).
- **Conflict:** per field (title/notes/marks/deletion/content each has its own clock).
- **Deletion:** `deleted_at` (see Deletion).
- **Offline/cache:** a locally-cached lecture is merged against the live row on
  every hydrate/refresh; stale in-flight responses can't revert newer local truth.

### Title
- **Column:** `title` + freshness `title_updated_at`.
- **Read:** `title`. **Write:** `{ title, title_updated_at: now, updated_at: now }`.
- **Conflict:** `resolveMergedLectureTitle` — a real title NEVER loses to a
  placeholder ("Untitled Lecture", empty, null) in either direction; two valid
  titles resolve by `title_updated_at` (fallback to row `updated_at`). A stale
  cache can never overwrite a newer rename.
- **Offline:** local rename stamps `title_updated_at`; survives until a newer remote arrives.

### Transcript / Translation / Summary  (fixture-validated; AI not required)
- **Columns:** `transcript(+_zh)`, `translated_transcript`, `summary_en/zh/source/translated`
  (+ `*_ready` flags, `source_language`, `translation_language`).
- **Read:** copy verbatim. **Write:** produced by the AI pipeline (out of scope in
  staging); manual edits stamp `transcriptUpdatedAt`/`summaryUpdatedAt` locally.
- **Conflict:** `keepLocalIfRemoteContentEmpty` + per-field freshness — an empty/
  early remote read NEVER erases content a client already holds; a completed row
  is read identically by every client.
- **Offline:** cached content stands until a non-empty newer remote replaces it.

### Notes
- **Column:** `notes` (text) + `notes_updated_at`.
- **Read:** `notes`. **Write:** `{ notes, notes_updated_at: now }`.
- **Conflict:** newer `notes_updated_at` wins; keep-local-if-remote-empty.
- **Offline:** local edit stamps the clock; reconciles on next merge.
- **Desktop status:** not yet consumed — add in Mac M3.

### Marks
- **Column:** `marked_timestamps` (jsonb array) + `marks_updated_at`.
- **Read:** array as-is. **Write:** `{ marked_timestamps, marks_updated_at: now }`.
- **Conflict:** side with the newer `marks_updated_at` wins; a clock-less legacy
  side keeps what's present rather than clobbering.
- **Desktop status:** not yet consumed — add in Mac M3.

### Audio
- **Asset:** `recordings.storage_path` in bucket `lecture-audio`.
- **Two supported retrieval methods (pick one for Mac):**
  1. **Direct storage signing (Desktop's current method, recommended):**
     `supabase.storage.from('lecture-audio').createSignedUrl(storage_path, ttl)`
     — owner-scoped by Storage RLS, no backend hop. TTL ≤ 3600s on Desktop today.
  2. **Backend endpoint (iPad's method):** `GET /api/lectures/:id/audio` with
     `Authorization: Bearer <token>` → `{ signedUrl, expiresInSec≤900, mime, durationSec, title, aiStatus }`.
     Owner-scoped: non-owned/missing id both **404** (no existence leak); `409`
     when no cloud audio yet; service key never leaves the server.
- **Write (upload):** `POST /upload-audio` → `${userId}/${recordingId}.${ext}`,
  upsert on `recordingId`, title-preservation guard in place.
- **Conflict:** `storage_path` is stable asset identity; last upload upserts.
- **Offline/cache:** the LOCAL file wins for playback. iPad never nulls
  `localAudioUri` while a local record exists and has no cloud-playback state;
  Mac has no local capture of another device's lecture, so Mac plays cloud audio
  and should cache the signed URL only (not the object) — re-sign on expiry.

### Deletion
- **Columns:** `recordings.deleted_at` (+ `deletion_updated_at`); `courses.deleted_at`
  (+ `deletion_updated_at` once §9 A1). NULL = active; timestamp = Recently Deleted.
- **Read:** treat non-null `deleted_at` as hidden from active views.
- **Write:** soft delete `{ deleted_at: now, deletion_updated_at: now }`; restore
  `{ deleted_at: null, deletion_updated_at: now }`. Permanent delete is a hard row
  delete + storage object removal (owner-scoped).
- **Conflict:** `resolveDeletionState` — the side with the newer
  `deletion_updated_at` wins (delete OR restore); a stale ACTIVE snapshot can
  never resurrect a newer tombstone; only an explicit newer restore un-deletes;
  hydration/refresh/login are never a restore.
- **Offline/cache:** a delete/restore stamps the clock locally and reconciles
  everywhere; ambiguity (no clocks) stays deleted, never resurrects.

---

## D. Second-client acceptance — matrix result

Proven by `scripts/cloud-library-cross-device.test.mjs` (the real exported merge
decision functions + fixtures; the orchestration/write payloads and the audio
endpoint pinned against source). Offline by design → production writes are zero.

| # | Scenario | Result | Mechanism |
|---|---|---|---|
| A | A creates Course → B sees it | ⚠️ only once a lecture carries the name | iPad create is local-only (C1) |
| B | A creates Lecture → B sees it | ✅ | remote row keyed by UUID |
| C | A renames Course → B sees new name | ✅ (by name) | `recordings.course` label write |
| D | A renames Lecture → B sees new title | ✅ | `title` + `title_updated_at` |
| E | A edits Notes → B sees Notes | ✅ | `notes` + `notes_updated_at` |
| F | A changes Marks → B sees Marks | ✅ | `marked_timestamps` + `marks_updated_at` |
| G | A deletes Lecture → B sees deleted | ✅ | `deleted_at` + `deletion_updated_at` |
| H | A restores Lecture → B sees restored | ✅ | newer `deletion_updated_at`, `deleted_at=null` |
| I | A deletes Course → B sees deleted | ❌ local-only on iPad | courses table unconsumed by iPad (C1) |
| J | Audio → B retrieves authenticated audio | ✅ | signed URL, owner-scoped, 404 on non-owner |
| K | Fixture transcript/translation/summary → B reads identical | ✅ | verbatim copy, empty never erases |

§5 stale-cache invariants (all ✅): stale ACTIVE can't resurrect a delete; stale
title can't beat a newer `title_updated_at`; a remote placeholder can't replace a
real title; an empty remote can't erase cached content; the merge never nulls
`localAudioUri`.

---

## E. Desktop gap audit (`youmi-lens-desktop`, Tauri + React/Vite; targets prod `lbws…`)

| Concern | Current state | Consumes new Cloud Library? |
|---|---|---|
| **Auth** | Supabase JS, `persistSession`, Tauri deep-link magic link | ✅ same account as iPad — nothing to change |
| **Backend client** | `@supabase/supabase-js` direct (+ bundled Node server for AI) | ✅ direct RLS-scoped queries |
| **Course model** | `src/lib/courses/*` — full `courses`-table repo with capability probe + derived fallback; dual-writes `course_id` + legacy label | ✅ **ahead of iPad**, but schema mismatch (§0.1) |
| **Lecture model** | `recordingsRepo.ts` `select('*')`, maps `course_id`; reads transcript/summary/storage_path | ✅ read; ⚠️ ignores notes/marks/deleted_at |
| **Audio player** | `<audio>` src from `supabase.storage.createSignedUrl(storage_path, 3600)` | ✅ works; different method than iPad (both valid) |
| **Deletion** | `cloudLectureTrash.ts` — **localStorage** trash registry + hard `DELETE` for purge | ❌ ignores `recordings.deleted_at`; device-local; NOT cross-device |
| **Notes / Marks** | not in `types.ts` model | ❌ not consumed |
| **Storage/cache** | Supabase session persisted; audio via signed URL; IndexedDB (`db.ts`) for local blobs | fine; re-sign on expiry |

**What must change for Desktop/Mac to consume the account library:**
1. Adopt `recordings.deleted_at`/`deletion_updated_at` for lecture deletion,
   retire the localStorage trash registry (biggest interop gap).
2. Align the `courses` table schema so both `icon/tint/accent` and
   `deletion_updated_at` exist (§9 A1); until then a Desktop `courses` SELECT
   fails on staging.
3. Read/write `notes` + `marked_timestamps` (+ their freshness clocks).
4. Read `title_updated_at` and apply the placeholder-protection title merge.

---

## F. Mac implementation plan (ordered — do not implement yet)

- **M1 — Course / Lecture read-only library.** Point the Mac build at staging;
  reuse `coursesRepositoryFactory` (probe → real or derived) and `recordingsRepo`
  read path. Render courses (by `course_id`, name fallback) and lectures. **Prereq:
  §9 A1** so `courses` SELECT succeeds on staging. Acceptance: the second-client
  matrix B/C/D/K visible read-only.
- **M2 — Audio playback.** Sign `storage_path` (direct storage method) and play;
  cache only the URL, re-sign on expiry. Acceptance: matrix J.
- **M3 — Notes / Marks edits.** Add `notes`/`marked_timestamps` to the model;
  write with `notes_updated_at`/`marks_updated_at`; merge by freshness. Acceptance:
  matrix E/F round-trip iPad↔Mac.
- **M4 — Delete / Restore.** Replace the localStorage trash with
  `recordings.deleted_at`/`deletion_updated_at`; apply `resolveDeletionState`.
  Bring course delete onto `courses.deleted_at` (+ freshness). Acceptance: matrix
  G/H/I round-trip iPad↔Mac.
- **M5 — Offline cache.** Persist last-known rows; merge-against-live on
  reconnect; never resurrect a newer tombstone; never erase cached content with
  an empty read.

---

## G. Remaining Cloud Library risks

- **A1 `courses` schema divergence (blocking Mac courses on staging).** Unify to
  a single `courses` table carrying BOTH `icon/tint/accent` AND
  `deletion_updated_at`. Additive, staging-first.
- **A2 deletion-model divergence (blocking iPad↔Desktop delete parity).** Desktop
  must move to `recordings.deleted_at`; today deletes don't cross the client
  boundary.
- **C1 course identity on iPad.** iPad still keys courses by name and does not
  consume `course_id`/`courses`; empty-course create and course delete are
  local-only. Adopt `course_id` on iPad (or accept course lifecycle as an
  authoritative-write owned by the courses-table clients, with iPad name-following).
- **Course rename race (valid-vs-valid).** No course-name freshness clock beyond
  row `updated_at`; concurrent renames are last-writer-wins. Low impact.
- **Two audio retrieval methods.** Harmless but pick one for Mac (direct storage
  signing recommended; the backend endpoint remains for clients without direct
  storage access).
