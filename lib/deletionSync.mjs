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
