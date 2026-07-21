/**
 * Pure helpers for post-lecture Summary editing.
 * One side (source | translated) updates only that side's fields + matching legacy mirror.
 */
import {
  getSourceSummary,
  getTranslatedSummary,
  resolveLectureLanguagePair,
} from './contentLanguages.mjs';

/** @typedef {'source' | 'translated'} SummaryEditSide */

/**
 * Raw editable text for a summary side (preserves intentional empty strings).
 * @param {object} lecture
 * @param {SummaryEditSide} side
 */
export function getEditableSummaryText(lecture, side) {
  if (side === 'source') {
    if (typeof lecture?.sourceSummary === 'string') return lecture.sourceSummary;
    return getSourceSummary(lecture) ?? '';
  }
  if (typeof lecture?.translatedSummary === 'string') return lecture.translatedSummary;
  return getTranslatedSummary(lecture) ?? '';
}

/**
 * Build an isolated Partial<Lecture> patch for one summary side.
 * Clears the matching legacy column when the user saves an empty string so
 * getters cannot resurrect AI text from summaryEn/summaryZh.
 *
 * @param {object} lecture
 * @param {SummaryEditSide} side
 * @param {string} text
 * @param {string} [nowIso]
 */
export function buildSummaryEditPatch(lecture, side, text, nowIso = new Date().toISOString()) {
  const value = typeof text === 'string' ? text : '';
  const isEmpty = value.trim().length === 0;
  const stored = isEmpty ? '' : value;
  const { sourceLanguage, translationLanguage } = resolveLectureLanguagePair(lecture ?? {});
  const language = side === 'source' ? sourceLanguage : translationLanguage;

  /** @type {Record<string, string>} */
  const patch = { summaryUpdatedAt: nowIso };

  if (side === 'source') {
    patch.sourceSummary = stored;
  } else {
    patch.translatedSummary = stored;
  }

  if (language === 'en') {
    patch.summaryEn = stored;
  } else if (language === 'zh-Hans') {
    patch.summaryZh = stored;
  }

  return patch;
}

/**
 * Whether draft differs from the persisted editable summary for that side.
 * @param {object} lecture
 * @param {SummaryEditSide} side
 * @param {string} draft
 */
export function isSummaryDraftDirty(lecture, side, draft) {
  const current = getEditableSummaryText(lecture, side);
  return (typeof draft === 'string' ? draft : '') !== current;
}

/**
 * True when the user intentionally saved an empty summary (allow blank UI).
 * @param {object} lecture
 */
export function hasUserEditedSummary(lecture) {
  return Boolean(lecture?.summaryUpdatedAt);
}

/**
 * Prefer local summary fields after a user edit that is fresher than remote.
 * Mirrors titleUpdatedAt freshness used by cloud merge.
 *
 * @param {string|undefined|null} localUpdatedAt
 * @param {string|undefined|null} remoteUpdatedAt
 */
export function preferLocalSummaryAfterUserEdit(localUpdatedAt, remoteUpdatedAt) {
  return Boolean(localUpdatedAt) && (!remoteUpdatedAt || localUpdatedAt > remoteUpdatedAt);
}
