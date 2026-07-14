import assert from 'node:assert/strict';

import {
  REMOTE_RECORDING_COLUMNS,
  REMOTE_RECORDING_COLUMNS_LEGACY,
  REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT,
  remoteRecordingFallbackColumns,
} from '../lib/remoteRecordingColumns.mjs';

const stagingFallback = remoteRecordingFallbackColumns(
  'column recordings.updated_at does not exist',
  REMOTE_RECORDING_COLUMNS,
);
assert.equal(stagingFallback, REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT);
for (const column of [
  'source_language',
  'translation_language',
  'translated_transcript',
  'source_summary',
  'translated_summary',
]) {
  assert.match(stagingFallback, new RegExp(`\\b${column}\\b`), `${column} must survive the updated_at fallback`);
}

assert.equal(
  remoteRecordingFallbackColumns(
    'column recordings.source_summary does not exist',
    REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT,
  ),
  REMOTE_RECORDING_COLUMNS_LEGACY,
);
assert.equal(remoteRecordingFallbackColumns('network timeout', REMOTE_RECORDING_COLUMNS), null);

console.log('remote recording column fallback tests passed');
