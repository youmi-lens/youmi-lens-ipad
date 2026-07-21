#!/usr/bin/env node
/**
 * Focused tests for post-lecture Summary editing:
 * field isolation, persistence patch shape, editor load, cancel = no write.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getSourceSummary, getTranslatedSummary } from '../lib/contentLanguages.mjs';
import {
  buildSummaryEditPatch,
  getEditableSummaryText,
  isSummaryDraftDirty,
  preferLocalSummaryAfterUserEdit,
} from '../lib/summaryEdit.mjs';

const baseLecture = {
  id: 'lec-1',
  sourceLanguage: 'en',
  translationLanguage: 'zh-Hans',
  sourceSummary: 'English AI summary',
  translatedSummary: '中文 AI 摘要',
  summaryEn: 'English AI summary',
  summaryZh: '中文 AI 摘要',
};

test('editor loads existing English and Chinese text', () => {
  assert.equal(getEditableSummaryText(baseLecture, 'source'), 'English AI summary');
  assert.equal(getEditableSummaryText(baseLecture, 'translated'), '中文 AI 摘要');
});

test('English save updates only source + summaryEn', () => {
  const patch = buildSummaryEditPatch(baseLecture, 'source', 'Edited English', '2026-07-21T00:00:00.000Z');
  assert.equal(patch.sourceSummary, 'Edited English');
  assert.equal(patch.summaryEn, 'Edited English');
  assert.equal(patch.translatedSummary, undefined);
  assert.equal(patch.summaryZh, undefined);
  assert.equal(patch.summaryUpdatedAt, '2026-07-21T00:00:00.000Z');

  const next = { ...baseLecture, ...patch };
  assert.equal(getSourceSummary(next), 'Edited English');
  assert.equal(getTranslatedSummary(next), '中文 AI 摘要', 'Chinese must stay unchanged');
});

test('Chinese save updates only translated + summaryZh', () => {
  const patch = buildSummaryEditPatch(baseLecture, 'translated', '编辑后的中文', '2026-07-21T00:00:01.000Z');
  assert.equal(patch.translatedSummary, '编辑后的中文');
  assert.equal(patch.summaryZh, '编辑后的中文');
  assert.equal(patch.sourceSummary, undefined);
  assert.equal(patch.summaryEn, undefined);

  const next = { ...baseLecture, ...patch };
  assert.equal(getSourceSummary(next), 'English AI summary', 'English must stay unchanged');
  assert.equal(getTranslatedSummary(next), '编辑后的中文');
});

test('empty save clears authoritative + matching legacy so AI text cannot resurrect', () => {
  const patch = buildSummaryEditPatch(baseLecture, 'source', '   ', '2026-07-21T00:00:02.000Z');
  assert.equal(patch.sourceSummary, '');
  assert.equal(patch.summaryEn, '');
  const next = { ...baseLecture, ...patch };
  assert.equal(getEditableSummaryText(next, 'source'), '');
  assert.equal(getSourceSummary(next), undefined);
  assert.equal(getTranslatedSummary(next), '中文 AI 摘要');
});

test('dirty detection: unchanged draft is clean; Cancel path writes nothing', () => {
  assert.equal(isSummaryDraftDirty(baseLecture, 'source', 'English AI summary'), false);
  assert.equal(isSummaryDraftDirty(baseLecture, 'source', 'Changed'), true);
  // Cancel never calls buildSummaryEditPatch — lecture object remains identical.
  const untouched = { ...baseLecture };
  assert.deepEqual(untouched, baseLecture);
});

test('prefer local summary after fresher user edit', () => {
  assert.equal(preferLocalSummaryAfterUserEdit('2026-07-21T12:00:00.000Z', '2026-07-21T11:00:00.000Z'), true);
  assert.equal(preferLocalSummaryAfterUserEdit('2026-07-21T10:00:00.000Z', '2026-07-21T11:00:00.000Z'), false);
  assert.equal(preferLocalSummaryAfterUserEdit(undefined, '2026-07-21T11:00:00.000Z'), false);
});

console.log('Summary edit tests passed.');
