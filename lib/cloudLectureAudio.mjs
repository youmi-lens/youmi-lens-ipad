/**
 * Owner-authenticated cloud audio resolution. The backend is responsible for
 * checking recording ownership and producing a short-lived signed URL; this
 * client never talks to Storage with privileged credentials.
 */

export function cloudLectureAudioEndpoint(apiBaseUrl, recordingId) {
  const base = typeof apiBaseUrl === 'string' ? apiBaseUrl.replace(/\/+$/, '') : '';
  const id = typeof recordingId === 'string' ? recordingId.trim() : '';
  if (!base) throw new Error('Missing API base URL.');
  if (!id) throw new Error('Missing remote recording id.');
  return `${base}/api/lectures/${encodeURIComponent(id)}/audio`;
}

export function parseCloudLectureAudioResponse(payload) {
  const signedUrl = typeof payload?.signedUrl === 'string' ? payload.signedUrl.trim() : '';
  if (!signedUrl) throw new Error('Cloud audio response did not include a signed URL.');
  let parsed;
  try {
    parsed = new URL(signedUrl);
  } catch {
    throw new Error('Cloud audio response included an invalid signed URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Cloud audio response included a non-HTTPS URL.');
  }
  return {
    signedUrl,
    expiresInSec: typeof payload?.expiresInSec === 'number' ? payload.expiresInSec : null,
    mime: typeof payload?.mime === 'string' ? payload.mime : null,
    durationSec: typeof payload?.durationSec === 'number' ? payload.durationSec : null,
  };
}

export async function requestCloudLectureAudio({ apiBaseUrl, recordingId, accessToken, fetchImpl = fetch }) {
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!token) throw new Error('Please sign in to play cloud audio.');

  const response = await fetchImpl(cloudLectureAudioEndpoint(apiBaseUrl, recordingId), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Cloud audio request failed with HTTP ${response.status}.`);
  }
  return parseCloudLectureAudioResponse(payload);
}
