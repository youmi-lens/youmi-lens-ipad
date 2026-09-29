/**
 * Account-level deletion merge (Cloud Library Stage 2).
 *
 * Once `recordings` (and `courses`) carry `deleted_at` + `deletion_updated_at`,
 * deletion becomes shared state and a client merge must never resurrect a newer
 * decision. The freshness clock is `deletion_updated_at` — the moment the
 * deletion STATE last changed (a delete OR a restore stamps it). We compare that
 * clock, never row-existence, so:
 *
 *   - a stale ACTIVE snapshot cannot undo a newer DELETE
 *   - a stale DELETED cache cannot undo a newer RESTORE
 *   - hydration / foreground refresh / login are never Restore — only an
 *     explicit newer restore (a newer deletion_updated_at with deleted_at=null)
 *     brings something back
 *
 * `deletedAt` is the state (null = ACTIVE, timestamp = in Recently Deleted).
 * Permanent delete is a hard delete elsewhere (the row is gone), so it never
 * reaches this function.
 *
 * Pure and Node-testable; no React or Supabase here.
 */

/** Normalize a timestamp-ish value to a comparable ISO string or undefined. */
function stamp(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** True when a deletion state means "in Recently Deleted". */
export function isDeleted(deletedAt) {
  return typeof deletedAt === 'string' && deletedAt.trim().length > 0;
}

/**
 * Resolve the surviving deletion state for one record seen on two sides.
 *
 * @param {object} input
 * @param {string|null|undefined} input.localDeletedAt
 * @param {string|null|undefined} input.localDeletionUpdatedAt
 * @param {string|null|undefined} input.remoteDeletedAt
 * @param {string|null|undefined} input.remoteDeletionUpdatedAt
 * @returns {{ deletedAt: string|null, deletionUpdatedAt: string|undefined, source: 'local'|'remote' }}
 */
export function resolveDeletionState({
  localDeletedAt,
  localDeletionUpdatedAt,
  remoteDeletedAt,
  remoteDeletionUpdatedAt,
} = {}) {
  const localClock = stamp(localDeletionUpdatedAt);
  const remoteClock = stamp(remoteDeletionUpdatedAt);

  const localState = {
    deletedAt: isDeleted(localDeletedAt) ? localDeletedAt : null,
    deletionUpdatedAt: localClock,
    source: 'local',
  };
  const remoteState = {
    deletedAt: isDeleted(remoteDeletedAt) ? remoteDeletedAt : null,
    deletionUpdatedAt: remoteClock,
    source: 'remote',
  };

  // Both sides have an explicit clock → the newer decision wins (delete OR restore).
  if (localClock && remoteClock) {
    return localClock >= remoteClock ? localState : remoteState;
  }

  // Only one side made an explicit deletion decision → it wins over an
  // implicit/unversioned counterpart. This is what stops a stale ACTIVE
  // snapshot (no clock) from resurrecting a freshly DELETED record (has clock),
  // and vice-versa.
  if (localClock && !remoteClock) return localState;
  if (remoteClock && !localClock) return remoteState;

  // Neither side has a clock (legacy/unversioned). Fall back to a safe rule:
  // if either side is deleted, stay deleted — never resurrect on ambiguity.
  if (localState.deletedAt) return localState;
  if (remoteState.deletedAt) return remoteState;
  return localState; // both active, nothing to decide
}

/**
 * Stamp a fresh deletion decision (delete or restore) for optimistic local use.
 * @param {boolean} deleting true to delete, false to restore
 * @param {string} [now] ISO clock (injected for tests)
 */
export function applyDeletionDecision(deleting, now = new Date().toISOString()) {
  return { deletedAt: deleting ? now : null, deletionUpdatedAt: now };
}

/**
 * resolveDeletionState for a COURSE specifically — same ordering contract,
 * plus one narrow protection: a course's local cache can be stale not just
 * about ITS OWN deletion state (which resolveDeletionState already handles),
 * but stale in a way that let the user commit a brand-new lecture to it
 * *before* this device's cache learned the course was deleted server-side
 * (the app's deliberate stale-while-revalidate hydration window — courses
 * are shown live/interactive from the on-device cache before the cloud merge
 * that would correct them has run; see lib/store.tsx's hydration effect).
 *
 * If a local, non-deleted lecture is attached to this course and its
 * creation timestamp is NEWER than the remote deletion's own freshness clock
 * (`remoteDeletionUpdatedAt`), that lecture could only have been committed
 * AFTER the course was already deleted server-side — the shape is only
 * reachable via that stale-cache race, never via a lecture that legitimately
 * predates an intentional deletion. In that case the course is treated as
 * freshly reaffirmed active as of that lecture's timestamp, which
 * resolveDeletionState's own existing ordering rule then prefers over the
 * (necessarily older) remote tombstone — resolveDeletionState itself is
 * untouched.
 *
 * A lecture whose date predates the remote clock changes nothing: normal
 * cascade-hide-on-delete semantics apply exactly as before, and a course
 * with no qualifying lecture at all is untouched (delegates outright).
 *
 * @param {object} input
 * @param {string|null|undefined} input.localDeletedAt
 * @param {string|null|undefined} input.localDeletionUpdatedAt
 * @param {string|null|undefined} input.remoteDeletedAt
 * @param {string|null|undefined} input.remoteDeletionUpdatedAt
 * @param {string} input.courseId
 * @param {Array<{ courseId: string, date?: string, deletedAt?: string|null }>} input.localLectures
 * @returns {{ deletedAt: string|null, deletionUpdatedAt: string|undefined, source: 'local'|'remote' }}
 */
export function resolveCourseDeletionState({
  localDeletedAt,
  localDeletionUpdatedAt,
  remoteDeletedAt,
  remoteDeletionUpdatedAt,
  courseId,
  localLectures,
} = {}) {
  const remoteClock = stamp(remoteDeletionUpdatedAt);
  if (remoteClock && Array.isArray(localLectures)) {
    let newestQualifyingDate;
    for (const lecture of localLectures) {
      if (lecture?.courseId !== courseId) continue;
      if (isDeleted(lecture?.deletedAt)) continue;
      const date = stamp(lecture?.date);
      if (!date || date <= remoteClock) continue;
      if (!newestQualifyingDate || date > newestQualifyingDate) newestQualifyingDate = date;
    }
    if (newestQualifyingDate) {
      return resolveDeletionState({
        localDeletedAt: null,
        localDeletionUpdatedAt: newestQualifyingDate,
        remoteDeletedAt,
        remoteDeletionUpdatedAt,
      });
    }
  }
  return resolveDeletionState({ localDeletedAt, localDeletionUpdatedAt, remoteDeletedAt, remoteDeletionUpdatedAt });
}

/**
 * Does an UPDATE's returned row prove that OUR deletion-state write landed?
 *
 * PHYSICAL FAIL (2026-09-13, course "iii" a07b2831-7bb4-4a66-8a46-8cac8b91b5b5):
 * syncCourseDeletion confirmed its write with a byte-identical string compare,
 * `row.deletion_updated_at === deletionUpdatedAt`. `courses.deletion_updated_at`
 * is `timestamptz`, so PostgREST renders it with a `+00:00` offset (and often
 * six-digit microseconds) while the client sends `new Date().toISOString()`,
 * which ends in `Z`. The two are the SAME INSTANT but never the same string, so
 * every course delete — and every restore, which runs the same path — was
 * marked `failed` even though the cloud row updated correctly. The owner's
 * device showed this split directly: 57 cloud-returned timestamps in `+00:00`
 * form against 12 client-written ones in `Z` form.
 *
 * Confirmation therefore compares the clock SEMANTICALLY while still proving
 * the write is ours:
 *   - the caller must already have matched the exact UUID and user_id
 *   - the deleted/active state must match what we asked for
 *   - the stored clock must not be OLDER than the one we just wrote, so a
 *     stale pre-existing tombstone can never be mistaken for our write
 *     (a NEWER clock is accepted: another device's later decision supersedes
 *     ours, and ours still landed)
 *
 * @param {object} input
 * @param {string|null|undefined} input.rowDeletedAt returned deleted_at
 * @param {string|null|undefined} input.rowDeletionUpdatedAt returned deletion_updated_at
 * @param {string|null|undefined} input.sentDeletedAt deleted_at we wrote (null = restore)
 * @param {string|null|undefined} input.sentDeletionUpdatedAt deletion_updated_at we wrote
 * @returns {boolean}
 */
export function confirmsDeletionWrite({
  rowDeletedAt,
  rowDeletionUpdatedAt,
  sentDeletedAt,
  sentDeletionUpdatedAt,
} = {}) {
  const wantsDeleted = isDeleted(sentDeletedAt);
  if (isDeleted(rowDeletedAt) !== wantsDeleted) return false;
  const rowMs = Date.parse(rowDeletionUpdatedAt ?? '');
  const sentMs = Date.parse(sentDeletionUpdatedAt ?? '');
  if (Number.isNaN(rowMs) || Number.isNaN(sentMs)) return false;
  return rowMs >= sentMs;
}
