/**
 * Pure helpers for post-lecture Transcript editing.
 * One side (source | translated) updates only that side's fields + zh legacy mirror.
 */
import {
  getSourceTranscript,
  getTranslatedTranscript,
  resolveLectureLanguagePair,
  shouldTranslate,
} from './contentLanguages.mjs';

/** @typedef {'source' | 'translated'} TranscriptEditSide */

/**
 * Raw editable text for a transcript side (preserves intentional empty strings).
 * @param {object} lecture
 * @param {TranscriptEditSide} side
 */
export function getEditableTranscriptText(lecture, side) {
  if (side === 'source') {
    if (typeof lecture?.transcript === 'string') return lecture.transcript;
    return getSourceTranscript(lecture) ?? '';
  }
  if (typeof lecture?.translatedTranscript === 'string') return lecture.translatedTranscript;
  return getTranslatedTranscript(lecture) ?? '';
}

/**
 * Build an isolated Partial<Lecture> patch for one transcript side.
 *
 * @param {object} lecture
 * @param {TranscriptEditSide} side
 * @param {string} text
 * @param {string} [nowIso]
 */
export function buildTranscriptEditPatch(lecture, side, text, nowIso = new Date().toISOString()) {
  const value = typeof text === 'string' ? text : '';
  const isEmpty = value.trim().length === 0;
  const stored = isEmpty ? '' : value;
  const { translationLanguage } = resolveLectureLanguagePair(lecture ?? {});

  /** @type {Record<string, string>} */
  const patch = { transcriptUpdatedAt: nowIso };

  if (side === 'source') {
    patch.transcript = stored;
  } else {
    patch.translatedTranscript = stored;
    if (translationLanguage === 'zh-Hans') {
      patch.transcriptZh = stored;
    }
  }

  return patch;
}

/**
 * @param {object} lecture
 * @param {TranscriptEditSide} side
 * @param {string} draft
 */
export function isTranscriptDraftDirty(lecture, side, draft) {
  const current = getEditableTranscriptText(lecture, side);
  return (typeof draft === 'string' ? draft : '') !== current;
}

/** @param {object} lecture */
export function hasUserEditedTranscript(lecture) {
  return Boolean(lecture?.transcriptUpdatedAt);
}

/**
 * @param {string|undefined|null} localUpdatedAt
 * @param {string|undefined|null} remoteUpdatedAt
 */
export function preferLocalTranscriptAfterUserEdit(localUpdatedAt, remoteUpdatedAt) {
  return Boolean(localUpdatedAt) && (!remoteUpdatedAt || localUpdatedAt > remoteUpdatedAt);
}

/**
 * Whether the translated transcript card should be editable for this lecture.
 * @param {object} lecture
 */
export function lectureHasTranslatedTranscriptSide(lecture) {
  const { sourceLanguage, translationLanguage } = resolveLectureLanguagePair(lecture ?? {});
  return shouldTranslate(sourceLanguage, translationLanguage);
}
