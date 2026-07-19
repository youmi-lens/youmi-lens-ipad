export const DEFAULT_RECORDING_ENGINE = 'legacy';

export function resolveRecordingEngineValue(configured, forceLegacy = false) {
  if (forceLegacy) return 'legacy';
  return configured === 'nativeDurable' ? 'nativeDurable' : 'legacy';
}

export function finalizedDurationMillis(session) {
  return (session?.segments ?? []).reduce((total, segment) => total + Math.max(0, segment.durationMs ?? 0), 0);
}

export function recoverableSessionsForLecture(sessions, lectureId) {
  return (sessions ?? [])
    .filter((session) => session?.lectureId === lectureId && (
      session.recoverable === true || (session.state === 'finalized' && !session.handoffCompletedAt)
    ))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.recordingSessionId.localeCompare(b.recordingSessionId));
}

export function orderedSourceSegmentIds(session) {
  return [...(session?.segments ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .map((segment) => segment.segmentId);
}

export function finalAssetIsComplete(session) {
  const expected = orderedSourceSegmentIds(session);
  const actual = session?.finalAsset?.sourceSegmentIds ?? [];
  return session?.state === 'finalized'
    && session?.finalAsset?.relativePath === 'final/lecture.m4a'
    && session?.finalAsset?.durationMs > 0
    && expected.length > 0
    && expected.every((id, index) => actual[index] === id)
    && actual.length === expected.length;
}

export function canFallbackBeforeNativeAudio(session) {
  return !session || (session.segments?.length ?? 0) === 0;
}
