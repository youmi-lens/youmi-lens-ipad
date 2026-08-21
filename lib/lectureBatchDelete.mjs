/**
 * Batch lecture soft-delete orchestration (multi-select delete).
 *
 * Pure and Node-testable; no React or Supabase here. The store's
 * `deleteLectures` (lib/store.tsx) uses this to compute, in one pass, the
 * local soft-delete patches AND the remote recording ids to push — reusing the
 * exact single-delete soft-delete contract:
 *
 *   - local: `deletedAt` + `deletionUpdatedAt` stamped to the same clock, plus
 *     `deletedReason: 'manual'`. The record is NOT removed from state — it
 *     moves to Recently Deleted, so it stays restorable.
 *   - remote: `deleted_at` + `deletion_updated_at` for the `.in('id', ids)`
 *     update through the existing `pushRecordingPatch` path.
 *
 * A lecture whose `remoteRecordingId` is absent is still soft-deleted locally;
 * it simply has no remote row to push (identical to single delete).
 */

/** @typedef {{ id: string, remoteRecordingId?: string | null }} LectureLike */

/**
 * Compute the local + remote pieces of a batch soft delete.
 *
 * @param {object} input
 * @param {LectureLike[]} input.lectures the live lecture list to filter against
 * @param {string[]} input.ids the selected lecture UUIDs (may contain dupes)
 * @param {string} [input.now] ISO clock (injected for tests)
 * @returns {{
 *   localPatches: { id: string, patch: { deletedAt: string, deletionUpdatedAt: string, deletedReason: 'manual' } }[],
 *   remoteIds: string[],
 *   remotePatch: { deleted_at: string, deletion_updated_at: string },
 * }}
 */
export function buildBatchSoftDelete({ lectures, ids, now = new Date().toISOString() } = {}) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0));
  const localPatches = [];
  const remoteIds = [];
  const seen = new Set();

  for (const lecture of lectures ?? []) {
    if (!lecture || !wanted.has(lecture.id) || seen.has(lecture.id)) continue;
    seen.add(lecture.id);
    localPatches.push({
      id: lecture.id,
      patch: { deletedAt: now, deletionUpdatedAt: now, deletedReason: 'manual' },
    });
    if (typeof lecture.remoteRecordingId === 'string' && lecture.remoteRecordingId.length > 0) {
      remoteIds.push(lecture.remoteRecordingId);
    }
  }

  return {
    localPatches,
    remoteIds,
    remotePatch: { deleted_at: now, deletion_updated_at: now },
  };
}

/**
 * True when a plan actually changes something. The store uses this to no-op on
 * an empty / already-missing selection without touching state or the network.
 * @param {{ localPatches: unknown[] }} plan
 */
export function batchSoftDeleteIsEmpty(plan) {
  return !Array.isArray(plan?.localPatches) || plan.localPatches.length === 0;
}
