/**
 * Purge tombstones — the record that something was permanently deleted.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deletion on iPad is local-only. `public.recordings` has no `deleted_at`
 * column and this task may not add one, so a row the user deletes on device
 * stays ACTIVE on the server forever.
 *
 * Soft delete survives that fine: the lecture stays in local state carrying
 * `deletedAt`, and the cloud merge copies the tombstone forward
 * (`deletedAt: local?.deletedAt`).
 *
 * PERMANENT delete does not. `permanentlyDeleteLecture` drops the record from
 * local state entirely, so the next merge finds no local counterpart for the
 * still-active remote row and fabricates a brand-new lecture from it —
 * `deletedAt: undefined`, `localAudioUri: null`. The lecture returns to the
 * active course, now silent. Deleting it again repeats the loop forever.
 *
 * The same applies to courses, which the merge re-derives from each row's
 * `course` name: permanently deleting a course removes it locally, and the
 * next merge recreates it from any remote row still naming it.
 *
 * So a permanent delete has to leave something behind. This module is that
 * something: a small persisted set of remote recording ids and course names
 * the user has destroyed, which the merge consults before materializing
 * anything from a remote row.
 *
 * Scope: this is ONLY for permanent deletion. Soft delete continues to rely on
 * `deletedAt` on the record itself, which is restorable; a purge is not.
 */

/**
 * Shape persisted per storage scope.
 * @typedef {{ recordingIds: string[], courseNames: string[] }} DeletionTombstones
 */

/** @returns {DeletionTombstones} */
export function emptyTombstones() {
  return { recordingIds: /** @type {string[]} */ ([]), courseNames: /** @type {string[]} */ ([]) };
}

const asArray = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

/** Course names are matched the same way the merge matches them: trimmed, folded. */
export function courseNameKey(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

/** Parse whatever was in AsyncStorage into a known-good shape. */
export function parseTombstones(raw) {
  if (!raw || typeof raw !== 'object') return emptyTombstones();
  return {
    recordingIds: asArray(raw.recordingIds),
    courseNames: asArray(raw.courseNames),
  };
}

/** Fast lookup sets for the merge. */
export function toTombstoneIndex(tombstones) {
  const parsed = parseTombstones(tombstones);
  return {
    recordingIds: new Set(parsed.recordingIds),
    courseNames: new Set(parsed.courseNames.map(courseNameKey).filter(Boolean)),
  };
}

/** True when a remote recordings row must not be materialized at all. */
export function isPurgedRecording(index, remoteRecordingId) {
  if (!index?.recordingIds || typeof remoteRecordingId !== 'string') return false;
  return index.recordingIds.has(remoteRecordingId);
}

/** True when a course name must not be re-derived from a remote row. */
export function isPurgedCourseName(index, courseName) {
  const key = courseNameKey(courseName);
  if (!index?.courseNames || !key) return false;
  return index.courseNames.has(key);
}

/**
 * Record a permanent lecture deletion. Only ids that exist remotely are worth
 * remembering — a purely local recording has no row that could resurrect it.
 */
export function addPurgedRecordings(tombstones, remoteRecordingIds) {
  const current = parseTombstones(tombstones);
  const next = new Set(current.recordingIds);
  for (const id of asArray(remoteRecordingIds)) next.add(id);
  return { ...current, recordingIds: Array.from(next) };
}

/** Record a permanent course deletion by the name the merge would re-derive. */
export function addPurgedCourseNames(tombstones, courseNames) {
  const current = parseTombstones(tombstones);
  const next = new Set(current.courseNames);
  for (const name of asArray(courseNames)) {
    if (courseNameKey(name)) next.add(name.trim());
  }
  return { ...current, courseNames: Array.from(next) };
}

/**
 * Drop a purge record. Creating a course with a previously-purged name must
 * work again — otherwise the user could never reuse a name they deleted.
 */
export function clearPurgedCourseName(tombstones, courseName) {
  const current = parseTombstones(tombstones);
  const key = courseNameKey(courseName);
  return {
    ...current,
    courseNames: current.courseNames.filter((name) => courseNameKey(name) !== key),
  };
}
