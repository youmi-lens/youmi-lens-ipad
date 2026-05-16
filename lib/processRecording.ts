import { API_BASE_URL } from './config';

type StartRemoteProcessingInput = {
  remoteRecordingId: string;
  accessToken: string | null | undefined;
};

type StartRemoteProcessingResult = {
  ok?: boolean;
  recordingId?: string;
  deduped?: boolean;
};

export async function startRemoteProcessing({
  remoteRecordingId,
  accessToken,
}: StartRemoteProcessingInput): Promise<StartRemoteProcessingResult> {
  if (!API_BASE_URL) throw new Error('Missing API base URL.');
  if (!remoteRecordingId) throw new Error('Missing remote recording id.');
  if (!accessToken) throw new Error('Please sign in to process this recording.');

  const response = await fetch(`${API_BASE_URL}/api/process-recording`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recordingId: remoteRecordingId }),
  });

  const payload = (await response.json().catch(() => null)) as
    | (StartRemoteProcessingResult & { error?: string; message?: string })
    | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `Processing request failed with HTTP ${response.status}.`);
  }

  return payload ?? {};
}
