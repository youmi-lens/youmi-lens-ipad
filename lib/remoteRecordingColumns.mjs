export const REMOTE_RECORDING_COLUMNS =
  'id, user_id, course, title, duration_sec, ai_status, ai_error, created_at, updated_at, storage_path, transcript, transcript_zh, translated_transcript, summary_en, summary_zh, source_summary, translated_summary, live_transcript, translated_live_transcript, source_language, translation_language';

export const REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT =
  'id, user_id, course, title, duration_sec, ai_status, ai_error, created_at, storage_path, transcript, transcript_zh, translated_transcript, summary_en, summary_zh, source_summary, translated_summary, live_transcript, translated_live_transcript, source_language, translation_language';

export const REMOTE_RECORDING_COLUMNS_LEGACY =
  'id, user_id, course, title, duration_sec, ai_status, ai_error, created_at, storage_path, transcript, summary_en, summary_zh, live_transcript';

const MULTILINGUAL_COLUMN_PATTERN =
  /transcript_zh|translated_transcript|translated_live_transcript|source_summary|translated_summary|source_language|translation_language/i;

export function remoteRecordingFallbackColumns(errorMessage, attemptedColumns) {
  const message = typeof errorMessage === 'string' ? errorMessage : '';
  if (/updated_at/i.test(message) && attemptedColumns === REMOTE_RECORDING_COLUMNS) {
    return REMOTE_RECORDING_COLUMNS_WITHOUT_UPDATED_AT;
  }
  if (MULTILINGUAL_COLUMN_PATTERN.test(message)) return REMOTE_RECORDING_COLUMNS_LEGACY;
  return null;
}
