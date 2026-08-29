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

/**
 * Whether a committed lecture should show a manual "Retry Processing" action,
 * and if so, what the retry should actually reset — reused by BOTH the
 * "Retry Processing" button's visibility/copy in the Lecture Detail screen
 * and by retryLectureProcessing itself, so there is exactly one place that
 * decides recoverability (see PROCESSING RECOVERY UX task).
 *
 * The server is the sole authority on WHICH stage (transcription vs summary)
 * actually resumes — this only decides whether the CLIENT still needs to
 * (re)upload audio before calling the backend, or can call it directly.
 *
 *   kind 'none'          -> no action needed (processing/ready/live draft) or
 *                            not eligible at all (no remoteRecordingId yet).
 *   kind 'retry'          -> show "Retry Processing"; `plan` says what a tap
 *                            should reset:
 *       plan 'reupload'   -> re-run the existing upload path first (reuses
 *                            the same remoteRecordingId, never mints a new
 *                            one), then the orchestrator drives processing.
 *       plan 'reprocess'  -> audio is already on the server; skip upload and
 *                            call the backend recovery endpoint directly.
 *   kind 'unrecoverable' -> terminally failed AND no usable source (no local
 *                            audio file reference, no successful upload) — a
 *                            functional Retry would just fail again, so the
 *                            UI must not offer one.
 *
 * @param {{
 *   status?: string,
 *   deletedAt?: string|null,
 *   remoteRecordingId?: string,
 *   localAudioUri?: string|null,
 *   uploadStatus?: string,
 *   processingStatus?: string,
 * } | null | undefined} lecture
 * @returns {{ kind: 'none'|'retry'|'unrecoverable', plan: 'reupload'|'reprocess'|null }}
 */
export function getLectureRecoveryState(lecture) {
  const none = { kind: 'none', plan: null };
  if (!lecture || !isCommittedLecture(lecture)) return none;
  if (!lecture.remoteRecordingId) return none;

  const uploadStatus = lecture.uploadStatus ?? 'not_uploaded';
  const processingStatus = lecture.processingStatus ?? 'not_started';
  const hasLocalAudio = Boolean(lecture.localAudioUri);

  // Actively working — never show a retry action while one is already running.
  if (processingStatus === 'processing') return none;
  if (processingStatus === 'ready') return none;

  if (uploadStatus === 'upload_failed') {
    return hasLocalAudio ? { kind: 'retry', plan: 'reupload' } : { kind: 'unrecoverable', plan: null };
  }
  if (uploadStatus === 'uploaded' && processingStatus === 'failed') {
    return { kind: 'retry', plan: 'reprocess' };
  }
  if (processingStatus === 'failed') {
    // Failed with no clean uploaded state on record — only recoverable if
    // there is still a local file to re-send from.
    return hasLocalAudio ? { kind: 'retry', plan: 'reupload' } : { kind: 'unrecoverable', plan: null };
  }
  return none;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function snapshotValue(snapshot, lecture, remoteKey, localKey) {
  return nonEmptyString(snapshot?.[remoteKey]) ? snapshot[remoteKey] : lecture?.[localKey];
}

function summaryForLanguage(snapshot, lecture, language) {
  if (language === 'en') return snapshotValue(snapshot, lecture, 'summary_en', 'summaryEn');
  if (language === 'zh-Hans') return snapshotValue(snapshot, lecture, 'summary_zh', 'summaryZh');
  return undefined;
}

/** Complete means the persisted source/translation pair can actually render. */
function hasCompleteLanguagePair(lecture, snapshot) {
  const sourceLanguage = snapshotValue(snapshot, lecture, 'source_language', 'sourceLanguage') || 'en';
  const translationLanguage =
    snapshotValue(snapshot, lecture, 'translation_language', 'translationLanguage') || 'zh-Hans';
  const translationRequired = sourceLanguage !== translationLanguage;

  const sourceTranscript = snapshotValue(snapshot, lecture, 'transcript', 'transcript');
  const translatedTranscript = snapshotValue(
    snapshot,
    lecture,
    'translated_transcript',
    'translatedTranscript',
  ) || (translationLanguage === 'zh-Hans'
    ? snapshotValue(snapshot, lecture, 'transcript_zh', 'transcriptZh')
    : undefined);
  const sourceSummary = snapshotValue(snapshot, lecture, 'source_summary', 'sourceSummary')
    || summaryForLanguage(snapshot, lecture, sourceLanguage);
  const translatedSummary = snapshotValue(snapshot, lecture, 'translated_summary', 'translatedSummary')
    || summaryForLanguage(snapshot, lecture, translationLanguage);

  return Boolean(
    nonEmptyString(sourceTranscript)
      && nonEmptyString(sourceSummary)
      && (!translationRequired
        || (nonEmptyString(translatedTranscript) && nonEmptyString(translatedSummary))),
  );
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
 *   translated_transcript?: string|null,
 *   source_language?: string|null,
 *   translation_language?: string|null,
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

  if (!lecture?.transcriptUpdatedAt) {
    if (nonEmptyString(snapshot.transcript)) patch.transcript = snapshot.transcript;
    if (nonEmptyString(snapshot.transcript_zh)) patch.transcriptZh = snapshot.transcript_zh;
    if (nonEmptyString(snapshot.translated_transcript)) patch.translatedTranscript = snapshot.translated_transcript;
  }
  if (nonEmptyString(snapshot.source_language)) patch.sourceLanguage = snapshot.source_language;
  if (nonEmptyString(snapshot.translation_language)) patch.translationLanguage = snapshot.translation_language;
  // Skip remote summary copies after a local manual edit so processing polls
  // cannot overwrite the user's saved Summary text.
  if (!lecture?.summaryUpdatedAt) {
    if (nonEmptyString(snapshot.summary_en)) patch.summaryEn = snapshot.summary_en;
    if (nonEmptyString(snapshot.summary_zh)) patch.summaryZh = snapshot.summary_zh;
    if (nonEmptyString(snapshot.source_summary)) patch.sourceSummary = snapshot.source_summary;
    if (nonEmptyString(snapshot.translated_summary)) patch.translatedSummary = snapshot.translated_summary;
  }

  if (snapshot.ai_status === 'failed') {
    patch.processingStatus = 'failed';
  } else if (snapshot.ai_status === 'done' && hasCompleteLanguagePair(lecture, snapshot)) {
    patch.processingStatus = 'ready';
  } else {
    patch.processingStatus = 'processing';
  }

  return patch;
}
