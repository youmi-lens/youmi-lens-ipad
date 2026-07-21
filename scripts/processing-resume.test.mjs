import assert from 'node:assert/strict';

import {
  isCommittedLecture,
  nextProcessingAction,
  mergeProcessingSnapshot,
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

console.log('Processing resume/orchestration tests passed.');
