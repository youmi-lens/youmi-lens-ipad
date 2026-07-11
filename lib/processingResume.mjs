/**
 * Pure decisions for durable post-Finish processing / resume.
 *
 * A lecture used to depend on the processing screen staying mounted: upload,
 * "start backend processing", and status polling all lived in that screen's
 * effects. Tapping "Back to lecture" before the chain finished left a committed
 * lecture uploaded-but-never-triggered (AI never started) or stuck at
 * "uploading" (app killed mid-upload) with nothing to recover it.
 *
 * These pure helpers decide what a committed lecture still needs so an
 * always-mounted app-level orchestrator (see useProcessingOrchestrator.ts) can
 * drive it to completion, idempotently and independent of any screen. Keeping
 * the decision here makes it directly unit-testable and keeps the wiring small.
 */

/**
 * A committed lecture is one the user finished ("Finish lecture"): anything
 * except a still-in-progress draft, and not soft-deleted. Only committed
 * lectures are eligible for durable processing/resume.
 *
 * @param {{ status?: string, deletedAt?: string|null }} lecture
 * @returns {boolean}
 */
export function isCommittedLecture(lecture) {
  if (!lecture) return false;
  if (lecture.deletedAt) return false;
  return lecture.status !== 'in_progress';
}

/**
 * The next durable processing action a committed lecture needs, or 'none'.
 *
 *   'upload'           -> audio not on the server yet; (re)upload it.
 *   'start_processing' -> uploaded but AI never triggered; POST process.
 *   'poll'             -> AI running server-side; fetch status until done.
 *   'none'             -> already ready, terminally failed (awaiting a manual
 *                         retry), a live draft, or unrecoverable (no audio).
 *
 * Idempotency / anti-loop rules baked in here:
 *   - Never act without a remoteRecordingId (the stable server key that keeps
 *     retries from creating duplicate remote recordings).
 *   - Never redo a lecture already 'ready'.
 *   - 'upload_failed' and processing 'failed' are terminal until the user taps
 *     Retry (which resets the status) — so a genuinely failing job cannot spin
 *     in an automatic upload/trigger loop.
 *   - A stale 'uploading' (app killed mid-upload) IS eligible again; the
 *     orchestrator guards against a concurrent in-flight attempt separately.
 *
 * @param {{
 *   status?: string,
 *   deletedAt?: string|null,
 *   remoteRecordingId?: string,
 *   localAudioUri?: string|null,
 *   uploadStatus?: string,
 *   processingStatus?: string,
 * }} lecture
 * @returns {'upload'|'start_processing'|'poll'|'none'}
 */
export function nextProcessingAction(lecture) {
  if (!isCommittedLecture(lecture)) return 'none';
  if (!lecture.remoteRecordingId) return 'none';

  const uploadStatus = lecture.uploadStatus ?? 'not_uploaded';
  const processingStatus = lecture.processingStatus ?? 'not_started';

  if (processingStatus === 'ready') return 'none';

  if (uploadStatus !== 'uploaded') {
    // Fresh or interrupted upload — but only if there is a local file to send.
    // 'upload_failed' waits for the manual Retry Upload button (no auto-loop).
    if (
      (uploadStatus === 'not_uploaded' || uploadStatus === 'uploading') &&
      Boolean(lecture.localAudioUri)
    ) {
      return 'upload';
    }
    return 'none';
  }

  // Uploaded. Drive the AI trigger / status poll.
  if (processingStatus === 'not_started') return 'start_processing';
  if (processingStatus === 'processing') return 'poll';
  // 'failed' → terminal until the manual Retry Processing button resets it.
  return 'none';
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Build a non-destructive local patch from a remote recording snapshot.
 *
 * Two invariants:
 *   1. Never overwrite existing transcript/summary content with empty data — a
 *      poll that races ahead of the backend must not blank out content the
 *      lecture already has. Only non-empty remote values are copied in.
 *   2. Only mark 'ready' when transcript data is actually present, so a lecture
 *      never flips to "ready" with nothing to show.
 *
 * @param {{ transcript?: string, summaryEn?: string, summaryZh?: string }} [lecture]
 *   current lecture (for reference only; not mutated)
 * @param {{
 *   transcript?: string|null,
 *   transcript_zh?: string|null,
 *   summary_en?: string|null,
 *   summary_zh?: string|null,
 *   ai_status?: string|null,
 *   ai_error?: string|null,
 * }} remote
 * @returns {{
 *   processingStatus?: 'processing'|'ready'|'failed',
 *   processingError?: string,
 *   remoteAiStatus?: string,
 *   remoteAiError?: string,
 *   transcript?: string,
 *   transcriptZh?: string,
 *   summaryEn?: string,
 *   summaryZh?: string,
 * }} a partial Lecture patch (camelCase)
 */
export function mergeProcessingSnapshot(lecture, remote) {
  const snapshot = remote ?? {};
  const patch = {
    remoteAiStatus: snapshot.ai_status ?? undefined,
    remoteAiError: snapshot.ai_error ?? undefined,
    processingError: snapshot.ai_error ?? undefined,
  };

  if (nonEmptyString(snapshot.transcript)) patch.transcript = snapshot.transcript;
  if (nonEmptyString(snapshot.transcript_zh)) patch.transcriptZh = snapshot.transcript_zh;
  if (nonEmptyString(snapshot.summary_en)) patch.summaryEn = snapshot.summary_en;
  if (nonEmptyString(snapshot.summary_zh)) patch.summaryZh = snapshot.summary_zh;

  // "Ready" requires real data: either the backend reports done AND a transcript
  // exists (remote now or already local), or the remote row carries a full
  // transcript + both summaries. Never flip to ready with nothing to show.
  const anyTranscript = nonEmptyString(snapshot.transcript) || nonEmptyString(lecture?.transcript);
  const remoteFull =
    nonEmptyString(snapshot.transcript) &&
    nonEmptyString(snapshot.summary_en) &&
    nonEmptyString(snapshot.summary_zh);

  if (snapshot.ai_status === 'failed') {
    patch.processingStatus = 'failed';
  } else if ((snapshot.ai_status === 'done' && anyTranscript) || remoteFull) {
    patch.processingStatus = 'ready';
  } else {
    patch.processingStatus = 'processing';
  }

  return patch;
}
