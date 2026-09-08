/**
 * Cloud Library cross-device delete audit — live production regression.
 *
 * Discovered while auditing whether the recording soft-delete migration
 * (deleted_at, deletion_updated_at) actually works end-to-end: production
 * (lbwsrnjbiayepshrdult) was confirmed LIVE, via a read-only PostgREST probe
 * (select=col&limit=0, zero rows exposed) against the real recordings table,
 * to now have a PARTIAL Stage-2 column set:
 *
 *   course_id             EXISTS  (Stage 4, earlier)
 *   deleted_at            EXISTS  (this migration)
 *   deletion_updated_at   EXISTS  (this migration)
 *   notes                 MISSING
 *   marked_timestamps     MISSING
 *   title_updated_at      MISSING
 *   notes_updated_at      MISSING
 *   marks_updated_at      MISSING
 *
 * lib/remoteRecordingColumns.mjs's fallback ladder had only ever been
 * designed for "production has ALL of Stage-2 or NONE of it" — ALTER TABLE
 * migrations landing incrementally broke that assumption. PostgREST's error
 * names only the first missing column in SELECT-list order ("column
 * recordings.notes does not exist"), and the old STAGE2_COLUMN_PATTERN only
 * matched compound names (notes_updated_at, marks_updated_at, ...), not bare
 * "notes" — so remoteRecordingFallbackColumns returned null and
 * fetchRemoteRecordingsForUser THREW, with no .catch() anywhere in its call
 * chain (applyRemoteRecordings -> refreshCloudLibrary): cloud sync silently
 * stopped updating entirely, on production, for every user, the moment this
 * migration landed — confirmed by literally feeding the real error message
 * through the real function before this fix.
 *
 * Fixed two ways:
 *  1. STAGE2_COLUMN_PATTERN is now derived FROM STAGE2_SUFFIX itself, so the
 *     two structurally cannot drift apart again.
 *  2. A new intermediate REMOTE_RECORDING_COLUMNS_DELETION_ONLY tier (the
 *     three columns production now actually has) is tried before dropping
 *     to bare PRE_STAGE2 — so the exact fields this workstream needs are not
 *     silently discarded by an overly-blunt full fallback.
 */
import assert from 'node:assert/strict';
import {
  REMOTE_RECORDING_COLUMNS,
  REMOTE_RECORDING_COLUMNS_DELETION_ONLY,
  remoteRecordingFallbackColumns,
} from '../lib/remoteRecordingColumns.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('The real production error, fed through the real function, must no longer return null');

check('the exact live error message ("column recordings.notes does not exist") resolves to a usable fallback, not null', () => {
  const result = remoteRecordingFallbackColumns('column recordings.notes does not exist', REMOTE_RECORDING_COLUMNS);
  assert.notEqual(result, null, 'a null result means fetchRemoteRecordingsForUser throws with no further fallback — the exact production outage');
});

check('that fallback is the deletion-only tier, which the migration actually needs to survive the write/read round trip', () => {
  const result = remoteRecordingFallbackColumns('column recordings.notes does not exist', REMOTE_RECORDING_COLUMNS);
  assert.equal(result, REMOTE_RECORDING_COLUMNS_DELETION_ONLY);
});

console.log('\nSTAGE2_COLUMN_PATTERN cannot drift out of sync with STAGE2_SUFFIX again (structural, not just this one column)');

check('every individual Stage-2 column name, in isolation, is recognized as a Stage-2-related error — not just the compound _updated_at forms', () => {
  const stage2Columns = ['course_id', 'deleted_at', 'deletion_updated_at', 'notes', 'marked_timestamps', 'title_updated_at', 'notes_updated_at', 'marks_updated_at'];
  for (const col of stage2Columns) {
    const result = remoteRecordingFallbackColumns(`column recordings.${col} does not exist`, REMOTE_RECORDING_COLUMNS);
    assert.notEqual(result, null, `a missing "${col}" must resolve to a fallback, not null`);
  }
});

console.log(`\nremote-recording-columns-production-partial-stage2: ${passed} checks passed`);
