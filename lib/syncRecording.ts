import { supabase } from './supabase';

type FetchRemoteRecordingInput = {
  remoteRecordingId: string;
  accessToken: string | null | undefined;
  userId: string | null | undefined;
};

export type RemoteRecordingSnapshot = {
  id: string;
  transcript: string | null;
  /**
   * Chinese transcript, translated backend-side from the English transcript.
   * Null until generated, and absent entirely on databases predating
   * supabase-migration-transcript-zh.sql.
   */
  transcript_zh: string | null;
  translated_transcript: string | null;
  /**
   * The live-caption-derived translation, captured during recording. For many
   * recordings this is the ONLY place the translated transcript actually
   * lands — the backend's post-processing pipeline does not always also
   * (re)write translated_transcript/transcript_zh. Treated as an authoritative
   * fallback source of translated-transcript content, matching what
   * lib/store.tsx's own remote-recording merge already does.
   */
  translated_live_transcript: string | null;
  source_language: string | null;
  translation_language: string | null;
  summary_en: string | null;
  summary_zh: string | null;
  source_summary: string | null;
  translated_summary: string | null;
  ai_status: string | null;
  ai_error: string | null;
  ai_updated_at: string | null;
};

// Full column set (with transcript_zh) plus a legacy fallback used when the
// transcript_zh migration has not been applied to the database yet.
const RECORDING_COLUMNS =
  'id, transcript, transcript_zh, translated_transcript, translated_live_transcript, source_language, translation_language, summary_en, summary_zh, source_summary, translated_summary, ai_status, ai_error, ai_updated_at';
const RECORDING_COLUMNS_LEGACY =
  'id, transcript, translated_live_transcript, summary_en, summary_zh, ai_status, ai_error, ai_updated_at';

export async function fetchRemoteRecording({
  remoteRecordingId,
  accessToken,
  userId,
}: FetchRemoteRecordingInput): Promise<RemoteRecordingSnapshot> {
  if (!remoteRecordingId) throw new Error('Missing remote recording id.');
  if (!accessToken || !userId) throw new Error('Please sign in to sync this recording.');

  let { data, error } = await supabase
    .from('recordings')
    .select(RECORDING_COLUMNS)
    .eq('id', remoteRecordingId)
    .eq('user_id', userId)
    .single();

  // Backward compatibility: a database without the transcript_zh column errors
  // on the select above. Retry with the legacy columns so sync keeps working
  // until supabase-migration-transcript-zh.sql is applied.
  if (error && /transcript_zh|translated_transcript|translated_live_transcript|source_summary|translated_summary|source_language|translation_language/i.test(error.message)) {
    ({ data, error } = await supabase
      .from('recordings')
      .select(RECORDING_COLUMNS_LEGACY)
      .eq('id', remoteRecordingId)
      .eq('user_id', userId)
      .single());
  }

  if (error) {
    throw new Error(`Could not sync remote recording: ${error.message}`);
  }

  const row = (data ?? {}) as Partial<RemoteRecordingSnapshot>;
  return {
    id: String(row.id ?? remoteRecordingId),
    transcript: row.transcript ?? null,
    transcript_zh: row.transcript_zh ?? null,
    translated_transcript: row.translated_transcript ?? row.transcript_zh ?? null,
    translated_live_transcript: row.translated_live_transcript ?? null,
    source_language: row.source_language ?? 'en',
    translation_language: row.translation_language ?? 'zh-Hans',
    summary_en: row.summary_en ?? null,
    summary_zh: row.summary_zh ?? null,
    source_summary: row.source_summary ?? null,
    translated_summary: row.translated_summary ?? null,
    ai_status: row.ai_status ?? null,
    ai_error: row.ai_error ?? null,
    ai_updated_at: row.ai_updated_at ?? null,
  };
}
