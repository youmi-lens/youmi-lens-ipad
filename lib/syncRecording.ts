import { supabase } from './supabase';

type FetchRemoteRecordingInput = {
  remoteRecordingId: string;
  accessToken: string | null | undefined;
};

export type RemoteRecordingSnapshot = {
  id: string;
  transcript: string | null;
  summary_en: string | null;
  summary_zh: string | null;
  ai_status: string | null;
  ai_error: string | null;
  ai_updated_at: string | null;
};

export async function fetchRemoteRecording({
  remoteRecordingId,
  accessToken,
}: FetchRemoteRecordingInput): Promise<RemoteRecordingSnapshot> {
  if (!remoteRecordingId) throw new Error('Missing remote recording id.');
  if (!accessToken) throw new Error('Please sign in to sync this recording.');

  const { data, error } = await supabase
    .from('recordings')
    .select('id, transcript, summary_en, summary_zh, ai_status, ai_error, ai_updated_at')
    .eq('id', remoteRecordingId)
    .single();

  if (error) {
    throw new Error(`Could not sync remote recording: ${error.message}`);
  }

  return data as RemoteRecordingSnapshot;
}
