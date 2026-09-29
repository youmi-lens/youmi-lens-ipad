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
 * Single canonical completion predicate — reused by navigation routing (which
 * lectures may enter Lecture Detail vs must route to the Processing gate) and
 * by the Processing screen's own View/Back gating, so there is exactly one
 * definition of "done" across the app. A lecture is complete only once the
 * server has actually produced a usable transcript+summary pair; a live
 * draft or a merely-uploaded-but-unprocessed lecture is never complete.
 *
 * @param {{ status?: string, processingStatus?: string }} [lecture]
 * @returns {boolean}
 */
export function isLectureComplete(lecture) {
  if (!lecture) return false;
  return lecture.processingStatus === 'ready';
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
  // A legacy recovery produced more than one source file. Uploading the old
  // canonical file or the newest segment alone would silently lose content.
  if (lecture.audioAssemblyStatus === 'required') return 'none';

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
  if (lecture.audioAssemblyStatus === 'required') return none;

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
  // translated_transcript/transcript_zh are the backend's dedicated
  // post-processing translation columns, but for many recordings the backend
  // never (re)writes them — the translated transcript instead lives only in
  // translated_live_transcript, captured live during recording via the
  // caption pipeline. Without this fallback, a fully-processed, fully
  // translation_ready recording could never satisfy this check, so
  // mergeProcessingSnapshot would never conclude 'ready' — the exact
  // WR112/WR2 production bug (Sep 4 2026): ai_status='done',
  // translation_ready=true, translated_summary populated, yet
  // translated_transcript and transcript_zh both null. lib/store.tsx's own
  // remote-recording merge already treats translated_live_transcript as
  // legitimate translated content; this mirrors that same precedent.
  const translatedTranscript = snapshotValue(
    snapshot,
    lecture,
    'translated_transcript',
    'translatedTranscript',
  ) || (translationLanguage === 'zh-Hans'
    ? snapshotValue(snapshot, lecture, 'transcript_zh', 'transcriptZh')
    : undefined)
    || snapshotValue(snapshot, lecture, 'translated_live_transcript', 'translatedLiveTranscript');
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
 *   translated_live_transcript?: string|null,
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
  } else if (snapshot.ai_status === 'done' && snapshot.transcript === '') {
    // No-speech empty success (server/processRecording.mjs's
    // markDoneEmptyNoSpeech): DashScope genuinely completed transcription
    // and found no speech. That write always sets transcript to an explicit
    // empty STRING, atomically alongside ai_status/summary fields — never
    // null, and never produced by any other backend path (a real in-flight
    // recording has transcript === null/undefined until real content
    // lands). This is therefore an unambiguous, authoritative signal,
    // distinct from the hasCompleteLanguagePair race guard below: that
    // guard exists for recordings that DO have real content but whose
    // multi-stage write hasn't fully landed yet (WR112/WR2, the
    // French/Chinese race) — a case this row is structurally not in, since
    // there is nothing left to arrive. ai_status === 'done' must be
    // terminal and authoritative even with empty content; a content-based
    // heuristic can never observe this correctly, because the content is
    // legitimately absent, not merely delayed. See processing-status-
    // no-speech-ready.test.mjs, and the real production incidents that
    // exposed this (recordings 7885e218-... and b1aee347-...).
    patch.processingStatus = 'ready';
  } else if (snapshot.ai_status === 'done' && hasCompleteLanguagePair(lecture, snapshot)) {
    patch.processingStatus = 'ready';
  } else if (lecture?.processingStatus === 'ready') {
    // Terminal-state monotonicity: this lecture already reached 'ready'. A
    // fresh snapshot that merely looks less complete right now — a stale
    // poll response, a snapshot missing a field this pass — must never
    // regress an already-ready lecture back to 'processing'. The only way
    // OUT of 'ready' is an explicit backend failure (handled above) or a
    // deliberate user-triggered retry, which resets processingStatus away
    // from 'ready' itself before requesting a new snapshot.
    patch.processingStatus = 'ready';
  } else {
    patch.processingStatus = 'processing';
  }

  return patch;
}

/**
 * Real production incident (2026-09-24, lecture 9ca64d1f-…): a healthy backend
 * job took 6m14s and 5m33s to transcribe a 38-minute lecture — both longer
 * than the poller's old fixed budget (MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS,
 * 4 minutes at the time). The old poll loop turned "we've polled N times"
 * into `processingStatus: 'failed'` directly, which is wrong: elapsed client
 * polling time is not backend truth. The backend is the sole authority on
 * success/failure — see mergeProcessingSnapshot/resolveProcessingStatus above,
 * which this function defers to entirely for that decision.
 *
 * This is the single decision point for what a poll tick does with an
 * already-merged snapshot patch, given how many attempts have elapsed in this
 * poll session. It NEVER converts elapsed attempts into failure — only the
 * patch's own processingStatus (which came from real backend content) can
 * stop polling. Crossing `maxFastAttempts` only switches the poll cadence and
 * sets an informational `processingSlow` flag the UI can show ("taking longer
 * than usual") without implying failure. `processingSlow` is always cleared
 * the moment a real ready/failed resolution lands.
 *
 * A poll tick that could not even reach the backend (network/fetch failure)
 * is a DIFFERENT, unmerged case — see unreachablePollTickPatch below, used by
 * the caller's catch branch instead of this function.
 *
 * @param {object} patch - the result of mergeProcessingSnapshot(reference, remote)
 * @param {number} attempts - 1-based tick count for this poll session
 * @param {number} maxFastAttempts - attempts before switching to slow cadence
 * @returns {{ patch: object, action: 'stop'|'poll', slow: boolean }}
 */
export function resolvePollTick(patch, attempts, maxFastAttempts) {
  const slow = attempts >= maxFastAttempts;
  const stillProcessing = patch.processingStatus === 'processing';
  const nextPatch = { ...patch, processingSlow: stillProcessing ? slow : false };
  const resolved = patch.processingStatus === 'ready' || patch.processingStatus === 'failed';
  return { patch: nextPatch, action: resolved ? 'stop' : 'poll', slow };
}

/**
 * The patch for a tick that could not reach the backend at all (a thrown
 * fetch/network error) — status is unknown for this tick, not failed. Reuses
 * the exact same informational signal resolvePollTick sets past the fast
 * window, since the UI treats both identically: keep showing "processing",
 * just note it may be taking a while.
 *
 * @returns {{ processingSlow: true }}
 */
export function unreachablePollTickPatch() {
  return { processingSlow: true };
}
