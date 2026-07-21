#!/usr/bin/env node
/**
 * Focused tests for post-lecture Transcript editing (mirrors Summary edit contract).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getSourceTranscript, getTranslatedTranscript } from '../lib/contentLanguages.mjs';
import { getSourceSummary, getTranslatedSummary } from '../lib/contentLanguages.mjs';
import {
  buildTranscriptEditPatch,
  getEditableTranscriptText,
  isTranscriptDraftDirty,
  preferLocalTranscriptAfterUserEdit,
} from '../lib/transcriptEdit.mjs';

const baseLecture = {
  id: 'lec-1',
  sourceLanguage: 'en',
  translationLanguage: 'zh-Hans',
  transcript: 'English transcript body',
  translatedTranscript: '中文转录正文',
  transcriptZh: '中文转录正文',
  sourceSummary: 'English AI summary',
  translatedSummary: '中文 AI 摘要',
  summaryEn: 'English AI summary',
  summaryZh: '中文 AI 摘要',
};

test('editor loads existing English and Chinese transcripts', () => {
  assert.equal(getEditableTranscriptText(baseLecture, 'source'), 'English transcript body');
  assert.equal(getEditableTranscriptText(baseLecture, 'translated'), '中文转录正文');
});

test('English transcript save updates only transcript', () => {
  const patch = buildTranscriptEditPatch(baseLecture, 'source', 'Edited EN transcript', '2026-07-21T00:00:00.000Z');
  assert.equal(patch.transcript, 'Edited EN transcript');
  assert.equal(patch.translatedTranscript, undefined);
  assert.equal(patch.transcriptZh, undefined);
  assert.equal(patch.transcriptUpdatedAt, '2026-07-21T00:00:00.000Z');

  const next = { ...baseLecture, ...patch };
  assert.equal(getSourceTranscript(next), 'Edited EN transcript');
  assert.equal(getTranslatedTranscript(next), '中文转录正文');
  assert.equal(getSourceSummary(next), 'English AI summary', 'Summary must stay unchanged');
  assert.equal(getTranslatedSummary(next), '中文 AI 摘要');
});

test('Chinese transcript save updates translated + transcriptZh only', () => {
  const patch = buildTranscriptEditPatch(baseLecture, 'translated', '编辑后的中文转录', '2026-07-21T00:00:01.000Z');
  assert.equal(patch.translatedTranscript, '编辑后的中文转录');
  assert.equal(patch.transcriptZh, '编辑后的中文转录');
  assert.equal(patch.transcript, undefined);

  const next = { ...baseLecture, ...patch };
  assert.equal(getSourceTranscript(next), 'English transcript body');
  assert.equal(getTranslatedTranscript(next), '编辑后的中文转录');
});

test('empty save clears transcript so AI text cannot resurrect via getters', () => {
  const patch = buildTranscriptEditPatch(baseLecture, 'source', '   ', '2026-07-21T00:00:02.000Z');
  assert.equal(patch.transcript, '');
  const next = { ...baseLecture, ...patch };
  assert.equal(getEditableTranscriptText(next, 'source'), '');
  assert.equal(getSourceTranscript(next), undefined);
});

test('dirty detection and Cancel writes nothing', () => {
  assert.equal(isTranscriptDraftDirty(baseLecture, 'source', 'English transcript body'), false);
  assert.equal(isTranscriptDraftDirty(baseLecture, 'source', 'Changed'), true);
  assert.deepEqual({ ...baseLecture }, baseLecture);
});

test('prefer local transcript after fresher user edit', () => {
  assert.equal(preferLocalTranscriptAfterUserEdit('2026-07-21T12:00:00.000Z', '2026-07-21T11:00:00.000Z'), true);
  assert.equal(preferLocalTranscriptAfterUserEdit(undefined, '2026-07-21T11:00:00.000Z'), false);
});

console.log('Transcript edit tests passed.');
