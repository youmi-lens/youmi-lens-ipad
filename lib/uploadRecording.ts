import { API_BASE_URL } from './config';

type UploadLectureAudioInput = {
  localUri: string | null;
  lectureId: string;
  recordingId: string;
  mimeType?: string;
  accessToken: string | null | undefined;
  durationMillis?: number;
  course?: string;
  /** Canonical course identity (courses.id UUID). Sent so the row is linked at
   *  first insert; legacy non-UUID ids are not sent (backend heals those). */
  courseId?: string | null;
  title?: string;
  liveTranscript?: string;
  translatedLiveTranscript?: string;
  sourceLanguage?: string;
  translationLanguage?: string;
};

type UploadLectureAudioResult = {
  storagePath: string;
  mime: string;
  size: number;
  recording?: unknown;
};

type ReactNativeFilePart = {
  uri: string;
  name: string;
  type: string;
};

function uploadEndpointHost(): string {
  try {
    return new URL(API_BASE_URL).host;
  } catch {
    return '(invalid or missing API base URL)';
  }
}

function localAudioDiagnostics(localUri: string | null): { exists: boolean; size: number | null } {
  if (!localUri) return { exists: false, size: null };
  try {
    const FileSystem = require('expo-file-system') as typeof import('expo-file-system');
    const file = new FileSystem.File(localUri);
    return { exists: Boolean(file.exists), size: typeof file.size === 'number' ? file.size : null };
  } catch {
    return { exists: false, size: null };
  }
}

function logUploadStart(input: Pick<UploadLectureAudioInput, 'lectureId' | 'recordingId' | 'localUri' | 'accessToken'>): void {
  if (!__DEV__) return;
  const local = localAudioDiagnostics(input.localUri);
  console.info('UPLOAD_START', {
    lectureId: input.lectureId,
    remoteRecordingId: input.recordingId,
    localFileExists: local.exists,
    localFileSize: local.size,
    resolvedEndpointHost: uploadEndpointHost(),
    authPresent: Boolean(input.accessToken),
  });
}

function logUploadResult(result: Record<string, unknown>): void {
  if (__DEV__) console.info('UPLOAD_RESULT', result);
}

export async function uploadLectureAudio({
  localUri,
  lectureId,
  recordingId,
  mimeType = 'audio/m4a',
  accessToken,
  durationMillis,
  course,
  courseId,
  title,
  liveTranscript,
  translatedLiveTranscript,
  sourceLanguage,
  translationLanguage,
}: UploadLectureAudioInput): Promise<UploadLectureAudioResult> {
  const startedAt = Date.now();
  let httpStatus: number | null = null;
  logUploadStart({ lectureId, recordingId, localUri, accessToken });
  try {
    if (!API_BASE_URL) throw new Error('Missing API base URL.');
    if (!localUri) throw new Error('No local audio file is available for upload.');
    if (!accessToken) throw new Error('Please sign in to upload this recording.');
    if (!recordingId) throw new Error('Missing remote recording id.');

    const formData = new FormData();
    const file: ReactNativeFilePart = {
      uri: localUri,
      name: `${lectureId}.m4a`,
      type: mimeType,
    };
    formData.append('file', file as unknown as Blob);
    formData.append('recordingId', recordingId);
    formData.append('mime', mimeType);
    if (durationMillis !== undefined) formData.append('duration_sec', String(durationMillis / 1000));
    if (course) formData.append('course', course);
    // Canonical relationship: send the Course UUID so the backend writes
    // recordings.course_id at the FIRST insert. Only a real UUID is sent — a
    // legacy name-derived id is omitted and left to the legacy reconciliation.
    if (courseId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courseId)) {
      formData.append('course_id', courseId);
    }
    if (title) formData.append('title', title);
    if (liveTranscript) {
      formData.append('live_transcript', liveTranscript);
      formData.append('live_transcript_raw', liveTranscript);
    }
    if (translatedLiveTranscript) formData.append('translated_live_transcript', translatedLiveTranscript);
    if (sourceLanguage) formData.append('source_language', sourceLanguage);
    if (translationLanguage) formData.append('translation_language', translationLanguage);

    const response = await fetch(`${API_BASE_URL}/api/upload-audio`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: formData,
    });
    httpStatus = response.status;

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // handled below
    }

    if (!response.ok) {
      const body = payload as { message?: string; error?: string } | null;
      throw new Error(body?.message ?? body?.error ?? `Upload failed with HTTP ${response.status}.`);
    }

    const body = payload as Partial<UploadLectureAudioResult> | null;
    if (!body?.storagePath || !body.mime || typeof body.size !== 'number') {
      throw new Error('Upload completed, but the server response was incomplete.');
    }

    const result = {
      storagePath: body.storagePath,
      mime: body.mime,
      size: body.size,
      recording: body.recording,
    };
    logUploadResult({ success: true, httpStatus, elapsedMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logUploadResult({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown upload failure.',
      httpStatus,
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}
