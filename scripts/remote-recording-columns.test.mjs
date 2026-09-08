import assert from 'node:assert/strict';

import {
  REMOTE_RECORDING_COLUMNS,
  REMOTE_RECORDING_COLUMNS_DELETION_ONLY,
  REMOTE_RECORDING_COLUMNS_LEGACY,
  REMOTE_RECORDING_COLUMNS_STAGE2_NO_UPDATED_AT,
  REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT,
  keepLocalIfRemoteContentEmpty,
  remoteRecordingFallbackColumns,
  stripUnknownColumnFromPatch,
} from '../lib/remoteRecordingColumns.mjs';

// Write-side resilient push (Stage 2): a patch that names a column the target
// project lacks must drop that column and retry, so one payload works on both
// staging (no updated_at) and production (no Stage-2 columns).
{
  const patch = { title: 'X', title_updated_at: 't', updated_at: 't' };
  // production lacks title_updated_at
  const p1 = stripUnknownColumnFromPatch(patch, 'column "recordings"."title_updated_at" does not exist');
  assert.deepEqual(p1, { title: 'X', updated_at: 't' }, 'drops the missing Stage-2 column');
  // staging lacks updated_at
  const p2 = stripUnknownColumnFromPatch(patch, "column recordings.updated_at does not exist");
  assert.deepEqual(p2, { title: 'X', title_updated_at: 't' }, 'drops the missing updated_at');
  // nothing strippable → null (stop retrying)
  assert.equal(stripUnknownColumnFromPatch({ title: 'X' }, 'column recordings.updated_at does not exist'), null);
  assert.equal(stripUnknownColumnFromPatch(patch, 'network timeout'), null);
  // never empties to {}
  assert.equal(stripUnknownColumnFromPatch({ updated_at: 't' }, 'column recordings.updated_at does not exist'), null);
}

// STAGING (Stage-2 columns present, no `updated_at`): the updated_at error must
// drop updated_at but KEEP the Cloud Library Stage-2 columns.
const stagingFallback = remoteRecordingFallbackColumns(
  'column recordings.updated_at does not exist',
  REMOTE_RECORDING_COLUMNS,
);
assert.equal(stagingFallback, REMOTE_RECORDING_COLUMNS_STAGE2_NO_UPDATED_AT);
for (const column of [
  'source_language', 'translation_language', 'translated_transcript',
  'course_id', 'deleted_at', 'notes', 'marked_timestamps', 'title_updated_at',
]) {
  assert.match(stagingFallback, new RegExp(`\\b${column}\\b`), `${column} must survive the updated_at fallback`);
}
assert.doesNotMatch(stagingFallback, /,\s*updated_at\b/, 'bare updated_at must be dropped on staging');

// PRODUCTION, post recording-deletion migration (has `updated_at`, has
// course_id/deleted_at/deletion_updated_at, lacks the rest of Stage-2):
// discovered live — the error names whichever missing column PostgREST hits
// first in SELECT-list order (here, "notes", the first Stage-2 column NOT
// present), and the fallback must land on the narrower deletion-only Stage-2
// subset — not drop Stage-2 entirely, which would silently lose the very
// columns the cross-device delete contract needs.
const prodFirstFallback = remoteRecordingFallbackColumns(
  'column recordings.notes does not exist',
  REMOTE_RECORDING_COLUMNS,
);
assert.equal(prodFirstFallback, REMOTE_RECORDING_COLUMNS_DELETION_ONLY);
assert.match(prodFirstFallback, /,\s*updated_at\b/, 'production keeps updated_at');
for (const column of ['course_id', 'deleted_at', 'deletion_updated_at']) {
  assert.match(prodFirstFallback, new RegExp(`\\b${column}\\b`), `${column} must survive the first production fallback`);
}
for (const column of ['marked_timestamps', 'title_updated_at', 'notes_updated_at', 'marks_updated_at']) {
  assert.doesNotMatch(prodFirstFallback, new RegExp(`\\b${column}\\b`), `${column} is genuinely absent and must not be requested`);
}
assert.doesNotMatch(prodFirstFallback, /\bnotes\b/, 'bare notes must not be requested — it does not exist on this project');

// If even the narrower deletion-only subset still errors (an environment
// missing course_id too), the SECOND fallback must drop Stage-2 entirely —
// this is the one-tier-deeper case the original (now-corrected) test only
// modeled as a single step.
const prodSecondFallback = remoteRecordingFallbackColumns(
  'column recordings.course_id does not exist',
  REMOTE_RECORDING_COLUMNS_DELETION_ONLY,
);
assert.match(prodSecondFallback, /,\s*updated_at\b/, 'production keeps updated_at');
assert.doesNotMatch(prodSecondFallback, /course_id|deleted_at|marked_timestamps/, 'Stage-2 group dropped entirely on the second fallback');

// Deeper multilingual fallback still reaches LEGACY.
assert.equal(
  remoteRecordingFallbackColumns(
    'column recordings.source_summary does not exist',
    REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT,
  ),
  REMOTE_RECORDING_COLUMNS_LEGACY,
);
assert.equal(remoteRecordingFallbackColumns('network timeout', REMOTE_RECORDING_COLUMNS), null);

assert.equal(keepLocalIfRemoteContentEmpty('cloud summary', 'cached summary'), 'cloud summary');
assert.equal(
  keepLocalIfRemoteContentEmpty('', 'cached translated summary'),
  'cached translated summary',
  'empty reload must not erase cached translated content',
);
assert.equal(
  keepLocalIfRemoteContentEmpty('   ', 'cached translated summary'),
  'cached translated summary',
  'whitespace-only reload must not erase cached translated content',
);

console.log('remote recording column fallback tests passed');
