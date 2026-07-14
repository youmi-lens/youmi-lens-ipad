import { API_BASE_URL } from './config';

type UploadLectureAudioInput = {
  localUri: string | null;
  lectureId: string;
  recordingId: string;
  mimeType?: string;
  accessToken: string | null | undefined;
  durationMillis?: number;
  course?: string;
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

export async function uploadLectureAudio({
  localUri,
  lectureId,
  recordingId,
  mimeType = 'audio/m4a',
  accessToken,
  durationMillis,
  course,
  title,
  liveTranscript,
  translatedLiveTranscript,
  sourceLanguage,
  translationLanguage,
}: UploadLectureAudioInput): Promise<UploadLectureAudioResult> {
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

  return {
    storagePath: body.storagePath,
    mime: body.mime,
    size: body.size,
    recording: body.recording,
  };
}
