# Youmi Lens Cloud Library Contract (v0 — foundation)

Status: **design contract only.** No Mac/Windows code, no schema migration, and
no backend deploy are part of this document. It records what is true today on
iPad + backend and what the future account-level library must guarantee, so the
later Mac/Windows clients build against one agreed model instead of guessing.

Audited against: iPad `lib/store.tsx`, `lib/models.ts`, `lib/lectureTitle.mjs`,
`lib/deletionTombstones.mjs`, `lib/lectureLocalAudio.mjs`; backend
`server/uploadAudio.mjs`, `server/processRecording.mjs`, `server/accountRoutes.mjs`.

---

## A. Identity

| Concept | Authority | How it is keyed | Cross-device stable? |
|---|---|---|---|
| Account | Supabase `auth.users.id` | JWT `sub` | Yes |
| Course | **Name** (`recordings.course`) | trimmed, case-folded | Fragile — see risk C1 |
| Lecture | `recordings.id` (client-supplied UUID at upload) | `remoteRecordingId` on device | Yes |
| Audio asset | `recordings.storage_path` = `${userId}/${recordingId}.${ext}` | private `lecture-audio` bucket | Yes |

The Lecture id is the single durable join key. Everything account-level hangs
off it. Course identity is currently **derived from a string name**, which is
the weakest link (C1 below).

## B. Field authority matrix

Source of truth for each Lecture field as it stands today. "Merge rule" is what
`mergeRemoteRecordingsIntoStore` does now.

| Field | Local source | Remote column | Merge rule today | Cross-device ready? | Risk |
|---|---|---|---|---|---|
| title | rename | `title` | valid beats fallback; else title-freshness | **Yes** | valid-vs-valid unresolved (G) |
| transcript | edit | `transcript` | `transcriptUpdatedAt` freshness, keep-local-if-remote-empty | Yes | last-writer on ties |
| translated transcript | edit | `translated_transcript` | same as transcript | Yes | — |
| summary (en/zh/source/translated) | edit | `summary_*` | `summaryUpdatedAt` freshness | Yes | — |
| live transcript | recorder | `live_transcript` | keep-local-if-remote-empty | Yes | — |
| marks | mark button | *(none)* | `local?.markedTimestamps ?? []` | **No — local only** | R1 |
| notes (text) | notes editor | *(none)* | `local?.notes ?? ''` | **No — local only** | R1 |
| note strokes / images | notebook | *(none)* | `local?.noteStrokes ?? []` | **No — local only** | R1 |
| course assignment | create/move | `course` (name) | re-derived from name | Partial | C1 |
| createdAt | record time | `created_at` | remote wins | Yes | — |
| duration | recorder | `duration_sec` | remote-or-local | Yes | — |
| **localAudioUri** | recorder / Finish | *(none — device-local)* | `local?.localAudioUri ?? null` | **No — device local by design** | must never be nulled when local exists |
| **storagePath** | *(none)* | `storage_path` | `row.storage_path ?? local?.storagePath` | Yes | audio asset identity |
| uploadStatus | upload pipeline | derived from `storage_path` | `row.storage_path ? 'uploaded' : local` | Device-local | — |
| deletion (soft) | delete | *(none — `deletedAt` on record)* | `local?.deletedAt` copied forward | **No — local only** | D1 |
| deletion (permanent) | purge | *(none)* | purge tombstone drops remote row | **No — local only** | D1 |

**Legend:** *Cloud-shared* = has a remote column and merges across devices.
*Device-local* = intentionally never leaves the device (`localAudioUri`,
recorder recovery, render caches). *Local-only (gap)* = should be shared for the
account model but has no remote column yet (marks, notes, deletion).

## C. Device-local invariants (must survive every remote reconciliation)

1. **`localAudioUri` is never nulled while a local record matches.** The merge
   copies it forward (`local?.localAudioUri ?? null`); null only occurs for a
   row with no local counterpart (a lecture recorded on another device — correct).
2. **A remote copy never suppresses a local file.** Playback classification
   (`lib/lectureLocalAudio.mjs`) ignores `storagePath` entirely. States are
   `local` / `local-missing` / `unavailable` — there is no cloud-playback state
   on iPad. (The unapproved "cloud coming soon" placeholder was removed.)
3. **Recording never depends on the network.** Finish writes a durable file
   under `Documents/YoumiLens/Recordings` and sets `localAudioUri` before any
   upload. `uploadStatus` (`not_uploaded → uploading → uploaded → upload_failed`)
   already distinguishes local usability from cloud state, so an upload failure
   loses nothing local.
4. **Stale in-flight responses cannot revert local truth.** `applyRemoteRecordings`
   merges against the live refs *after* the network resolves, not a pre-fetch
   snapshot, so a delete/rename/record performed during a request wins.

## D. Deletion — current reality vs future target

**Today (iPad, local-only):**
- Soft delete sets `deletedAt` on the record; it rides through every merge and
  shows in Recently Deleted. Restore clears it. Survives reload / refresh /
  cold hydration (tested).
- Permanent delete removes the record and writes a **purge tombstone**
  (`lib/deletionTombstones.mjs`, persisted per scope) of the remote recording id
  and course name, because `recordings` has **no `deleted_at` column** — the
  remote row stays active forever and would otherwise be re-materialized.

**D1 — Known limitation (documented, not a bug):** deletion is **not
cross-device**. Deleting on iPad does not remove the Supabase row, so another
device signing in still sees it. Purge tombstones are per-device and lost on
reinstall.

**Future target (requires backend, out of scope here):** add
`recordings.deleted_at timestamptz` (and `courses` if a courses table is
introduced). Delete becomes an authoritative account-level write; Recently
Deleted and Restore become account-level; iPad purge tombstones become a
transitional fallback that can be retired once every client honours `deleted_at`.

## E. Audio cloud foundation (audited, working today)

- Upload: `POST /upload-audio` → private `lecture-audio` bucket at
  `${userId}/${recordingId}.${ext}`, upserted on `recordingId`. Ownership is
  bound to `user_id`; the title-preservation guard is in place.
- Signed URLs already exist server-side (`processRecording.mjs`,
  `liveRealtimeWs.mjs`, 180s TTL) but only for the processing pipeline.
- **Gap for Mac/Windows playback:** there is **no client-facing endpoint** that
  resolves `lectureId → signed download URL`. That single endpoint (auth-scoped,
  short-TTL signed GET on the owning user's object) is the minimum backend work
  to enable cross-device listening. iPad must still prefer the local file and
  fall back to cloud only when `localAudioUri` is absent.

## F. Subscription entitlement

Entitlement is keyed to the authenticated user, not the purchase platform
(`server/iapEntitlements.mjs`, `betaGate.mjs`). The same account carries the
same entitlement on any client. **Do not couple content ownership to where the
subscription was bought** — this already holds and must be preserved.

## G. Title valid-vs-valid (future Cloud Library work)

`recordings` has no `title_updated_at`, so a rename race between two *valid*
titles falls back to row-level `updated_at`. This can never resurrect a
placeholder (valid-beats-fallback outranks it — `lib/lectureTitle.mjs`), so it
is not a P0. True cross-device rename resolution needs a title-specific
timestamp column — deferred, not added here.

## R. Remaining gaps to close before Mac/Windows ship

- **R1:** marks / notes / note strokes have no remote columns → not account-level.
  Sharing them needs schema + merge rules (newer-shared-wins with per-field
  timestamps, mirroring the transcript/summary pattern already proven here).
- **C1:** course identity is a string name; renaming or re-casing a course on
  one device would fork it. A stable `course_id` is the durable fix.
- **D1 / G / E-gap** as above.

None of R1/C1/D1/G/E-gap block current iPad correctness. They are the concrete
backlog for the account-level library, in priority order: **deletion (D1) →
audio download endpoint (E) → notes/marks columns (R1) → course_id (C1) →
title_updated_at (G).**

---

# Stage 1 addendum (staging-verified 2026-08-11)

## Field-authority matrix (verified against staging `recordings`)
Columns present: `id, user_id, course, title, created_at, duration_sec, mime, storage_path, transcript(+_raw/_zh/_ready), translated_transcript, summary_en/zh/source/translated(+summary_ready), live_transcript(+_raw), translated_live_transcript, source_language, translation_language(+_ready), ai_status/ai_error/ai_updated_at`.
**Absent:** `deleted_at`, `updated_at`, `title_updated_at`, `course_id`, `notes`, `marks`.

| Field | Cloud column | Cross-device | Note |
|---|---|---|---|
| Lecture id | `recordings.id` (UUID) = client `remoteRecordingId` = `lecture_<uuid>` | ✅ canonical | no translation table |
| Course | `course` (name string) | ⚠️ by name | no stable `course_id` (C1) |
| title | `title` | ✅ | valid-beats-fallback guard on write |
| transcript/translation/summary | dedicated columns | ✅ authoritative | freshness by field-`*_ready`/local `*UpdatedAt` |
| audio | `storage_path` = `<user_id>/<uuid>.<ext>` | ✅ | retrieval endpoint below |
| marks / notes / noteStrokes | — | ❌ local-only | Stage-2 (needs columns) |
| deletion | — | ❌ local-only | Stage-2 (needs `deleted_at`) |
| localAudioUri | — (device local by design) | n/a | never synced |

## Audio retrieval contract (IMPLEMENTED, staging)
`GET /api/lectures/:id/audio`  ·  `Authorization: Bearer <access token>`  ·  accepts `lecture_<uuid>` or bare `<uuid>`.
→ `{ lectureId, recordingId, signedUrl, expiresInSec, mime, durationSec, title, aiStatus }`.
- Ownership: row looked up scoped to `user_id`; a non-owned or missing id both return **404** (no existence leak). Service key never leaves the server; only a short-lived (≤900s) signed URL does. `409` when the lecture has no cloud audio yet.
- Verified: second-client simulation (upload as A → retrieve by Lecture ID → download → **B denied 404** → B RLS-blocked on the row → unauth 401 → prod unreachable with staging key). `server/lectureAudioRoutes.{mjs,test.mjs}`.

## Stage-2 backlog (designed, NOT implemented — justified deferral)
1. **Deletion sync** — add `recordings.deleted_at timestamptz` (+ a monotonic `deleted_seq`/version). Delete/restore become authoritative writes; a stale active snapshot must not resurrect a newer tombstone (compare version, not row-existence). iPad purge tombstones become the transitional fallback.
2. **Notes/Marks** — add `notes text`, `marked_timestamps jsonb`, with per-field `*_updated_at`; merge = newer-wins, keep-local-if-remote-empty (mirrors transcript/summary).
3. **Stable `course_id`** — add `courses` table + `recordings.course_id`; backfill from name; keeps rename from forking a course across devices.
4. **`title_updated_at`** — resolves valid-vs-valid title races deterministically (today falls back to row freshness; can never resurrect a placeholder).
All Stage-2 items are **additive** migrations, **staging-first**, production forbidden.
