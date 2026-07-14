import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getSummarySectionLabel,
  getTranscriptSectionLabel,
  getSourceSummary,
  getTranslatedSummary,
  getSourceTranscript,
  getTranslatedTranscript,
} from '../lib/contentLanguages.mjs';

test('section labels derive per content language (all six)', () => {
  const expected = {
    en: ['ENGLISH SUMMARY', 'ENGLISH TRANSCRIPT'],
    'zh-Hans': ['中文摘要', '中文转录'],
    ja: ['JAPANESE SUMMARY', 'JAPANESE TRANSCRIPT'],
    fr: ['FRENCH SUMMARY', 'FRENCH TRANSCRIPT'],
    es: ['SPANISH SUMMARY', 'SPANISH TRANSCRIPT'],
    ko: ['KOREAN SUMMARY', 'KOREAN TRANSCRIPT'],
  };
  for (const [lang, [summary, transcript]] of Object.entries(expected)) {
    assert.equal(getSummarySectionLabel(lang), summary, `summary label ${lang}`);
    assert.equal(getTranscriptSectionLabel(lang), transcript, `transcript label ${lang}`);
  }
});

test('ja -> en: generic source/translated summary + transcript', () => {
  const lec = {
    sourceLanguage: 'ja', translationLanguage: 'en',
    transcript: 'JA transcript', translatedTranscript: 'EN transcript',
    sourceSummary: 'JA summary', translatedSummary: 'EN summary',
  };
  assert.equal(getSourceSummary(lec), 'JA summary');
  assert.equal(getTranslatedSummary(lec), 'EN summary');
  assert.equal(getSourceTranscript(lec), 'JA transcript');
  assert.equal(getTranslatedTranscript(lec), 'EN transcript');
});

test('fr -> es: generic only (no legacy leakage)', () => {
  const lec = {
    sourceLanguage: 'fr', translationLanguage: 'es',
    transcript: 'FR', translatedTranscript: 'ES',
    sourceSummary: 'FR summary', translatedSummary: 'ES summary',
    summaryEn: null, summaryZh: null,
  };
  assert.equal(getSourceSummary(lec), 'FR summary');
  assert.equal(getTranslatedSummary(lec), 'ES summary');
});

test('ko -> ko: single summary, translated hidden (undefined)', () => {
  const lec = { sourceLanguage: 'ko', translationLanguage: 'ko', transcript: 'KO', sourceSummary: 'KO summary' };
  assert.equal(getSourceSummary(lec), 'KO summary');
  assert.equal(getTranslatedSummary(lec), undefined, 'no translated summary when source == target');
  assert.equal(getTranslatedTranscript(lec), undefined, 'no translated transcript when source == target');
});

test('legacy lecture (no generic fields, en->zh) falls back by language', () => {
  const lec = {
    // no sourceLanguage/translationLanguage -> defaults en / zh-Hans
    transcript: 'English transcript', transcriptZh: '中文转录内容',
    summaryEn: 'English summary', summaryZh: '中文摘要内容',
  };
  assert.equal(getSourceSummary(lec), 'English summary', 'source falls back to summaryEn');
  assert.equal(getTranslatedSummary(lec), '中文摘要内容', 'translated falls back to summaryZh');
  assert.equal(getSourceTranscript(lec), 'English transcript');
  assert.equal(getTranslatedTranscript(lec), '中文转录内容', 'zh-Hans target falls back to transcriptZh');
});

test('generic authoritative over legacy when both present', () => {
  const lec = {
    sourceLanguage: 'en', translationLanguage: 'zh-Hans',
    sourceSummary: 'GENERIC EN', translatedSummary: 'GENERIC ZH',
    summaryEn: 'LEGACY EN', summaryZh: 'LEGACY ZH',
  };
  assert.equal(getSourceSummary(lec), 'GENERIC EN');
  assert.equal(getTranslatedSummary(lec), 'GENERIC ZH');
});

test('non-zh translated transcript does not fall back to transcriptZh', () => {
  const lec = { sourceLanguage: 'ja', translationLanguage: 'en', transcript: 'JA', transcriptZh: 'should-not-use' };
  assert.equal(getTranslatedTranscript(lec), undefined);
});

console.log('# lecture content tests passed');
