/**
 * "Retry Processing" — the one client recovery action for a stuck/failed
 * lecture (App Review-adjacent product fix: a saved recording whose upload
 * or backend processing terminally failed must be recoverable without
 * re-recording).
 *
 * Deliberately NOT a second processing pipeline. useProcessingOrchestrator.ts
 * already drives upload → backend-trigger → poll for every committed lecture,
 * durably and idempotently (see its own header comment); a lecture only stops
 * being driven automatically once uploadStatus/processingStatus lands on a
 * terminal 'upload_failed' / 'failed' value (see processingResume.mjs's
 * nextProcessingAction, which returns 'none' for exactly those states "until
 * the user taps Retry, which resets the status"). This function IS that
 * reset — it never uploads or calls the backend itself. The already-mounted
 * orchestrator's own effect (which re-runs on every lecture-state change) and
 * its own in-flight guards (uploadingRef/startingRef) pick the reset up and
 * do the actual work, so double-tapping this function is already safe without
 * a second guard: two rapid identical resets just cause the orchestrator's
 * existing `.has(lectureId)` check to no-op the second one.
 *
 * The server — not this function — decides whether recovery resumes from
 * transcription or from summary; see useProcessingOrchestrator's
 * startProcessing for how the backend's resumed_from_transcription /
 * resumed_from_summary / already_processing / already_complete / unrecoverable
 * response is handled once the request actually goes out.
 */
import { getLectureRecoveryState } from './processingResume.mjs';
import type { Lecture } from './models';

export type RetryLectureProcessingResult = {
  /** What the retry actually did — 'none' means the button should not have been tappable. */
  action: 'reupload' | 'reprocess' | 'none';
};

export function retryLectureProcessing(
  lecture: Lecture,
  updateLecture: (id: string, patch: Partial<Lecture>) => void,
): RetryLectureProcessingResult {
  const recovery = getLectureRecoveryState(lecture);
  if (recovery.kind !== 'retry') return { action: 'none' };

  if (recovery.plan === 'reupload') {
    // Same lecture id, same remoteRecordingId, same localAudioUri — only the
    // upload-attempt fields reset. startUpload always reuses lecture's
    // existing remoteRecordingId; it never mints a new one.
    updateLecture(lecture.id, { uploadStatus: 'not_uploaded', uploadError: undefined });
    return { action: 'reupload' };
  }

  // 'reprocess': audio is already uploaded — skip straight to the backend
  // recovery call via the orchestrator's normal start_processing path.
  updateLecture(lecture.id, { processingStatus: 'not_started', processingError: undefined });
  return { action: 'reprocess' };
}
