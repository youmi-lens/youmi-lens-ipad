/**
 * Standalone durable-session finalize+export sequence, extracted from
 * useNativeDurableLectureRecorder's own `finishSession` so it can be reused
 * outside a live recording screen — specifically, recovering an orphaned
 * (paused, never-finalized) durable session as part of legacy-resume
 * assembly (see mediaSourceDiscovery.ts). The hook still owns its own React
 * state updates around the same native call sequence; this only extracts
 * the sequence itself so it isn't duplicated.
 */
import {
  DurableRecorderError,
  exportFinalizedAsset,
  finalizeSession,
  recoverRecordingSession,
  stopRecording as stopNative,
  type DurableRecordingSession,
  type DurableRecordingStatus,
} from '@/modules/expo-durable-recorder';

export type DurableSessionRecoveryResult =
  | { ok: true; fileUri: string; durationMs: number; session: DurableRecordingSession }
  | { ok: false; error: string; errorCode?: string };

/**
 * Brings a durable session to `finalized` (from `paused`, `recording`, or
 * `finalizing`) and exports its verified final asset. Idempotent — calling
 * this on an already-finalized session with a final asset just re-exports
 * (the native exporter itself is idempotent and never re-composes once a
 * final asset already exists). Never touches or deletes the source
 * segments; the native store only ever copies/reads them.
 *
 * `onStatus` is optional — a live recording screen passes its own
 * sequence-tracking callback (so a delayed native status push during this
 * sequence can't be misread as newer than what this call already knows);
 * a standalone caller with no live event listener (e.g. legacy-resume
 * media recovery) can omit it.
 */
export async function finalizeAndExportDurableSession(
  session: DurableRecordingSession,
  onStatus?: (status: DurableRecordingStatus) => void,
): Promise<DurableSessionRecoveryResult> {
  try {
    let finalSession = session;
    if (finalSession.state === 'paused' || finalSession.state === 'recording') {
      try {
        const stopped = await stopNative({ recordingSessionId: finalSession.recordingSessionId });
        onStatus?.(stopped);
        if (stopped.session) finalSession = stopped.session;
      } catch {
        const recovered = await recoverRecordingSession({ recordingSessionId: finalSession.recordingSessionId });
        finalSession = recovered.session;
        const stopped = await stopNative({ recordingSessionId: finalSession.recordingSessionId });
        onStatus?.(stopped);
        if (stopped.session) finalSession = stopped.session;
      }
    } else if (finalSession.state === 'finalizing') {
      finalSession = await finalizeSession({ recordingSessionId: finalSession.recordingSessionId });
    }
    const output = await exportFinalizedAsset({ recordingSessionId: finalSession.recordingSessionId });
    const durationMs = output.session.finalAsset?.durationMs ?? 0;
    if (durationMs <= 0) {
      return { ok: false, error: 'The durable session export produced no verified duration.' };
    }
    return { ok: true, fileUri: output.fileUri, durationMs, session: output.session };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error instanceof DurableRecorderError ? error.code : undefined,
    };
  }
}
