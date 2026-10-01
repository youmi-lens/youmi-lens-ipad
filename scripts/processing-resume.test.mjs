import assert from 'node:assert/strict';

import {
  isCommittedLecture,
  isLectureComplete,
  nextProcessingAction,
  mergeProcessingSnapshot,
  resolvePollTick,
} from '../lib/processingResume.mjs';

// A committed lecture that has finished recording and has a remote key + audio.
const committed = {
  status: 'local_recorded',
  remoteRecordingId: 'rec-1',
  localAudioUri: 'file:///a.m4a',
};

// ---- isCommittedLecture ----
assert.equal(isCommittedLecture({ ...committed }), true);
assert.equal(isCommittedLecture({ ...committed, status: 'in_progress' }), false, 'live draft is not committed');
assert.equal(isCommittedLecture({ ...committed, deletedAt: '2026-01-01' }), false, 'soft-deleted is not committed');
assert.equal(isCommittedLecture(undefined), false);

// ---- nextProcessingAction: a pending job persists regardless of any screen ----
// Fresh finish → needs upload.
assert.equal(
  nextProcessingAction({ ...committed, uploadStatus: 'not_uploaded', processingStatus: 'not_started' }),
  'upload',
);
// Defaults (no explicit statuses) → still needs upload.
assert.equal(nextProcessingAction({ ...committed }), 'upload');
// App killed mid-upload → stale 'uploading' is resumable.
assert.equal(nextProcessingAction({ ...committed, uploadStatus: 'uploading' }), 'upload', 'stale uploading resumes');
// Uploaded but AI never triggered (the primary stuck bug) → trigger processing.
assert.equal(
  nextProcessingAction({ ...committed, uploadStatus: 'uploaded', processingStatus: 'not_started' }),
  'start_processing',
);
// AI running server-side → poll until done.
assert.equal(
  nextProcessingAction({ ...committed, uploadStatus: 'uploaded', processingStatus: 'processing' }),
  'poll',
);

// ---- nextProcessingAction: never create duplicate / redundant work ----
// Already ready → nothing to do (no duplicate processing job).
assert.equal(
  nextProcessingAction({ ...committed, uploadStatus: 'uploaded', processingStatus: 'ready' }),
  'none',
);
// Terminal failures wait for the manual Retry button — no auto-loop.
assert.equal(nextProcessingAction({ ...committed, uploadStatus: 'upload_failed' }), 'none', 'upload_failed is manual');
assert.equal(
  nextProcessingAction({ ...committed, uploadStatus: 'uploaded', processingStatus: 'failed' }),
  'none',
  'processing failed is manual',
);
// A live draft is never processed.
assert.equal(nextProcessingAction({ ...committed, status: 'in_progress' }), 'none');
// Soft-deleted lecture is never processed.
assert.equal(
  nextProcessingAction({ ...committed, uploadStatus: 'uploaded', processingStatus: 'not_started', deletedAt: 'x' }),
  'none',
);
// No stable remote key → cannot act safely (would risk duplicate remote rows).
assert.equal(nextProcessingAction({ status: 'local_recorded', localAudioUri: 'file://a', uploadStatus: 'not_uploaded' }), 'none');
// Nothing to upload (no local audio, not uploaded) → unrecoverable, don't loop.
assert.equal(
  nextProcessingAction({ ...committed, localAudioUri: null, uploadStatus: 'not_uploaded' }),
  'none',
);

// ---- mergeProcessingSnapshot: durable, non-destructive status merge ----
// Backend done with full data → ready, content copied in.
const done = mergeProcessingSnapshot(
  {},
  { transcript: 'T', transcript_zh: 'Z', summary_en: 'E', summary_zh: 'S', ai_status: 'done' },
);
assert.equal(done.processingStatus, 'ready');
assert.equal(done.transcript, 'T');
assert.equal(done.summaryEn, 'E');
assert.equal(done.summaryZh, 'S');
assert.equal(done.transcriptZh, 'Z');

// A multilingual `done` snapshot without the complete generic pair is a race,
// not readiness. Keep polling until the authoritative fields arrive.
const frenchChineseRace = mergeProcessingSnapshot(
  {},
  {
    source_language: 'fr', translation_language: 'zh-Hans',
    transcript: 'FR transcript', translated_transcript: '中文转录',
    summary_zh: '中文摘要', source_summary: null, translated_summary: null,
    ai_status: 'done',
  },
);
assert.equal(frenchChineseRace.processingStatus, 'processing');

const frenchChineseComplete = mergeProcessingSnapshot(
  {},
  {
    source_language: 'fr', translation_language: 'zh-Hans',
    transcript: 'FR transcript', translated_transcript: '中文转录',
    source_summary: 'Résumé français', translated_summary: '中文摘要',
    ai_status: 'done',
  },
);
assert.equal(frenchChineseComplete.processingStatus, 'ready');
assert.equal(frenchChineseComplete.sourceSummary, 'Résumé français');
assert.equal(frenchChineseComplete.translatedSummary, '中文摘要');

const koreanOnlyComplete = mergeProcessingSnapshot(
  {},
  {
    source_language: 'ko', translation_language: 'ko',
    transcript: '한국어 전사', source_summary: '한국어 요약', translated_summary: null,
    ai_status: 'done',
  },
);
assert.equal(koreanOnlyComplete.processingStatus, 'ready', 'source == target needs only one content set');

// Backend failed → failed, error surfaced (not silently dropped).
const failed = mergeProcessingSnapshot({}, { ai_status: 'failed', ai_error: 'model error' });
assert.equal(failed.processingStatus, 'failed');
assert.equal(failed.processingError, 'model error');

// Empty/early poll must NOT overwrite existing content with blanks.
const early = mergeProcessingSnapshot(
  { transcript: 'OLD', summaryEn: 'OLD_E', summaryZh: 'OLD_S' },
  { ai_status: 'queued', transcript: null, transcript_zh: null, summary_en: null, summary_zh: null },
);
assert.equal(early.processingStatus, 'processing');
assert.equal('transcript' in early, false, 'empty remote transcript is not written');
assert.equal('summaryEn' in early, false, 'empty remote summary is not written');
assert.equal('summaryZh' in early, false);

// Transcript arrived but summaries still pending → stay processing, not ready.
const partial = mergeProcessingSnapshot(
  {},
  { transcript: 'NEW', ai_status: 'transcript_ready', summary_en: null, summary_zh: null },
);
assert.equal(partial.processingStatus, 'processing', 'not ready until data is actually available');
assert.equal(partial.transcript, 'NEW');
assert.equal('summaryEn' in partial, false);

// ai_status 'done' but no transcript anywhere → do not mark ready.
const doneButEmpty = mergeProcessingSnapshot({}, { ai_status: 'done', transcript: null });
assert.equal(doneButEmpty.processingStatus, 'processing', 'done without data does not mark ready');

// Manual Summary edit must not be overwritten by a later processing poll.
const afterUserEdit = mergeProcessingSnapshot(
  {
    summaryUpdatedAt: '2026-07-21T12:00:00.000Z',
    sourceSummary: 'User English',
    translatedSummary: '用户中文',
    summaryEn: 'User English',
    summaryZh: '用户中文',
  },
  {
    ai_status: 'done',
    transcript: 'T',
    summary_en: 'AI English',
    summary_zh: 'AI 中文',
    source_summary: 'AI English',
    translated_summary: 'AI 中文',
  },
);
assert.equal('summaryEn' in afterUserEdit, false, 'user English summary preserved');
assert.equal('summaryZh' in afterUserEdit, false, 'user Chinese summary preserved');
assert.equal('sourceSummary' in afterUserEdit, false);
assert.equal('translatedSummary' in afterUserEdit, false);

// Manual Transcript edit must not be overwritten by a later processing poll.
const afterTranscriptEdit = mergeProcessingSnapshot(
  {
    transcriptUpdatedAt: '2026-07-21T12:00:00.000Z',
    transcript: 'User EN transcript',
    translatedTranscript: '用户中文转录',
    transcriptZh: '用户中文转录',
  },
  {
    ai_status: 'done',
    transcript: 'AI EN transcript',
    transcript_zh: 'AI 中文转录',
    translated_transcript: 'AI 中文转录',
    summary_en: 'S',
  },
);
assert.equal('transcript' in afterTranscriptEdit, false, 'user English transcript preserved');
assert.equal('transcriptZh' in afterTranscriptEdit, false);
assert.equal('translatedTranscript' in afterTranscriptEdit, false);

// ---- WR112/WR2 production bug (Sep 4 2026): translated_live_transcript fallback ----
// Real production row: ai_status='done', translation_ready=true, translated_summary
// populated — but translated_transcript AND transcript_zh both null. The actual
// translated transcript lived only in translated_live_transcript (12067 chars,
// captured live during recording). Before the fix this permanently computed
// 'processing' despite the backend being genuinely, fully done.
const wr2Snapshot = {
  source_language: 'en',
  translation_language: 'zh-Hans',
  transcript: 'So today what I want you to do is...',
  transcript_zh: null,
  translated_transcript: null,
  translated_live_transcript: '今天我想让你做的是...',
  source_summary: 'A short summary of the lecture.',
  translated_summary: '讲座的简短摘要。',
  ai_status: 'done',
};
const wr2 = mergeProcessingSnapshot({}, wr2Snapshot);
assert.equal(wr2.processingStatus, 'ready', 'translated_live_transcript must count as valid translated content when translated_transcript/transcript_zh are both absent');

// The fallback is exercised only when the dedicated columns are truly empty —
// a dedicated translated_transcript/transcript_zh value still wins outright.
const dedicatedColumnStillWins = mergeProcessingSnapshot(
  {},
  { ...wr2Snapshot, transcript_zh: '专用列的翻译', translated_live_transcript: 'stale live capture' },
);
assert.equal(dedicatedColumnStillWins.processingStatus, 'ready');

// The intentional race guard (frenchChineseRace, above) must still hold when
// NONE of the three sources — translated_transcript, transcript_zh, or
// translated_live_transcript — have landed yet.
const genuineRaceStillBlocked = mergeProcessingSnapshot(
  {},
  { ...wr2Snapshot, translated_live_transcript: null },
);
assert.equal(genuineRaceStillBlocked.processingStatus, 'processing', 'with no translated content anywhere, done is still just a race, not readiness');

// ---- No-speech empty success: ai_status 'done' is authoritative even with
// empty content (real production incidents, 2026-09-28: recordings
// 7885e218-2814-4284-bfe9-dbca471a33a8 and b1aee347-08be-4b45-b12f-3e3e7a0cd869) ----
// A genuine DashScope SUCCESS_WITH_NO_VALID_FRAGMENT completion: the backend
// (server/processRecording.mjs's markDoneEmptyNoSpeech) writes transcript as
// an explicit empty STRING, atomically with ai_status/summary fields. Before
// this fix, mergeProcessingSnapshot's content-based hasCompleteLanguagePair
// gate could never be satisfied by empty content, so the poll loop never
// reached a terminal state — the exact "infinite Waiting for Processing
// updates" / Ready↔Processing flicker the physical test exposed (store.tsx's
// separate, unconditional processingStatusFromRemote() correctly computed
// 'ready' from ai_status alone, so the two paths disagreed and fought over
// the same stored field — see scripts/processing-status-no-speech-ready
// .test.mjs for the full mechanism proof).
const noSpeechReady = mergeProcessingSnapshot(
  {},
  { ai_status: 'done', transcript: '', summary_en: '', summary_zh: '', source_summary: '', translated_summary: null },
);
assert.equal(noSpeechReady.processingStatus, 'ready', 'ai_status done + transcript "" (no-speech) must be ready immediately, not processing');

// Must be reachable from an in-progress lecture too, not just a blank reference.
const noSpeechReadyFromProcessing = mergeProcessingSnapshot(
  { processingStatus: 'processing' },
  { ai_status: 'done', transcript: '' },
);
assert.equal(noSpeechReadyFromProcessing.processingStatus, 'ready');

// The poll loop must actually STOP on this snapshot — this is what makes
// "Waiting for Processing updates" disappear instead of spinning forever.
const noSpeechPollResult = resolvePollTick(noSpeechReady, 1, 80);
assert.equal(noSpeechPollResult.action, 'stop', 'the poll loop must stop on a no-speech ready snapshot, not keep polling indefinitely');

// A merely-missing (null/undefined) transcript is NOT the same signal and must
// NOT be treated as no-speech-ready — only an explicit empty STRING (the
// literal value markDoneEmptyNoSpeech writes) qualifies. This is exactly the
// pre-existing `doneButEmpty` guard above (transcript: null stays
// 'processing') — restated here to make the null-vs-empty-string distinction
// this fix depends on explicit and directly regression-tested.
const doneWithNullTranscriptStillProcessing = mergeProcessingSnapshot({}, { ai_status: 'done', transcript: null });
assert.equal(doneWithNullTranscriptStillProcessing.processingStatus, 'processing', 'transcript: null (missing) must not be confused with transcript: "" (no-speech)');
const doneWithUndefinedTranscriptStillProcessing = mergeProcessingSnapshot({}, { ai_status: 'done' });
assert.equal(doneWithUndefinedTranscriptStillProcessing.processingStatus, 'processing', 'transcript: undefined (absent field) must not be confused with transcript: "" (no-speech)');

// The existing multi-stage race guards (WR112/WR2, French/Chinese) must be
// completely unaffected — they all have REAL, non-empty transcript content,
// so the new transcript === '' branch never fires for them; they still fall
// through to the unchanged hasCompleteLanguagePair check below.
assert.equal(frenchChineseRace.processingStatus, 'processing', 'regression: the no-speech branch must not affect the real French/Chinese race guard');
assert.equal(genuineRaceStillBlocked.processingStatus, 'processing', 'regression: the no-speech branch must not affect the real WR112/WR2 race guard');

// ---- Terminal-state monotonicity: READY must never regress to PROCESSING ----
// A lecture already marked 'ready' locally must stay 'ready' even if a fresh
// snapshot happens to look incomplete this pass (a stale/partial poll
// response, a field temporarily missing) — the only ways out of 'ready' are
// an authoritative backend failure, or a user-triggered retry that resets
// processingStatus itself before requesting a new snapshot.
const readyStaysReadyOnStaleSnapshot = mergeProcessingSnapshot(
  { processingStatus: 'ready' },
  { ai_status: 'processing', transcript: null, summary_en: null },
);
assert.equal(readyStaysReadyOnStaleSnapshot.processingStatus, 'ready', 'a stale/incomplete snapshot must not regress an already-ready lecture');

const readyStaysReadyOnIncompleteDoneSnapshot = mergeProcessingSnapshot(
  { processingStatus: 'ready' },
  { ai_status: 'done', source_language: 'en', translation_language: 'zh-Hans', transcript: 'x', source_summary: 's' /* translated fields missing this pass */ },
);
assert.equal(readyStaysReadyOnIncompleteDoneSnapshot.processingStatus, 'ready');

// An authoritative backend failure still surfaces even over an already-ready lecture.
const readyCanStillReportABackendFailure = mergeProcessingSnapshot(
  { processingStatus: 'ready' },
  { ai_status: 'failed', ai_error: 'reprocess failed' },
);
assert.equal(readyCanStillReportABackendFailure.processingStatus, 'failed', 'a genuine backend failure must still be reportable, not masked by the monotonicity guard');

// A lecture NOT already ready (e.g. reset by an intentional retry, which sets
// processingStatus to 'not_started' before the next snapshot is requested)
// is completely unaffected by the monotonicity guard — normal derivation proceeds.
const retryResetLectureDerivesNormally = mergeProcessingSnapshot(
  { processingStatus: 'not_started' },
  { ai_status: 'queued' },
);
assert.equal(retryResetLectureDerivesNormally.processingStatus, 'processing');

// ---- isLectureComplete: the single canonical routing/gating predicate ----
// CASE 9 / CASE 15: only 'ready' is complete — never merely uploaded, never
// merely a live draft, never a terminal failure.
assert.equal(isLectureComplete({ processingStatus: 'ready' }), true);
assert.equal(isLectureComplete({ processingStatus: 'processing' }), false);
assert.equal(isLectureComplete({ processingStatus: 'not_started' }), false);
assert.equal(isLectureComplete({ processingStatus: 'failed' }), false);
assert.equal(isLectureComplete(undefined), false);
assert.equal(isLectureComplete(null), false);

console.log('Processing resume/orchestration tests passed.');
