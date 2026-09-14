/**
 * Pure same-name guard for course creation.
 *
 * PHYSICAL FAIL (2026-09-12): the delete/recreate guards in createCourse were
 * correct in isolation but resolved the same-name predecessor with
 * `Array#find`, i.e. the FIRST row sharing the name. Repeated
 * create/delete/recreate cycles leave several confirmed tombstones under one
 * name (the owner's device had four rows named "Hhh"), and the row that
 * actually still holds the active name — or is still awaiting its delete
 * confirmation — is whichever was created last, so it sorts AFTER the stale
 * ones. `find` therefore returned a long-resolved tombstone
 * (deletedAt set, deletionSyncState cleared), every guard read as "clear",
 * and an optimistic duplicate was created anyway. Its remote INSERT then hit
 * the `WHERE deleted_at IS NULL` partial unique index (23505), which the
 * insert path deliberately swallows, and the next cloud reconcile dropped the
 * local UUID that had no remote row — the course visibly vanished.
 *
 * Every same-name row must be considered, in blocking precedence order.
 * `normalizeKey` is supplied by the caller so store.tsx's own
 * `normalizedCourseName` stays the single source of truth for naming rules.
 */

/**
 * @param {Array<{ name?: string | null, deletedAt?: string | null, deletionSyncState?: 'pending' | 'failed' }>} courses
 * @param {string} normalizedName lower-cased, already-normalized target name
 * @param {(value: string | null | undefined) => string} normalizeKey
 * @returns {'same_name_active' | 'delete_failed' | 'delete_pending' | null}
 */
export function sameNameCreateBlock(courses, normalizedName, normalizeKey) {
  const matches = (courses ?? []).filter(
    (course) => normalizeKey(course?.name).toLowerCase() === normalizedName,
  );
  // An active namesake is authoritative: the partial unique index will reject
  // the insert, so never fabricate an optimistic duplicate for it.
  if (matches.some((course) => !course.deletedAt)) return 'same_name_active';
  // A failed tombstone needs an explicit retry from Recently Deleted before
  // the name can be reused; a pending one just needs its confirmation to land.
  if (matches.some((course) => course.deletedAt && course.deletionSyncState === 'failed')) {
    return 'delete_failed';
  }
  if (matches.some((course) => course.deletedAt && course.deletionSyncState === 'pending')) {
    return 'delete_pending';
  }
  return null;
}
