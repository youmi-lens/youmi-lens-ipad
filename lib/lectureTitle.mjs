/**
 * Lecture title authority — the single place that decides whether a title is
 * real user content or a placeholder our own code invented.
 *
 * WHY THIS EXISTS
 * ---------------
 * A production incident left many `recordings` rows named "Untitled Lecture".
 * The cloud merge in lib/store.tsx used to resolve titles like this:
 *
 *     finalTitle = preferLocalTitle ? localTitle : (remoteTitle || localTitle)
 *
 * `remoteTitle` was only tested for emptiness, so the *string* "Untitled
 * Lecture" — which is truthy — won over a perfectly good local title whenever
 * `preferLocalTitle` was false. That happened in two very ordinary cases:
 *
 *   1. The lecture was never renamed on this device, so it carries no
 *      `titleUpdatedAt` at all (titled at record time, or renamed on another
 *      device). `preferLocalTitle` requires that stamp, so it was false.
 *   2. Any unrelated remote write — a transcript landing, a summary finishing,
 *      an ai_status change — bumped `recordings.updated_at` past the local
 *      rename stamp, which also flipped `preferLocalTitle` to false.
 *
 * The fix is to stop treating "is this string non-empty" as "is this string a
 * real title". A *valid* title must never lose to a *fallback* one, whatever
 * the timestamps say.
 *
 * WHAT COUNTS AS A FALLBACK
 * -------------------------
 * Only the exact placeholder strings our own writers emit, matched after
 * trimming and case-folding:
 *
 *   "Untitled Lecture"  app/recording.tsx, lib/store.tsx  (client)
 *   "Lecture"           server/uploadAudio.mjs cleanText  (backend default)
 *
 * These are stored verbatim in English and never translated at write time (see
 * lib/systemDefaultTitles.mjs — the stored string doubles as a sync identity
 * key, so localizing it would fork sync groups per language). Localization
 * happens only at render time, which is why this set needs no localized
 * variants: a localized fallback is never persisted.
 *
 * Matching is exact, not substring. "Untitled Lecture 3", "Lecture 7" and
 * "Untitled thoughts on Kant" are all genuine user titles and stay protected.
 */

/** The placeholder written when a recording finishes with no typed title. */
export const DEFAULT_LECTURE_TITLE = 'Untitled Lecture';

/**
 * Exact stored placeholders, case-folded. Anything not in this set — including
 * a short title, or a longer title that merely *contains* one of these words —
 * is treated as real user content.
 */
const FALLBACK_LECTURE_TITLES = new Set(['untitled lecture', 'lecture']);

/**
 * True when `title` carries no user intent and may be safely replaced.
 *
 * Covers undefined, null, non-strings, empty and whitespace-only strings, and
 * the exact system placeholders above.
 *
 * @param {unknown} title
 * @returns {boolean}
 */
export function isFallbackLectureTitle(title) {
  if (typeof title !== 'string') return true;
  const trimmed = title.trim();
  if (!trimmed) return true;
  return FALLBACK_LECTURE_TITLES.has(trimmed.toLowerCase());
}

/** Convenience inverse — a title that represents real user intent. */
export function isValidLectureTitle(title) {
  return !isFallbackLectureTitle(title);
}

/**
 * Decide the surviving title when a remote `recordings` row meets the local
 * copy of the same lecture.
 *
 * Precedence, highest first:
 *
 *   1. VALID beats FALLBACK, unconditionally. Timestamps are not consulted —
 *      this is the invariant that makes the "Untitled Lecture" regression
 *      impossible in either direction.
 *   2. Both FALLBACK — nothing to protect. Keep whichever placeholder we have
 *      so the row still renders, preferring remote for cross-device stability.
 *   3. Both VALID — a real rename race. Title-specific authority decides:
 *      an explicit `titleUpdatedAt` on either side is compared when both are
 *      present; otherwise a local rename that is newer than the remote row's
 *      `updatedAt` is assumed not to have finished pushing yet and is kept.
 *
 * KNOWN LIMITATION (valid-vs-valid only, deliberately not fixed here):
 * `recordings` has no `title_updated_at` column today, so `remoteTitleUpdatedAt`
 * is always undefined in production and case 3 must fall back to the row-level
 * `updatedAt`. An unrelated remote write that lands between a local rename and
 * its push can therefore still win a valid-vs-valid contest. Closing that needs
 * a schema migration plus a coordinated client/backend deploy; it is tracked as
 * follow-up. It cannot resurrect a fallback title — rule 1 outranks it — so the
 * reported corruption stays fixed regardless.
 *
 * @param {object} input
 * @param {unknown} input.localTitle
 * @param {string|null|undefined} [input.localTitleUpdatedAt]
 * @param {unknown} input.remoteTitle
 * @param {string|null|undefined} [input.remoteTitleUpdatedAt] forward-compatible;
 *   always undefined until `recordings.title_updated_at` exists.
 * @param {string|null|undefined} [input.remoteUpdatedAt] row-level `updated_at`.
 * @returns {{ title: string, titleUpdatedAt: string|undefined, source: 'local'|'remote'|'fallback' }}
 */
export function resolveMergedLectureTitle({
  localTitle,
  localTitleUpdatedAt: rawLocalStamp,
  remoteTitle,
  remoteTitleUpdatedAt: rawRemoteStamp,
  remoteUpdatedAt,
} = {}) {
  // Normalize null → undefined so callers always get `string | undefined` back
  // and can assign the result straight onto a Lecture.
  const localTitleUpdatedAt = rawLocalStamp ?? undefined;
  const remoteTitleUpdatedAt = rawRemoteStamp ?? undefined;
  const localTrim = typeof localTitle === 'string' ? localTitle.trim() : '';
  const remoteTrim = typeof remoteTitle === 'string' ? remoteTitle.trim() : '';
  const localValid = isValidLectureTitle(localTrim);
  const remoteValid = isValidLectureTitle(remoteTrim);

  // 1. A real title never loses to a placeholder, in either direction.
  if (localValid && !remoteValid) {
    return { title: localTrim, titleUpdatedAt: localTitleUpdatedAt, source: 'local' };
  }
  if (remoteValid && !localValid) {
    return {
      title: remoteTrim,
      titleUpdatedAt: remoteTitleUpdatedAt ?? localTitleUpdatedAt,
      source: 'remote',
    };
  }

  // 2. Nothing worth protecting on either side.
  if (!localValid && !remoteValid) {
    return {
      title: remoteTrim || localTrim || DEFAULT_LECTURE_TITLE,
      titleUpdatedAt: localTitleUpdatedAt,
      source: 'fallback',
    };
  }

  // 3. Both valid — a genuine rename race.
  if (localTitleUpdatedAt && remoteTitleUpdatedAt) {
    return localTitleUpdatedAt > remoteTitleUpdatedAt
      ? { title: localTrim, titleUpdatedAt: localTitleUpdatedAt, source: 'local' }
      : { title: remoteTrim, titleUpdatedAt: remoteTitleUpdatedAt, source: 'remote' };
  }

  // A local rename with no remote counterpart stamp: keep it while it is newer
  // than the row itself, i.e. while the push plausibly has not landed yet.
  const localRenamePending =
    Boolean(localTitleUpdatedAt) && (!remoteUpdatedAt || localTitleUpdatedAt > remoteUpdatedAt);
  if (localRenamePending) {
    return { title: localTrim, titleUpdatedAt: localTitleUpdatedAt, source: 'local' };
  }

  return {
    title: remoteTrim,
    titleUpdatedAt: remoteTitleUpdatedAt ?? localTitleUpdatedAt,
    source: 'remote',
  };
}
