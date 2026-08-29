import { API_BASE_URL } from './config';

type StartRemoteProcessingInput = {
  remoteRecordingId: string;
  accessToken: string | null | undefined;
};

/**
 * `status` mirrors the backend's client-visible recovery contract exactly
 * (see server/processingRecovery.mjs `processingAcceptedStatus` /
 * server/processRecording.mjs) — 'resumed_from_transcription' and
 * 'resumed_from_summary' arrive on 202 (server decided the stage; the client
 * never does), 'already_processing' on 202 (another worker/request already
 * owns this lease — not an error), and 'already_complete' on 200. A 409
 * ('unrecoverable') throws instead — see below — so it is never present here.
 */
type StartRemoteProcessingResult = {
  ok?: boolean;
  recordingId?: string;
  deduped?: boolean;
  status?: 'resumed_from_transcription' | 'resumed_from_summary' | 'already_processing' | 'already_complete' | string;
};

/** Thrown specifically for HTTP 409 — the backend could not find a transcript OR usable uploaded audio to recover from. Distinguished from a generic request failure so the caller can decide whether local audio still makes this recoverable via re-upload. */
export class ProcessingUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessingUnrecoverableError';
  }
}

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

  if (response.status === 409) {
    throw new ProcessingUnrecoverableError(
      payload?.message ?? 'No uploaded audio or persisted transcript is available for recovery.',
    );
  }
  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `Processing request failed with HTTP ${response.status}.`);
  }

  return payload ?? {};
}
