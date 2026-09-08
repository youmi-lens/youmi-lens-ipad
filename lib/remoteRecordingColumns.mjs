// ── Column ladders ─────────────────────────────────────────────────────────
// Two Supabase projects diverge: staging has the Stage-2 Cloud Library columns
// but NO `updated_at`; production has `updated_at` but NOT the Stage-2 columns.
// A single query errors on whichever set is absent, so the fallback ladder
// tells the two apart by the error message and picks the matching set. The
// merge tolerates any of these (missing fields read as undefined).

/** Pre-Stage-2 set WITH updated_at — production. */
const PRE_STAGE2 =
  'id, user_id, course, title, duration_sec, ai_status, ai_error, created_at, updated_at, storage_path, transcript, transcript_zh, translated_transcript, summary_en, summary_zh, source_summary, translated_summary, live_transcript, translated_live_transcript, source_language, translation_language';

/** Cloud Library Stage 2 columns, appended as a group. */
const STAGE2_SUFFIX =
  ', course_id, deleted_at, deletion_updated_at, notes, marked_timestamps, title_updated_at, notes_updated_at, marks_updated_at';

/** Full set — updated_at + Stage-2. First attempt. */
export const REMOTE_RECORDING_COLUMNS = PRE_STAGE2 + STAGE2_SUFFIX;

/** Stage-2 columns WITHOUT updated_at — staging. */
export const REMOTE_RECORDING_COLUMNS_STAGE2_NO_UPDATED_AT =
  'id, user_id, course, title, duration_sec, ai_status, ai_error, created_at, storage_path, transcript, transcript_zh, translated_transcript, summary_en, summary_zh, source_summary, translated_summary, live_transcript, translated_live_transcript, source_language, translation_language' +
  STAGE2_SUFFIX;

/** Pre-Stage-2 set (with updated_at) — production, if it lacks Stage-2. */
export const REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT =
  'id, user_id, course, title, duration_sec, ai_status, ai_error, created_at, storage_path, transcript, transcript_zh, translated_transcript, summary_en, summary_zh, source_summary, translated_summary, live_transcript, translated_live_transcript, source_language, translation_language';

export const REMOTE_RECORDING_COLUMNS_LEGACY =
  'id, user_id, course, title, duration_sec, ai_status, ai_error, created_at, storage_path, transcript, summary_en, summary_zh, live_transcript';

/**
 * Production, post recording-soft-delete-migration: has course_id (Stage 4)
 * and deleted_at/deletion_updated_at (this migration), but not the rest of
 * Stage 2 (notes, marked_timestamps, title_updated_at, notes_updated_at,
 * marks_updated_at) yet. Tried before dropping Stage-2 entirely, so the
 * fields this exact workstream needs are not silently lost on a full
 * Stage-2 failure.
 */
export const REMOTE_RECORDING_COLUMNS_DELETION_ONLY =
  PRE_STAGE2 + ', course_id, deleted_at, deletion_updated_at';

// Derived from STAGE2_SUFFIX itself (not hand-duplicated) so the two can
// never drift apart again. They already did once: production was assumed
// to be missing ALL Stage-2 columns or NONE, but after the recording
// soft-delete migration it has SOME (course_id, deleted_at,
// deletion_updated_at) and not others (notes, marked_timestamps, ...) —
// PostgREST's error names only the one column it happened to hit first
// ("column recordings.notes does not exist"), and a hand-written pattern
// that only recognized compound names like "notes_updated_at" didn't match
// bare "notes", so remoteRecordingFallbackColumns returned null and
// fetchRemoteRecordingsForUser threw — breaking cloud sync outright on any
// project in this exact partial state, discovered live on production.
const STAGE2_COLUMN_PATTERN = new RegExp(
  STAGE2_SUFFIX.split(',').map((s) => s.trim()).filter(Boolean).join('|'),
  'i',
);
const MULTILINGUAL_COLUMN_PATTERN =
  /transcript_zh|translated_transcript|translated_live_transcript|source_summary|translated_summary|source_language|translation_language/i;

export function remoteRecordingFallbackColumns(errorMessage, attemptedColumns) {
  const message = typeof errorMessage === 'string' ? errorMessage : '';
  // A missing Stage-2 column on the full attempt → try the narrower
  // "deletion-only" Stage-2 subset before giving up on Stage-2 entirely.
  // This is what makes production's now-partial Stage-2 state (has
  // course_id/deleted_at/deletion_updated_at, lacks the notes/marks fields)
  // still work, instead of falling all the way to PRE_STAGE2 and losing the
  // very columns this workstream needs.
  if (STAGE2_COLUMN_PATTERN.test(message) && attemptedColumns === REMOTE_RECORDING_COLUMNS) {
    return REMOTE_RECORDING_COLUMNS_DELETION_ONLY;
  }
  // The deletion-only subset itself still errors (e.g. even course_id is
  // missing on some project) → drop Stage-2 entirely.
  if (STAGE2_COLUMN_PATTERN.test(message) && attemptedColumns === REMOTE_RECORDING_COLUMNS_DELETION_ONLY) {
    return PRE_STAGE2;
  }
  // A missing updated_at (staging) → keep Stage-2, drop updated_at.
  if (/updated_at/i.test(message) && attemptedColumns === REMOTE_RECORDING_COLUMNS) {
    return REMOTE_RECORDING_COLUMNS_STAGE2_NO_UPDATED_AT;
  }
  // A staging query that still errors on updated_at, or an updated_at-less prod
  // path, drops to the plain no-updated_at set.
  if (/updated_at/i.test(message)) return REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT;
  if (STAGE2_COLUMN_PATTERN.test(message)) return REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT;
  if (MULTILINGUAL_COLUMN_PATTERN.test(message)) return REMOTE_RECORDING_COLUMNS_LEGACY;
  return null;
}

/**
 * Prefer cloud content only when it is non-empty. A transient/legacy empty
 * remote field must never erase content already persisted in the user-scoped
 * device cache during hydration or a foreground refresh.
 */
export function keepLocalIfRemoteContentEmpty(remoteValue, localValue) {
  if (typeof remoteValue === 'string' && remoteValue.trim().length > 0) return remoteValue;
  return typeof localValue === 'string' ? localValue : '';
}

/**
 * Given a Supabase "column X does not exist" error, drop that column from an
 * update payload so the write can be retried on a project that lacks it. This
 * is the write-side twin of remoteRecordingFallbackColumns: staging has the
 * Stage-2 columns but no `updated_at`; production is the reverse, so a single
 * patch would fail on one of them. Returns null when nothing could be stripped
 * (so the caller stops retrying).
 *
 * @param {Record<string, unknown>} patch
 * @param {string} errorMessage
 * @returns {Record<string, unknown> | null}
 */
export function stripUnknownColumnFromPatch(patch, errorMessage) {
  const message = typeof errorMessage === 'string' ? errorMessage : '';
  const m = message.match(/column "?(?:recordings|courses)"?\.?"?([a-z_]+)"? does not exist/i)
    || message.match(/'([a-z_]+)' column/i);
  const col = m?.[1];
  if (!col || !patch || !(col in patch)) return null;
  const next = { ...patch };
  delete next[col];
  return Object.keys(next).length > 0 ? next : null;
}
