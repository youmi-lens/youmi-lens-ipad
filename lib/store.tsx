/**
 * Local data store for Youmi Lens for iPad.
 *
 * Holds the signed-in user's courses and lectures in React state, persisted to
 * user-scoped AsyncStorage keys on the device. No user's local cache is ever
 * hydrated for another signed-in account.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

import { useAuth } from './auth';
import { createCloudRealtimeInvalidator } from './cloudRealtimeInvalidation.mjs';
import { GUEST_STORAGE_SCOPE } from './guest';
import {
  addPurgedCourseNames,
  addPurgedRecordings,
  clearPurgedCourseName,
  emptyTombstones,
  isPurgedCourseName,
  isPurgedRecording,
  parseTombstones,
  toTombstoneIndex,
} from './deletionTombstones.mjs';
import { resolveDeletionState } from './deletionSync.mjs';
import { batchSoftDeleteIsEmpty, buildBatchSoftDelete } from './lectureBatchDelete.mjs';
import { buildLectureMove } from './lectureMove.mjs';
import { resolveMergedLectureTitle } from './lectureTitle.mjs';
import {
  COURSE_PRESETS,
  type ContentLanguage,
  type Course,
  type CourseMaterial,
  type Lecture,
  type LectureMaterialLink,
  type LectureStatus,
  type MaterialAnnotationStroke,
  type MaterialPageAnnotation,
  type MaterialTextAnnotation,
  type NoteImage,
  type NoteStroke,
  type PersistedCaptionLine,
} from './models';
import { isSupabaseConfigured, supabase } from './supabase';
import {
  keepLocalIfRemoteContentEmpty,
  REMOTE_RECORDING_COLUMNS,
  remoteRecordingFallbackColumns,
  stripUnknownColumnFromPatch,
} from './remoteRecordingColumns.mjs';

// Legacy global keys from pre-account-isolation builds. Deliberately never
// loaded now because they have no trustworthy owner user id.
const LEGACY_COURSES_KEY = 'youmi.courses.v1';
const LEGACY_LECTURES_KEY = 'youmi.lectures.v1';
/** Permanently-deleted remote ids / course names for this scope. */
const scopedTombstonesKey = (userId: string) => `youmi.tombstones.v1.${userId}`;
const scopedCoursesKey = (userId: string) => `youmi.courses.v1.${userId}`;
const scopedLecturesKey = (userId: string) => `youmi.lectures.v1.${userId}`;
const scopedMaterialsKey = (userId: string) => `youmi.materials.v1.${userId}`;
const scopedMaterialLinksKey = (userId: string) => `youmi.materialLinks.v1.${userId}`;
const scopedMaterialAnnotationsKey = (userId: string) => `youmi.materialAnnotations.v1.${userId}`;
const UNFILED_COURSE_NAME = 'Unfiled';
export type NewCourseInput = {
  name: string;
  icon: string;
  tint: string;
  accent: string;
};

export type NewLectureInput = {
  /** Optional reserved id used by in-progress recording workflows. */
  id?: string;
  courseId: string;
  title: string;
  durationMillis: number;
  localAudioUri: string | null;
  markedTimestamps: number[];
  liveTranscript?: string;
  /** Draft Chinese translation captured from live captions during recording. */
  liveTranscriptZh?: string;
  translatedLiveTranscript?: string;
  sourceLanguage?: ContentLanguage;
  translationLanguage?: ContentLanguage;
  /** Persisted bilingual caption history for an in-progress/resumable lecture. */
  liveCaptionLines?: PersistedCaptionLine[];
  /** Lifecycle status; defaults to 'local_recorded' when omitted (a finished save). */
  status?: LectureStatus;
  /** Which recorder produced the audio. Local-only; absent on older lectures. */
  recordingEngine?: 'legacy' | 'nativeDurable';
  /** Typed notes captured during recording (Mini Workspace). */
  notes?: string;
  /** Handwritten strokes captured during recording (Mini Workspace). */
  noteStrokes?: NoteStroke[];
  /** Image objects placed on the notebook page during recording. */
  noteImages?: NoteImage[];
};

/** Result of attempting to soft-delete a course. */
export type DeleteCourseResult =
  | { ok: true }
  | { ok: false; reason: 'course_not_empty'; activeLectureCount: number };

export type DataContextValue = {
  /** True once the current user's scoped store has hydrated from device storage. */
  loaded: boolean;
  currentUserId: string | null;
  courses: Course[];
  lectures: Lecture[];
  /** Refresh cloud-backed courses and lectures without clearing current UI. */
  refreshCloudLibrary: () => Promise<void>;
  /** The course currently selected on the Record Home screen. */
  selectedCourseId: string | null;
  setSelectedCourseId: (id: string | null) => void;
  createCourse: (input: NewCourseInput) => Course;
  createLecture: (input: NewLectureInput) => Lecture;
  /** Create-or-update a resumable in-progress lecture (never lose partial work). */
  saveInProgressLecture: (input: NewLectureInput) => Lecture;
  updateLecture: (id: string, patch: Partial<Lecture>) => void;
  /** Move one active lecture to another active canonical Course. */
  moveLectureToCourse: (lectureId: string, targetCourseId: string) => boolean;
  /** Soft-delete a lecture — moves it to Recently Deleted; does not destroy data. */
  deleteLecture: (id: string) => void;
  /**
   * Soft-delete several lectures at once (multi-select). Same soft-delete
   * contract as deleteLecture — deletedAt + deletion_updated_at stamped, and a
   * single remote `.in('id', ids)` push. Never hard-deletes.
   */
  deleteLectures: (ids: string[]) => void;
  /**
   * Soft-delete a course — allowed only when it has no active lectures.
   * Returns a result so the UI can explain why a non-empty course was kept.
   */
  deleteCourse: (id: string) => DeleteCourseResult;
  /** Courses currently in Recently Deleted (deletedAt set). */
  deletedCourses: Course[];
  /** Lectures individually moved to Recently Deleted (deletedAt set). */
  deletedLectures: Lecture[];
  restoreCourse: (id: string) => void;
  restoreLecture: (id: string) => void;
  /** Permanently remove a course and its lectures. Irreversible. */
  permanentlyDeleteCourse: (id: string) => void;
  /** Permanently remove a lecture. Irreversible. */
  permanentlyDeleteLecture: (id: string) => void;
  /** Rename a course. Trims whitespace; no-op if name is empty after trim. */
  renameCourse: (courseId: string, newName: string) => void;
  /** Rename a lecture. Trims whitespace; no-op if title is empty after trim. */
  renameLecture: (lectureId: string, newTitle: string) => void;
  getCourse: (id?: string | null) => Course | undefined;
  getLecture: (id?: string | null) => Lecture | undefined;
  lecturesForCourse: (courseId: string) => Lecture[];

  // ---- Course Materials (Build 7 V1.1 — course-level only, local-only) ----
  /** Active (non-soft-deleted) materials, hydrated from AsyncStorage. */
  materials: CourseMaterial[];
  /** Materials belonging to a course, active only, newest first. */
  materialsForCourse: (courseId: string) => CourseMaterial[];
  /** Look up a material by id; undefined if missing or soft-deleted. */
  getMaterial: (id?: string | null) => CourseMaterial | undefined;
  /** Add a freshly-imported material into the store + persist to scoped cache. */
  addMaterial: (material: CourseMaterial) => void;
  /** Rename a material. Trims; no-op if empty after trim. */
  renameMaterial: (materialId: string, newTitle: string) => void;
  /** Update fields on a material (e.g. lastOpenedPage, pageCount). Bumps updatedAt. */
  updateMaterial: (materialId: string, patch: Partial<CourseMaterial>) => void;
  /** Soft-delete a material (moves to Recently Deleted; file stays in sandbox). */
  deleteMaterial: (materialId: string) => void;

  // ---- Lecture ↔ Material links (Build 7.x — local-only) ----
  materialLinks: LectureMaterialLink[];
  reserveLectureId: () => string;
  linkMaterialToLecture: (lectureId: string, materialId: string) => LectureMaterialLink;
  updateLectureMaterialLink: (
    lectureId: string,
    materialId: string,
    patch: Partial<LectureMaterialLink>,
  ) => void;
  materialLinksForLecture: (lectureId: string) => LectureMaterialLink[];
  materialLinksForMaterial: (materialId: string) => LectureMaterialLink[];
  removeLectureMaterialLink: (lectureId: string, materialId: string, reason?: string) => void;
  cleanupOrphanMaterialLinks: (validLectureIds: string[]) => void;

  // ---- PDF page annotations (Build 7.x V1 — local-only) ----
  materialAnnotations: MaterialPageAnnotation[];
  annotationForPage: (
    lectureId: string,
    materialId: string,
    pageNumber: number,
  ) => MaterialPageAnnotation | undefined;
  annotationsForPage: (
    lectureId: string,
    materialId: string,
    pageNumber: number,
  ) => MaterialAnnotationStroke[];
  annotationsForMaterialPage: (
    materialId: string,
    pageNumber: number,
  ) => MaterialAnnotationStroke[];
  textAnnotationsForMaterialPage: (materialId: string, pageNumber: number) => MaterialTextAnnotation[];
  countAnnotationsForMaterial: (materialId: string) => number;
  saveAnnotationStrokes: (
    lectureId: string,
    materialId: string,
    pageNumber: number,
    strokes: MaterialAnnotationStroke[],
  ) => void;
  replaceMaterialPageAnnotationStrokes: (
    lectureId: string,
    materialId: string,
    pageNumber: number,
    strokes: MaterialAnnotationStroke[],
  ) => void;
  replaceMaterialPageAnnotationStrokesForMaterial: (
    materialId: string,
    pageNumber: number,
    strokes: MaterialAnnotationStroke[],
    materialScopeLectureId: string,
  ) => void;
  replaceMaterialPageTextAnnotationsForMaterial: (
    materialId: string,
    pageNumber: number,
    annotations: MaterialTextAnnotation[],
    materialScopeLectureId: string,
  ) => void;
  addAnnotationStroke: (
    lectureId: string,
    materialId: string,
    pageNumber: number,
    stroke: MaterialAnnotationStroke,
  ) => void;
  undoLastAnnotationStroke: (lectureId: string, materialId: string, pageNumber: number) => void;
  clearAnnotationsForPage: (lectureId: string, materialId: string, pageNumber: number) => void;

  clearAll: () => Promise<void>;
};

type RemoteRecordingRow = {
  id: string;
  user_id: string;
  course: string | null;
  title: string | null;
  duration_sec: number | string | null;
  ai_status: string | null;
  ai_error: string | null;
  created_at: string | null;
  updated_at?: string | null;
  storage_path: string | null;
  transcript: string | null;
  transcript_zh?: string | null;
  translated_transcript?: string | null;
  summary_en: string | null;
  summary_zh: string | null;
  source_summary?: string | null;
  translated_summary?: string | null;
  live_transcript: string | null;
  translated_live_transcript?: string | null;
  source_language?: ContentLanguage | null;
  translation_language?: ContentLanguage | null;
  // Cloud Library Stage 2 columns (optional: absent on unmigrated projects, and
  // stripped by the column fallback ladder when a project lacks them).
  course_id?: string | null;
  deleted_at?: string | null;
  deletion_updated_at?: string | null;
  notes?: string | null;
  marked_timestamps?: number[] | null;
  title_updated_at?: string | null;
  notes_updated_at?: string | null;
  marks_updated_at?: string | null;
};

// Cloud Library Stage 4: a row of the authoritative `courses` table. All the
// Stage-4 additive fields are optional so a project that lacks them (production,
// or a project mid-migration) still types cleanly.
type RemoteCourseRow = {
  id: string;
  user_id: string;
  name: string | null;
  icon?: string | null;
  tint?: string | null;
  accent?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  deleted_at?: string | null;
  deletion_updated_at?: string | null;
};

export const DataContext = createContext<DataContextValue | null>(null);

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function stableIdFromName(prefix: string, name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}_${slug || 'unfiled'}`;
}

function normalizedCourseName(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNFILED_COURSE_NAME;
}

function choosePreset(index: number) {
  return COURSE_PRESETS[index % COURSE_PRESETS.length] ?? COURSE_PRESETS[0];
}

function makeRemoteLectureId(recordingId: string): string {
  return `lecture_${recordingId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function parseDurationMillis(durationSec: RemoteRecordingRow['duration_sec']): number {
  if (typeof durationSec === 'number' && Number.isFinite(durationSec)) return Math.max(0, Math.round(durationSec * 1000));
  if (typeof durationSec === 'string') {
    const parsed = Number(durationSec);
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed * 1000));
  }
  return 0;
}

function processingStatusFromRemote(status: string | null): Lecture['processingStatus'] {
  switch (status) {
    case 'done':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'queued':
    case 'transcribing':
    case 'transcript_ready':
    case 'summarizing':
      return 'processing';
    default:
      return 'not_started';
  }
}

function makeUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function makeMaterialAnnotationId(lectureId: string, materialId: string, pageNumber: number): string {
  return `annotation_${lectureId}_${materialId}_${pageNumber}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeLectures(storedLectures: Lecture[]): Lecture[] {
  return storedLectures.map((lecture) => ({
    ...lecture,
    remoteRecordingId: lecture.remoteRecordingId ?? makeUuid(),
    uploadStatus: lecture.uploadStatus ?? 'not_uploaded',
    processingStatus: lecture.processingStatus ?? 'not_started',
    transcript: typeof lecture.transcript === 'string' ? lecture.transcript : '',
    liveTranscript: lecture.liveTranscript ?? '',
    notes: typeof lecture.notes === 'string' ? lecture.notes : '',
    noteStrokes: Array.isArray(lecture.noteStrokes) ? lecture.noteStrokes : [],
  }));
}

async function fetchRemoteRecordingsForUser(userId: string): Promise<RemoteRecordingRow[]> {
  console.info('[store] remote recordings fetch started', { userId });
  const initial = await supabase
    .from('recordings')
    .select(REMOTE_RECORDING_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  let data: unknown = initial.data;
  let error = initial.error;

  let attemptedColumns = REMOTE_RECORDING_COLUMNS;
  for (let attempt = 0; error && attempt < 2; attempt += 1) {
    const fallbackColumns = remoteRecordingFallbackColumns(error.message, attemptedColumns);
    if (!fallbackColumns) break;
    const fallback = await supabase
      .from('recordings')
      .select(fallbackColumns)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    attemptedColumns = fallbackColumns;
    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    console.warn('[store] remote recordings fetch failed', { userId, message: error.message });
    throw error;
  }

  const rows = (data ?? []) as RemoteRecordingRow[];
  console.info('[store] remote recordings fetched', { userId, count: rows.length });
  return rows;
}

// Cloud Library Stage 4: the authoritative `courses` table. Degrades gracefully
// on any project without it (production, pre-migration) — a missing table or
// column resolves to an empty list, and the merge falls back to name-derivation.
const REMOTE_COURSE_COLUMNS = 'id,user_id,name,icon,tint,accent,created_at,updated_at,deleted_at,deletion_updated_at';
const REMOTE_COURSE_COLUMNS_MINIMAL = 'id,user_id,name,created_at,deleted_at';

async function fetchRemoteCoursesForUser(userId: string): Promise<RemoteCourseRow[]> {
  const primary = await supabase
    .from('courses')
    .select(REMOTE_COURSE_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (!primary.error) return (primary.data ?? []) as RemoteCourseRow[];

  // A missing column (a project mid-migration) → retry a minimal, always-present
  // set. A missing table (no courses at all) → give up quietly with no courses.
  const reduced = await supabase
    .from('courses')
    .select(REMOTE_COURSE_COLUMNS_MINIMAL)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (reduced.error) {
    console.info('[store] courses table unavailable — using name-derivation', { message: reduced.error.message });
    return [];
  }
  return (reduced.data ?? []) as RemoteCourseRow[];
}

// courses.id is a uuid column. Canonical Stage-4 courses are created with
// makeUuid(); legacy (pre-Stage-4) courses, materialized only by name from a
// recording's `course` string, carry a synthetic id from stableIdFromName
// ("cloud_course_<slug>") that is not a UUID and can never be sent as a valid
// courses.id. Classifying on this format, before any write, is what lets a
// legacy course's delete/restore get routed to writeLegacyCourseDeletion
// instead of an UPDATE that Postgres would reject outright (22P02).
const CANONICAL_COURSE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cloud Library Stage 4: account-level course delete/restore. `deletedAt` is the
// state (null = active), `now` stamps the freshness clock so a stale ACTIVE
// snapshot can never resurrect a newer tombstone (deletionSync). Fire-and-forget;
// on a project without the Stage-4 columns it retries the minimal `deleted_at`
// write and, failing that (no courses table at all), stays local-only.
//
// A legacy (non-UUID id) course has no courses row to UPDATE — see
// writeLegacyCourseDeletion, which gives it one instead of leaving the
// decision nowhere durable to live.
function writeCourseDeletion(userId: string, courseId: string, courseName: string, deletedAt: string | null, now: string): void {
  if (!CANONICAL_COURSE_ID_RE.test(courseId)) {
    void writeLegacyCourseDeletion(userId, courseName, deletedAt, now);
    return;
  }
  void supabase
    .from('courses')
    .update({ deleted_at: deletedAt, deletion_updated_at: now, updated_at: now })
    .eq('id', courseId)
    .eq('user_id', userId)
    .then(({ error }) => {
      if (!error) return;
      void supabase
        .from('courses')
        .update({ deleted_at: deletedAt })
        .eq('id', courseId)
        .eq('user_id', userId)
        .then(({ error: e2 }) => {
          if (e2) console.info('[store] course deletion cloud write skipped (kept local)', { courseId, message: e2.message });
        });
    });
}

// A legacy course (no courses row, name-derived from recordings.course) has
// nowhere for a delete/restore decision to live durably. Without a row here,
// the next merge on ANY device — including this one, after a relaunch —
// re-derives the course fresh and active from the still-present
// recordings.course string, because nothing records that it was ever
// deleted. This gives it a real canonical row instead.
//
// Existence is always checked FIRST, by name (the same normalization the
// merge itself uses), never inferred from a caught error:
//   - a row already exists (an earlier tombstone, or a genuine Stage-4
//     course sharing the name) → update it; this also makes repeated
//     deletes of the same legacy course idempotent, never a duplicate insert.
//   - no row exists and this is a DELETE → insert one (the actual fix).
//   - no row exists and this is a RESTORE → there is nothing durable to
//     restore server-side; stays local-only rather than inventing a row.
// A lookup or insert failure (network/RLS/schema) is logged and the write is
// skipped — it never falls through to a different write as a guess.
async function writeLegacyCourseDeletion(
  userId: string,
  courseName: string,
  deletedAt: string | null,
  now: string,
): Promise<void> {
  const name = normalizedCourseName(courseName);
  const key = name.toLowerCase();
  const { data, error } = await supabase
    .from('courses')
    .select('id,name,deleted_at')
    .eq('user_id', userId);
  if (error) {
    console.info('[store] legacy course deletion lookup skipped (kept local)', { name, message: error.message });
    return;
  }
  const existing = (data ?? []).find(
    (row) => normalizedCourseName((row as { name: string }).name).toLowerCase() === key,
  ) as { id: string; deleted_at: string | null } | undefined;

  if (existing) {
    void supabase
      .from('courses')
      .update({ deleted_at: deletedAt, deletion_updated_at: now, updated_at: now })
      .eq('id', existing.id)
      .eq('user_id', userId)
      .then(({ error: e2 }) => {
        if (e2) console.info('[store] legacy course deletion update skipped (kept local)', { name, message: e2.message });
      });
    return;
  }

  if (!deletedAt) return;

  const { error: insertError } = await supabase.from('courses').insert({
    id: makeUuid(),
    user_id: userId,
    name,
    deleted_at: deletedAt,
    deletion_updated_at: now,
  });
  if (insertError) {
    console.info('[store] legacy course tombstone insert skipped (kept local)', { name, message: insertError.message });
  }
}

function mergeRemoteRecordingsIntoStore(
  localCourses: Course[],
  localLectures: Lecture[],
  remoteRows: RemoteRecordingRow[],
  remoteCourses: RemoteCourseRow[],
  tombstones?: unknown,
): {
  courses: Course[];
  lectures: Lecture[];
  restoredLectureCount: number;
  derivedCourseCount: number;
  courseIdFixups: { id: string; course_id: string }[];
} {
  // Permanently-deleted rows are dropped here (before anything materializes) so
  // a purged lecture/course is never rebuilt from its still-live remote row.
  // Stage-4 SOFT deletion is account-level (columns below) and reconciled by
  // freshness (deletionSync), not by row existence.
  const purged = toTombstoneIndex(tombstones);
  const liveRemoteRows = remoteRows.filter((row) => !isPurgedRecording(purged, row.id));

  const localCoursesById = new Map(localCourses.map((course) => [course.id, course]));
  const localCoursesByName = new Map(localCourses.map((course) => [course.name.trim().toLowerCase(), course]));

  const coursesById = new Map<string, Course>();
  const coursesByName = new Map<string, Course>();
  const addCourse = (course: Course) => {
    coursesById.set(course.id, course);
    const key = course.name.trim().toLowerCase();
    if (!coursesByName.has(key)) coursesByName.set(key, course);
  };

  // 1. Authoritative cloud courses (Stage 4). Identity is `courses.id` (a stable
  //    UUID), never the name — a rename keeps the id, a duplicate name cannot
  //    fork a course, and deletion is resolved by freshness. On a project with
  //    no `courses` table this list is empty and the legacy name-derivation in
  //    step 2 is the whole story (production compatibility).
  const cloudCourseIds = new Set<string>();
  for (const cr of remoteCourses) {
    const name = normalizedCourseName(cr.name);
    if (isPurgedCourseName(purged, name)) continue;
    const local = localCoursesById.get(cr.id);
    const preset = choosePreset(coursesById.size);
    const deletion = resolveDeletionState({
      localDeletedAt: local?.deletedAt,
      localDeletionUpdatedAt: local?.deletionUpdatedAt,
      remoteDeletedAt: cr.deleted_at,
      remoteDeletionUpdatedAt: cr.deletion_updated_at,
    });
    cloudCourseIds.add(cr.id);
    addCourse({
      id: cr.id,
      name,
      icon: cr.icon ?? local?.icon ?? preset.icon,
      tint: cr.tint ?? local?.tint ?? preset.tint,
      accent: cr.accent ?? local?.accent ?? preset.accent,
      createdAt: cr.created_at ?? local?.createdAt ?? new Date().toISOString(),
      deletedAt: deletion.deletedAt,
      deletionUpdatedAt: deletion.deletionUpdatedAt,
      deletedReason: deletion.deletedAt ? (local?.deletedReason ?? 'manual') : null,
    });
  }

  // 2. Legacy name-derived courses: a recording whose course is not covered by a
  //    cloud course row (older data / unmigrated project) still materializes a
  //    course keyed by name, exactly as before.
  //
  //    A recording that is itself soft-deleted must NOT contribute a derived
  //    course — the write-path fix (writeLegacyCourseDeletion) only reaches a
  //    course the user deletes going forward; it cannot help a legacy course
  //    someone already deleted before that fix existed, because there is
  //    nothing left on the device to re-delete. Without this check, that
  //    recording's still-live (deleted-recording, not purged) row would keep
  //    re-deriving the course as ACTIVE on every merge, forever. A course
  //    with even one ACTIVE recording under the same name is unaffected: this
  //    loop only skips the deleted row's own contribution, and any other row
  //    for the same name is still free to derive it.
  for (const row of liveRemoteRows) {
    if (row.course_id && coursesById.has(row.course_id)) continue;
    if (row.deleted_at) continue;
    const courseName = normalizedCourseName(row.course);
    const nameKey = courseName.toLowerCase();
    if (coursesByName.has(nameKey)) continue;
    if (isPurgedCourseName(purged, courseName)) continue;
    const localByName = localCoursesByName.get(nameKey);
    const preset = choosePreset(coursesById.size);
    addCourse(
      localByName
        ? { ...localByName, name: courseName }
        : {
            id: stableIdFromName('cloud_course', courseName),
            name: courseName,
            icon: preset.icon,
            tint: preset.tint,
            accent: preset.accent,
            createdAt: row.created_at ?? new Date().toISOString(),
          },
    );
  }

  // 3. Local-only courses not yet synced (offline createCourse, or an empty
  //    course before its cloud insert lands). A cloud/derived course of the same
  //    name already supersedes it.
  //
  //    createCourse always assigns a real UUID id (makeUuid()) up front, even
  //    before its cloud insert confirms — so a genuine not-yet-synced course
  //    is always UUID-shaped. A course whose local id is instead the legacy
  //    synthetic form (stableIdFromName) only ever got that id from step 2's
  //    derivation. If it's here in `localCourses` but step 1/2 didn't just add
  //    it, that means every legacy recording under its name is now inactive —
  //    it is stale cached state from a PRIOR merge (before this fix, or before
  //    the last of its recordings was deleted), not a course the user is
  //    offline-authoring. Re-adding it here would resurrect exactly the ghost
  //    step 2 now correctly refuses to derive.
  for (const local of localCourses) {
    if (coursesById.has(local.id)) continue;
    if (coursesByName.has(local.name.trim().toLowerCase())) continue;
    if (isPurgedCourseName(purged, local.name)) continue;
    if (!CANONICAL_COURSE_ID_RE.test(local.id)) continue;
    addCourse(local);
  }

  const courseIdFixups: { id: string; course_id: string }[] = [];

  const lecturesByRemoteId = new Map<string, Lecture>();
  const localOnlyLectures: Lecture[] = [];
  for (const lecture of localLectures) {
    if (lecture.remoteRecordingId) {
      lecturesByRemoteId.set(lecture.remoteRecordingId, lecture);
    } else {
      localOnlyLectures.push(lecture);
    }
  }

  const mergedRemoteLectures = liveRemoteRows.map((row) => {
    const local = lecturesByRemoteId.get(row.id);
    const courseName = normalizedCourseName(row.course);
    // Stage 4: associate by the stable course_id first; fall back to name for
    // legacy rows. When a row resolves to a cloud course but its course_id is
    // missing/stale, queue a one-time heal so the server pointer becomes
    // authoritative too (idempotent; stripped on projects without the column).
    const courseById = row.course_id ? coursesById.get(row.course_id) : undefined;
    const course = courseById ?? coursesByName.get(courseName.toLowerCase());
    if (course && cloudCourseIds.has(course.id) && row.course_id !== course.id) {
      courseIdFixups.push({ id: row.id, course_id: course.id });
    }
    const processingStatus = processingStatusFromRemote(row.ai_status);
    const date = row.created_at ?? local?.date ?? new Date().toISOString();

    // Transcript freshness: after a local manual edit, keep local transcript
    // fields until a newer remote row arrives (same pattern as summaryUpdatedAt).
    const localTranscriptUpdatedAt = local?.transcriptUpdatedAt;
    const preferLocalTranscript =
      Boolean(localTranscriptUpdatedAt) &&
      (!row.updated_at || localTranscriptUpdatedAt! > row.updated_at);
    const transcript = preferLocalTranscript
      ? local?.transcript
      : keepLocalIfRemoteContentEmpty(row.transcript, local?.transcript);
    const transcriptZh = preferLocalTranscript
      ? local?.transcriptZh
      : keepLocalIfRemoteContentEmpty(row.transcript_zh, local?.transcriptZh);
    const translatedTranscript = preferLocalTranscript
      ? local?.translatedTranscript
      : keepLocalIfRemoteContentEmpty(row.translated_transcript, local?.translatedTranscript);
    // Summary freshness: after a local manual edit, keep local summary fields
    // until a newer remote row arrives (same pattern as titleUpdatedAt).
    const localSummaryUpdatedAt = local?.summaryUpdatedAt;
    const preferLocalSummary =
      Boolean(localSummaryUpdatedAt) &&
      (!row.updated_at || localSummaryUpdatedAt! > row.updated_at);
    const summaryEn = preferLocalSummary
      ? local?.summaryEn
      : keepLocalIfRemoteContentEmpty(row.summary_en, local?.summaryEn);
    const summaryZh = preferLocalSummary
      ? local?.summaryZh
      : keepLocalIfRemoteContentEmpty(row.summary_zh, local?.summaryZh);
    const sourceSummary = preferLocalSummary
      ? local?.sourceSummary
      : keepLocalIfRemoteContentEmpty(row.source_summary, local?.sourceSummary);
    const translatedSummary = preferLocalSummary
      ? local?.translatedSummary
      : keepLocalIfRemoteContentEmpty(row.translated_summary, local?.translatedSummary);
    const liveTranscript = keepLocalIfRemoteContentEmpty(row.live_transcript, local?.liveTranscript);
    const translatedLiveTranscript = keepLocalIfRemoteContentEmpty(row.translated_live_transcript, local?.translatedLiveTranscript);

    // Title authority: a title the user actually chose must never be replaced
    // by a placeholder ("Untitled Lecture", "Lecture", null, empty), whatever
    // the row-level timestamps say. Rename races between two *valid* titles
    // are still settled by freshness. See lib/lectureTitle.mjs for the rules.
    const resolvedTitle = resolveMergedLectureTitle({
      localTitle: local?.title,
      localTitleUpdatedAt: local?.titleUpdatedAt,
      remoteTitle: row.title,
      // Cloud Library Stage 2: title-specific freshness. An unrelated write
      // (transcript/summary/notes) can no longer make a stale title win.
      remoteTitleUpdatedAt: row.title_updated_at,
      remoteUpdatedAt: row.updated_at,
    });
    const finalTitle = resolvedTitle.title;
    const localTitleUpdatedAt = resolvedTitle.titleUpdatedAt;

    // Cloud Library Stage 2: account-level deletion. The side with the newer
    // deletion decision (delete OR restore) wins — a stale ACTIVE snapshot can
    // never resurrect a fresher tombstone, and only an explicit newer restore
    // brings something back. See lib/deletionSync.mjs.
    const resolvedDeletion = resolveDeletionState({
      localDeletedAt: local?.deletedAt,
      localDeletionUpdatedAt: local?.deletionUpdatedAt,
      remoteDeletedAt: row.deleted_at,
      remoteDeletionUpdatedAt: row.deletion_updated_at,
    });

    // Notes freshness: keep a fresher local edit, else take non-empty remote.
    const localNotesUpdatedAt = local?.notesUpdatedAt;
    const preferLocalNotes =
      Boolean(localNotesUpdatedAt) &&
      (!row.notes_updated_at || localNotesUpdatedAt! > row.notes_updated_at);
    const mergedNotes = preferLocalNotes
      ? (local?.notes ?? '')
      : keepLocalIfRemoteContentEmpty(row.notes, local?.notes);
    const mergedNotesUpdatedAt = (preferLocalNotes ? localNotesUpdatedAt : (row.notes_updated_at ?? localNotesUpdatedAt)) ?? undefined;

    // Marks freshness: the side with the newer marks clock wins; a legacy side
    // with no clock keeps whatever is present rather than clobbering.
    const localMarksUpdatedAt = local?.marksUpdatedAt;
    const remoteMarks = Array.isArray(row.marked_timestamps) ? row.marked_timestamps : undefined;
    const preferRemoteMarks =
      Boolean(row.marks_updated_at) &&
      (!localMarksUpdatedAt || row.marks_updated_at! > localMarksUpdatedAt) &&
      remoteMarks !== undefined;
    const mergedMarks = preferRemoteMarks ? remoteMarks! : (local?.markedTimestamps ?? remoteMarks ?? []);
    const mergedMarksUpdatedAt = (preferRemoteMarks ? row.marks_updated_at : (localMarksUpdatedAt ?? row.marks_updated_at)) ?? undefined;

    // Media (audio asset) freshness: same freshness-clock pattern as
    // transcript/summary/notes/marks/title above, applied to the audio
    // triad (durationMillis/uploadStatus/processingStatus) for the first
    // time. Without this, a locally-produced media revision (legacy-resume
    // assembly or general reconciliation producing a NEW canonical asset
    // for an ALREADY-uploaded lecture) has no way to hold its ground against
    // the next remote-merge cycle — which fires on nearly every screen
    // focus/navigation and, until now, unconditionally trusted row.duration_sec
    // / row.storage_path / row.ai_status. If the new asset's upload hasn't
    // succeeded yet (e.g. exceeds the backend's max object size), the cloud
    // row still describes the OLD asset, and every merge cycle reasserted
    // that old uploaded/ready state over the freshly-reconciled local one —
    // a stale read fighting the upload/reconciliation pipeline for the same
    // fields, which is exactly the observed "Ready -> Uploading -> Retry
    // Processing" oscillation on a lecture whose corrected audio cannot
    // finish uploading. Once the upload/processing genuinely completes and
    // the cloud row's own updated_at catches up, normal remote-authoritative
    // merging resumes automatically — this only holds the line during the
    // window where local knows about a revision the cloud does not yet.
    const localMediaRevisionAt = local?.mediaReconciliationCompletedAt ?? local?.audioAssemblyCompletedAt;
    const preferLocalMediaState =
      Boolean(localMediaRevisionAt) &&
      (!row.updated_at || localMediaRevisionAt! > row.updated_at);
    const mergedDurationMillis = preferLocalMediaState
      ? (local?.durationMillis ?? 0)
      : (parseDurationMillis(row.duration_sec) || local?.durationMillis || 0);
    const mergedUploadStatus = preferLocalMediaState
      ? (local?.uploadStatus ?? 'not_uploaded')
      : (row.storage_path ? 'uploaded' : local?.uploadStatus ?? 'not_uploaded');
    const mergedProcessingStatus = preferLocalMediaState
      ? (local?.processingStatus ?? 'not_started')
      : processingStatus;

    return {
      id: local?.id ?? makeRemoteLectureId(row.id),
      courseId: course?.id ?? stableIdFromName('cloud_course', UNFILED_COURSE_NAME),
      title: finalTitle,
      titleUpdatedAt: localTitleUpdatedAt,
      date,
      durationMillis: mergedDurationMillis,
      localAudioUri: local?.localAudioUri ?? null,
      remoteRecordingId: row.id,
      uploadStatus: mergedUploadStatus,
      storagePath: preferLocalMediaState ? local?.storagePath : (row.storage_path ?? local?.storagePath),
      uploadError: local?.uploadError,
      uploadedAt: row.updated_at ?? local?.uploadedAt,
      processingStatus: mergedProcessingStatus,
      processingError: row.ai_error ?? local?.processingError,
      remoteAiStatus: row.ai_status ?? local?.remoteAiStatus,
      remoteAiError: row.ai_error ?? local?.remoteAiError,
      lastSyncedAt: new Date().toISOString(),
      markedTimestamps: mergedMarks,
      marksUpdatedAt: mergedMarksUpdatedAt,
      status: local?.status ?? 'local_recorded',
      transcript,
      transcriptZh,
      translatedTranscript,
      transcriptUpdatedAt: localTranscriptUpdatedAt,
      summaryEn,
      summaryZh,
      sourceSummary,
      translatedSummary,
      summaryUpdatedAt: localSummaryUpdatedAt,
      keyPoints: local?.keyPoints ?? [],
      liveTranscript,
      translatedLiveTranscript,
      sourceLanguage: row.source_language ?? local?.sourceLanguage ?? 'en',
      translationLanguage: row.translation_language ?? local?.translationLanguage ?? 'zh-Hans',
      notes: mergedNotes,
      notesUpdatedAt: mergedNotesUpdatedAt,
      noteStrokes: local?.noteStrokes ?? [],
      noteUpdatedAt: local?.noteUpdatedAt,
      deletedAt: resolvedDeletion.deletedAt,
      deletionUpdatedAt: resolvedDeletion.deletionUpdatedAt,
      deletedReason: resolvedDeletion.deletedAt ? (local?.deletedReason ?? 'manual') : null,
      // Recording-engine/recovery provenance is LOCAL-ONLY — there is no
      // cloud column for any of these, so they must be explicitly carried
      // forward from `local` on every merge or they silently vanish the
      // moment a lecture gets its first remoteRecordingId (this was a real
      // Build 50 P0: audioSegments disappearing on every remote-merge cycle
      // made general media reconciliation discover zero legacy sources for
      // an already-uploaded lecture, even though they were never actually
      // lost from the original local record).
      recordingEngine: local?.recordingEngine,
      audioSegments: local?.audioSegments,
      audioAssemblyStatus: local?.audioAssemblyStatus,
      audioAssemblyReason: local?.audioAssemblyReason,
      audioAssemblyCompletedAt: local?.audioAssemblyCompletedAt,
      mediaIntegrityStatus: local?.mediaIntegrityStatus,
      mediaIntegrityDetail: local?.mediaIntegrityDetail,
      mediaIntegrityCheckedAt: local?.mediaIntegrityCheckedAt,
      mediaReconciliationStatus: local?.mediaReconciliationStatus,
      mediaReconciliationSourceIds: local?.mediaReconciliationSourceIds,
      mediaReconciliationDetail: local?.mediaReconciliationDetail,
      mediaReconciliationCompletedAt: local?.mediaReconciliationCompletedAt,
    } satisfies Lecture;
  });

  // Deliberately the UNFILTERED rows: a local record still carrying a purged
  // remote id must not be re-appended as "not yet uploaded".
  const remoteIds = new Set(remoteRows.map((row) => row.id));
  const pendingLocalLectures = localLectures.filter(
    (lecture) => !lecture.remoteRecordingId || !remoteIds.has(lecture.remoteRecordingId),
  );
  const mergedLecturesById = new Map<string, Lecture>();
  for (const lecture of [...mergedRemoteLectures, ...pendingLocalLectures, ...localOnlyLectures]) {
    mergedLecturesById.set(lecture.id, lecture);
  }

  return {
    courses: Array.from(coursesById.values()),
    lectures: Array.from(mergedLecturesById.values()),
    restoredLectureCount: mergedRemoteLectures.length,
    derivedCourseCount: coursesById.size,
    courseIdFixups,
  };
}

export function DataProvider({ children }: { children: ReactNode }) {
  // The visual-acceptance fixture is an opt-in DEV-only provider.  Its gate is
  // compile/runtime false for release builds and it never mounts the normal
  // hydrated store (or its Supabase reconciliation effects).
  if (__DEV__ && process.env.EXPO_PUBLIC_VISUAL_FIXTURE === '1') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DevVisualFixtureDataProvider } = require('./devVisualFixture');
    return <DevVisualFixtureDataProvider>{children}</DevVisualFixtureDataProvider>;
  }
  const { user, isGuest } = useAuth();
  const currentUserId = user?.id ?? null;
  // The on-device cache is keyed by this scope id. Signed-in users use their
  // Supabase user id; guests use a dedicated local-only scope so their
  // recordings persist across restarts without ever touching the cloud.
  const storageScopeId = currentUserId ?? (isGuest ? GUEST_STORAGE_SCOPE : null);
  const [loaded, setLoaded] = useState(false);
  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [materials, setMaterials] = useState<CourseMaterial[]>([]);
  const [materialLinks, setMaterialLinks] = useState<LectureMaterialLink[]>([]);
  const [materialAnnotations, setMaterialAnnotations] = useState<MaterialPageAnnotation[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  // What the user has PERMANENTLY deleted. Soft deletes live on the record as
  // `deletedAt`; this is only for records removed outright, which would
  // otherwise be rebuilt from their still-active remote rows. See
  // lib/deletionTombstones.mjs.
  const [tombstones, setTombstones] = useState(() => emptyTombstones());
  const hydrateSequence = useRef(0);
  const coursesRef = useRef<Course[]>([]);
  const lecturesRef = useRef<Lecture[]>([]);
  const materialsRef = useRef<CourseMaterial[]>([]);
  const tombstonesRef = useRef(emptyTombstones());
  // Foreground and Courses-focus events may arrive together; share one request.
  const cloudRefreshPromiseRef = useRef<Promise<void> | null>(null);
  // In-flight guard for the cloud-course reconciliation (P0 sync heal), keyed by
  // course name so overlapping syncs never double-insert the same course.
  const syncingCoursesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    tombstonesRef.current = tombstones;
  }, [tombstones]);

  useEffect(() => {
    coursesRef.current = courses;
  }, [courses]);

  useEffect(() => {
    lecturesRef.current = lectures;
  }, [lectures]);

  useEffect(() => {
    materialsRef.current = materials;
  }, [materials]);

  const applyRemoteRecordings = useCallback(
    async (baseCourses: Course[], baseLectures: Lecture[]) => {
      if (!currentUserId) {
        return { courses: baseCourses, lectures: baseLectures };
      }

      // Stage 4: the authoritative `courses` table and the recordings load in
      // parallel. On a project without a courses table the fetch yields [] and
      // the merge falls back to name-derivation.
      const [remoteRows, remoteCourses] = await Promise.all([
        fetchRemoteRecordingsForUser(currentUserId),
        fetchRemoteCoursesForUser(currentUserId),
      ]);

      // Merge against local state as it is NOW, not as it was when the request
      // was issued. The server snapshot is older than anything the user did
      // while it was in flight: deleting a lecture during the request and then
      // merging the pre-delete snapshot silently resurrected it, and the same
      // window could revert a rename or drop a freshly-recorded localAudioUri.
      // The refs are updated on every render (and primed synchronously during
      // hydration), so reading them here is the most recent local truth.
      const liveCourses = coursesRef.current.length ? coursesRef.current : baseCourses;
      const liveLectures = lecturesRef.current.length ? lecturesRef.current : baseLectures;
      const merged = mergeRemoteRecordingsIntoStore(
        liveCourses,
        liveLectures,
        remoteRows,
        remoteCourses,
        tombstonesRef.current,
      );
      console.info('[store] remote recordings merged/restored', {
        userId: currentUserId,
        remoteRecordings: remoteRows.length,
        remoteCourses: remoteCourses.length,
        lecturesMerged: merged.restoredLectureCount,
        coursesDerived: merged.derivedCourseCount,
        courseIdFixups: merged.courseIdFixups.length,
        cacheUpdated: true,
      });

      // LEGACY COMPATIBILITY HEAL ONLY — not the canonical create/upload path.
      // Canonical new data never depends on this: createCourse inserts the cloud
      // `courses` row at create time (UUID = courses.id) and the upload writes
      // recordings.course_id at first insert. This block only rescues LEGACY
      // courses — created before the Stage-4 wiring, so carrying a non-UUID local
      // id and never inserted into the cloud — whose recordings therefore have
      // course_id = NULL. For such a course (active, non-purged, non-"Unfiled",
      // whose NAME is not already a cloud course AND whose recordings are not
      // already linked to a cloud course) it inserts a stable UUID row; the merge
      // then adopts that UUID and the course_id heal links the recordings.
      // It NEVER merges two courses, NEVER re-keys a canonical (UUID-id) course,
      // and rename never reaches here (a renamed course keeps its id and stays a
      // cloud course). Idempotent via the unique (user_id, lower(name)) index.
      // Tombstoned cloud rows reserve their canonical identity. They are hidden
      // from active views, but reconciliation must not mistake them for a
      // missing course and fork a new active UUID from a stale local cache.
      const knownCloudCourseNames = new Set(
        remoteCourses
          .map((c) => normalizedCourseName(c.name).toLowerCase()),
      );
      // Names whose recordings are ALREADY linked to a cloud course — never
      // recreate those (defense against forking a course that already exists).
      const linkedCourseNames = new Set(
        remoteRows
          .filter((r) => r.course_id)
          .map((r) => normalizedCourseName(r.course).toLowerCase()),
      );
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const course of liveCourses) {
        if (course.deletedAt) continue;
        // Canonical (UUID-id) courses are created by createCourse — if one is
        // momentarily missing from the cloud we still re-insert under its OWN id
        // (idempotent), but a non-UUID id is the true legacy signal.
        const name = normalizedCourseName(course.name);
        const nameKey = name.toLowerCase();
        if (nameKey === UNFILED_COURSE_NAME.toLowerCase()) continue;
        if (knownCloudCourseNames.has(nameKey)) continue;
        if (linkedCourseNames.has(nameKey)) continue;
        if (isPurgedCourseName(toTombstoneIndex(tombstonesRef.current), name)) continue;
        if (syncingCoursesRef.current.has(nameKey)) continue;
        // A legacy (non-UUID) local course object can be stale cached state
        // from before this device ever managed a successful merge (exactly
        // the "Gg"/"Test" real-incident shape: name-derived, no cloud row,
        // every underlying recording already deleted) rather than a genuine
        // active course. `course.deletedAt` alone can't tell those apart —
        // this local object was never durably marked deleted anywhere. A
        // canonical (UUID) course has no such ambiguity: createCourse always
        // means the user is actively authoring it, so it heals unconditionally.
        if (!uuidRe.test(course.id)) {
          const hasActiveRecording = remoteRows.some(
            (row) => !row.deleted_at && normalizedCourseName(row.course).toLowerCase() === nameKey,
          );
          if (!hasActiveRecording) continue;
        }
        syncingCoursesRef.current.add(nameKey);
        const cloudId = uuidRe.test(course.id) ? course.id : makeUuid();
        void (async () => {
          try {
            let res = await supabase
              .from('courses')
              .insert({ id: cloudId, user_id: currentUserId, name, icon: course.icon, tint: course.tint, accent: course.accent });
            // Retry name-only for a project that predates icon/tint/accent (production).
            if (res.error) res = await supabase.from('courses').insert({ id: cloudId, user_id: currentUserId, name });
            if (res.error) console.info('[store] course reconcile skipped (kept local)', { name, message: res.error.message });
          } finally {
            syncingCoursesRef.current.delete(nameKey);
          }
        })();
      }

      // Heal legacy recordings whose course resolves to a cloud course but whose
      // `course_id` pointer is missing/stale, so the association becomes
      // authoritative server-side. Fire-and-forget and idempotent; a project
      // without the column simply errors and is ignored (next merge re-derives).
      for (const fix of merged.courseIdFixups) {
        void supabase
          .from('recordings')
          .update({ course_id: fix.course_id })
          .eq('id', fix.id)
          .eq('user_id', currentUserId)
          .then(({ error }) => {
            if (error) console.info('[store] course_id heal skipped', { message: error.message });
          });
      }

      return { courses: merged.courses, lectures: merged.lectures };
    },
    [currentUserId],
  );

  const refreshCloudLibrary = useCallback(async (): Promise<void> => {
    if (!currentUserId) return;
    if (cloudRefreshPromiseRef.current) return cloudRefreshPromiseRef.current;

    const refresh = applyRemoteRecordings(coursesRef.current, lecturesRef.current)
      .then((merged) => {
        setCourses(merged.courses);
        setLectures(merged.lectures);
        setSelectedCourseId((current) =>
          current && merged.courses.some((course) => course.id === current && !course.deletedAt)
            ? current
            : merged.courses.find((course) => !course.deletedAt)?.id ?? null,
        );
      })
      .finally(() => {
        cloudRefreshPromiseRef.current = null;
      });
    cloudRefreshPromiseRef.current = refresh;
    return refresh;
  }, [applyRemoteRecordings, currentUserId]);

  // Realtime is deliberately an INVALIDATION signal, never a second merge
  // engine. Every event flows through refreshCloudLibrary → the established
  // fetch/reconcile path, which owns UUID identity, deletion clocks, field
  // freshness, and the tombstone-reserving legacy heal.
  useEffect(() => {
    if (!currentUserId || !isSupabaseConfigured) return;

    const invalidator = createCloudRealtimeInvalidator(refreshCloudLibrary);
    const userFilter = `user_id=eq.${currentUserId}`;
    const channel = supabase
      .channel(`cloud-library:${currentUserId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'courses', filter: userFilter },
        () => invalidator.invalidate(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'recordings', filter: userFilter },
        () => invalidator.invalidate(),
      )
      .subscribe((status) => {
        // The initial subscribe and every reconnect repair missed-event gaps
        // using the canonical fetch; no raw event payload reaches UI state.
        if (status === 'SUBSCRIBED') invalidator.invalidate();
      });

    return () => {
      invalidator.dispose();
      void supabase.removeChannel(channel);
    };
  }, [currentUserId, refreshCloudLibrary]);

  // Hydrate only the current user's scoped storage. On account switch or sign
  // out, clear memory immediately so old data can never flash for the new user.
  useEffect(() => {
    const sequence = ++hydrateSequence.current;
    let mounted = true;

    setLoaded(false);
    setHydratedUserId(null);
    setCourses([]);
    setLectures([]);
    setMaterials([]);
    setMaterialLinks([]);
    setMaterialAnnotations([]);
    setSelectedCourseId(null);
    setTombstones(emptyTombstones());
    tombstonesRef.current = emptyTombstones();

    if (!storageScopeId) {
      setHydratedUserId(null);
      setLoaded(true);
      return () => {
        mounted = false;
      };
    }

    (async () => {
      try {
        const [rawCourses, rawLectures, rawMaterials, rawMaterialLinks, rawMaterialAnnotations, rawTombstones] = await Promise.all([
          AsyncStorage.getItem(scopedCoursesKey(storageScopeId)),
          AsyncStorage.getItem(scopedLecturesKey(storageScopeId)),
          AsyncStorage.getItem(scopedMaterialsKey(storageScopeId)),
          AsyncStorage.getItem(scopedMaterialLinksKey(storageScopeId)),
          AsyncStorage.getItem(scopedMaterialAnnotationsKey(storageScopeId)),
          AsyncStorage.getItem(scopedTombstonesKey(storageScopeId)),
        ]);
        if (!mounted || hydrateSequence.current !== sequence) return;
        const storedCourses: Course[] = rawCourses ? JSON.parse(rawCourses) : [];
        const storedLectures: Lecture[] = rawLectures ? JSON.parse(rawLectures) : [];
        const storedMaterials: CourseMaterial[] = rawMaterials ? JSON.parse(rawMaterials) : [];
        const storedMaterialLinks: LectureMaterialLink[] = rawMaterialLinks ? JSON.parse(rawMaterialLinks) : [];
        const storedMaterialAnnotations: MaterialPageAnnotation[] = rawMaterialAnnotations
          ? JSON.parse(rawMaterialAnnotations)
          : [];
        const normalizedLocalLectures = normalizeLectures(storedLectures);
        // Load purge tombstones BEFORE the cloud merge below, and prime the ref
        // in the same tick — a merge that ran without them would rebuild every
        // permanently-deleted lecture from its still-active remote row.
        const storedTombstones = parseTombstones(rawTombstones ? JSON.parse(rawTombstones) : null);
        setTombstones(storedTombstones);
        tombstonesRef.current = storedTombstones;

        // ── Stale-while-revalidate ────────────────────────────────────────
        // Commit the on-device cache and mark the store loaded NOW, before the
        // cloud round-trip. `loaded` previously flipped only in the `finally`
        // below — i.e. after `await applyRemoteRecordings(...)` — so every
        // consumer that gates on it (Courses' skeleton, the Record tab's
        // recent list) sat on placeholders for the entire duration of a
        // Supabase request while perfectly good local data was already in
        // hand. On a slow or absent network that was seconds of skeleton over
        // content we could have shown immediately.
        //
        // The remote merge still runs; it just reconciles into visible content
        // instead of gating it, exactly like the foreground refresh below.
        setCourses(storedCourses);
        setLectures(normalizedLocalLectures);
        // Prime the live refs in the same tick. The effect that normally syncs
        // them runs only after a render, and the merge below reads them
        // synchronously — without this they would still hold the `[]` written
        // by the reset above, and the merge would treat every not-yet-uploaded
        // lecture as absent locally and drop it.
        coursesRef.current = storedCourses;
        lecturesRef.current = normalizedLocalLectures;
        // Materials are local-only in V1.1 — no cloud merge yet.
        setMaterials(Array.isArray(storedMaterials) ? storedMaterials : []);
        setMaterialLinks(Array.isArray(storedMaterialLinks) ? storedMaterialLinks : []);
        setMaterialAnnotations(Array.isArray(storedMaterialAnnotations) ? storedMaterialAnnotations : []);
        setHydratedUserId(storageScopeId);
        setSelectedCourseId(storedCourses.find((course) => !course.deletedAt)?.id ?? null);
        setLoaded(true);

        // Background reconcile. Reads the LIVE refs rather than the snapshot
        // above so a rename or delete the user performs while the request is
        // in flight is merged against, not overwritten by, the response.
        try {
          const merged = await applyRemoteRecordings(coursesRef.current, lecturesRef.current);
          if (!mounted || hydrateSequence.current !== sequence) return;
          setCourses(merged.courses);
          setLectures(merged.lectures);
          // Keep the user's current course selected if the merge did not
          // remove it — re-deriving unconditionally would yank the selection
          // out from under them when the response lands.
          setSelectedCourseId((current) =>
            current && merged.courses.some((course) => course.id === current && !course.deletedAt)
              ? current
              : merged.courses.find((course) => !course.deletedAt)?.id ?? null,
          );
        } catch {
          // Keep the user-scoped cache if cloud restore fails; RLS/network errors
          // are logged in fetchRemoteRecordingsForUser. Never fall back to global cache.
        }
      } catch {
        // Corrupt or missing user-scoped data — start from an empty state.
      } finally {
        if (mounted && hydrateSequence.current === sequence) setLoaded(true);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [applyRemoteRecordings, storageScopeId]);


  // Refresh cloud-backed history when the app returns to the foreground. This
  // keeps processing status/transcripts moving without making local cache the
  // source of truth.
  useEffect(() => {
    if (!currentUserId || !loaded || hydratedUserId !== currentUserId) return;

    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void refreshCloudLibrary()
        .catch(() => {
          // Already logged by fetchRemoteRecordingsForUser; keep current cache.
        });
    });

    return () => subscription.remove();
  }, [currentUserId, hydratedUserId, loaded, refreshCloudLibrary]);

  // Persist only after the current scope's store is loaded. Legacy global keys
  // remain intentionally ignored; they cannot safely be attributed. Guests use
  // a dedicated local scope (no cloud) — see storageScopeId.
  useEffect(() => {
    if (loaded && storageScopeId && hydratedUserId === storageScopeId) {
      AsyncStorage.setItem(scopedCoursesKey(storageScopeId), JSON.stringify(courses)).catch(() => {});
    }
  }, [courses, storageScopeId, hydratedUserId, loaded]);

  useEffect(() => {
    if (loaded && storageScopeId && hydratedUserId === storageScopeId) {
      AsyncStorage.setItem(scopedLecturesKey(storageScopeId), JSON.stringify(lectures)).catch(() => {});
    }
  }, [lectures, storageScopeId, hydratedUserId, loaded]);

  // Purge tombstones must outlive the records they describe — if this write is
  // lost, the next cloud merge resurrects everything the user destroyed.
  useEffect(() => {
    if (loaded && storageScopeId && hydratedUserId === storageScopeId) {
      AsyncStorage.setItem(scopedTombstonesKey(storageScopeId), JSON.stringify(tombstones)).catch(() => {});
    }
  }, [tombstones, storageScopeId, hydratedUserId, loaded]);

  // Materials persistence (Build 7 V1.1) — same per-scope pattern.
  // Local-only; no Supabase mirror in V1.
  useEffect(() => {
    if (loaded && storageScopeId && hydratedUserId === storageScopeId) {
      AsyncStorage.setItem(scopedMaterialsKey(storageScopeId), JSON.stringify(materials)).catch(() => {});
    }
  }, [materials, storageScopeId, hydratedUserId, loaded]);

  // Lecture/material links are also local-only and scoped per signed-in user / guest.
  useEffect(() => {
    if (loaded && storageScopeId && hydratedUserId === storageScopeId) {
      AsyncStorage.setItem(scopedMaterialLinksKey(storageScopeId), JSON.stringify(materialLinks)).catch(() => {});
    }
  }, [materialLinks, storageScopeId, hydratedUserId, loaded]);

  useEffect(() => {
    if (loaded && storageScopeId && hydratedUserId === storageScopeId) {
      AsyncStorage.setItem(scopedMaterialAnnotationsKey(storageScopeId), JSON.stringify(materialAnnotations)).catch(() => {});
    }
  }, [materialAnnotations, storageScopeId, hydratedUserId, loaded]);

  const createCourse = useCallback((input: NewCourseInput): Course => {
    // Stage 4: the id is a stable UUID that IS the cloud `courses.id`. Generating
    // it client-side (rather than re-keying after an insert) keeps the local
    // course, its lectures' courseId, and the cloud row on one identity — so an
    // empty course syncs immediately and a rename never changes the id.
    const course: Course = {
      id: makeUuid(),
      name: input.name,
      icon: input.icon,
      tint: input.tint,
      accent: input.accent,
      createdAt: new Date().toISOString(),
    };
    // Reusing the name of a permanently-deleted course is legitimate — lift
    // that purge so the new course is not silently suppressed by its own name.
    setTombstones((prev) => clearPurgedCourseName(prev, course.name));
    setCourses((prev) => [...prev, course]);
    setSelectedCourseId(course.id);

    // Persist the account-level course row (fire-and-forget; guests and offline
    // keep the local course and reconcile on the next merge). Retry without the
    // visual columns for a project that predates them (production).
    if (currentUserId) {
      const full = { id: course.id, user_id: currentUserId, name: course.name, icon: course.icon, tint: course.tint, accent: course.accent };
      void supabase.from('courses').insert(full).then(({ error }) => {
        if (!error) return;
        void supabase
          .from('courses')
          .insert({ id: course.id, user_id: currentUserId, name: course.name })
          .then(({ error: minErr }) => {
            if (minErr) console.info('[store] course cloud insert skipped (kept local)', { message: minErr.message });
          });
      });
    }
    return course;
  }, [currentUserId]);

  const createLecture = useCallback((input: NewLectureInput): Lecture => {
    const lecture: Lecture = {
      id: input.id ?? makeId('lecture'),
      courseId: input.courseId,
      title: input.title,
      date: new Date().toISOString(),
      durationMillis: input.durationMillis,
      localAudioUri: input.localAudioUri,
      remoteRecordingId: makeUuid(),
      uploadStatus: 'not_uploaded',
      processingStatus: 'not_started',
      markedTimestamps: input.markedTimestamps,
      status: input.status ?? 'local_recorded',
      ...(input.recordingEngine ? { recordingEngine: input.recordingEngine } : {}),
      transcript: '',
      summaryEn: '',
      summaryZh: '',
      keyPoints: [],
      liveTranscript: input.liveTranscript ?? '',
      liveTranscriptZh: input.liveTranscriptZh ?? '',
      translatedLiveTranscript: input.translatedLiveTranscript ?? '',
      sourceLanguage: input.sourceLanguage ?? 'en',
      translationLanguage: input.translationLanguage ?? 'zh-Hans',
      liveCaptionLines: input.liveCaptionLines ?? [],
      notes: input.notes ?? '',
      noteStrokes: input.noteStrokes ?? [],
      noteImages: input.noteImages ?? [],
      noteUpdatedAt:
        (input.notes && input.notes.length > 0) ||
        (input.noteStrokes && input.noteStrokes.length > 0) ||
        (input.noteImages && input.noteImages.length > 0)
          ? new Date().toISOString()
          : undefined,
    };
    setLectures((prev) => [...prev, lecture]);
    return lecture;
  }, []);

  // Resilient cloud write for recordings. Fire-and-forget by contract (local
  // state already updated; a failed push is retried on the next merge). The
  // strip-and-retry loop lets one payload work on BOTH the staging schema
  // (Stage-2 columns, no updated_at) and production (updated_at, no Stage-2
  // columns) without a per-environment branch — see stripUnknownColumnFromPatch.
  const pushRecordingPatch = useCallback(
    (patch: Record<string, unknown>, ids: string[], label: string) => {
      if (!currentUserId || ids.length === 0) return;
      const attempt = (payload: Record<string, unknown>, tries: number) => {
        void supabase
          .from('recordings')
          .update(payload)
          .in('id', ids)
          .eq('user_id', currentUserId)
          .then(({ error }) => {
            if (!error) return;
            const reduced = tries > 0 ? stripUnknownColumnFromPatch(payload, error.message) : null;
            if (reduced) {
              attempt(reduced, tries - 1);
            } else {
              console.warn(`[store] ${label} cloud push failed (kept local)`, { message: error.message });
            }
          });
      };
      // Up to 4 strips covers the widest column divergence between environments.
      attempt(patch, 4);
    },
    [currentUserId],
  );

  const updateLecture = useCallback((id: string, patch: Partial<Lecture>) => {
    const now = new Date().toISOString();
    // Stage 2: typed notes and marks are account-level. When a patch changes
    // them, stamp the field-freshness clock locally and propagate to the cloud
    // so a second client reconciles them. Other patches (recording progress,
    // audio uri, status) are untouched and never push.
    const touchesNotes = Object.prototype.hasOwnProperty.call(patch, 'notes');
    const touchesMarks = Object.prototype.hasOwnProperty.call(patch, 'markedTimestamps');
    const stamped: Partial<Lecture> = { ...patch };
    if (touchesNotes) stamped.notesUpdatedAt = now;
    if (touchesMarks) stamped.marksUpdatedAt = now;
    setLectures((prev) => prev.map((l) => (l.id === id ? { ...l, ...stamped } : l)));

    if (touchesNotes || touchesMarks) {
      const remoteId = lecturesRef.current.find((l) => l.id === id)?.remoteRecordingId ?? null;
      if (remoteId) {
        const cloud: Record<string, unknown> = {};
        if (touchesNotes) { cloud.notes = patch.notes ?? ''; cloud.notes_updated_at = now; }
        if (touchesMarks) { cloud.marked_timestamps = patch.markedTimestamps ?? []; cloud.marks_updated_at = now; }
        pushRecordingPatch(cloud, [remoteId], 'lecture notes/marks');
      }
    }
  }, [pushRecordingPatch]);

  // Local-first canonical association move. It never creates/replaces a
  // Lecture: only courseId changes locally, while the existing remote row is
  // patched by remoteRecordingId with both the UUID pointer and legacy label.
  const moveLectureToCourse = useCallback((lectureId: string, targetCourseId: string): boolean => {
    const lecture = lecturesRef.current.find((item) => item.id === lectureId);
    const targetCourse = coursesRef.current.find((course) => course.id === targetCourseId);
    const plan = buildLectureMove({ lecture, targetCourse, courses: coursesRef.current });
    if (!plan) return false;

    setLectures((prev) => prev.map((item) => (item.id === lectureId ? plan.lecture : item)));
    if (plan.remoteIds.length > 0) {
      pushRecordingPatch(plan.remotePatch, plan.remoteIds, 'lecture move');
    }
    return true;
  }, [pushRecordingPatch]);

  // Create-or-update an in-progress (resumable) lecture. Called while recording
  // to make sure meaningful content is never lost on pause/exit/background: the
  // first call creates the row with status 'in_progress'; later calls patch it.
  // Keeps prior audio if a fresh segment URI isn't provided this save.
  const saveInProgressLecture = useCallback((input: NewLectureInput): Lecture => {
    const id = input.id ?? makeId('lecture');
    let saved: Lecture | null = null;
    setLectures((prev) => {
      const existing = prev.find((l) => l.id === id && !l.deletedAt);
      if (existing) {
        const hasNotes = Object.prototype.hasOwnProperty.call(input, 'notes');
        const hasStrokes = Object.prototype.hasOwnProperty.call(input, 'noteStrokes');
        const hasImages = Object.prototype.hasOwnProperty.call(input, 'noteImages');
        const nextNotes = hasNotes ? (input.notes ?? '') : existing.notes;
        const nextStrokes = hasStrokes ? (input.noteStrokes ?? []) : (existing.noteStrokes ?? []);
        const nextImages = hasImages ? (input.noteImages ?? []) : (existing.noteImages ?? []);
        const notesChanged =
          nextNotes !== existing.notes ||
          nextStrokes !== (existing.noteStrokes ?? []) ||
          nextImages !== (existing.noteImages ?? []);
        const hasNoteContent =
          nextNotes.length > 0 || nextStrokes.length > 0 || nextImages.length > 0;
        const patched: Lecture = {
          ...existing,
          courseId: input.courseId || existing.courseId,
          title: input.title || existing.title,
          durationMillis: Math.max(existing.durationMillis, input.durationMillis),
          localAudioUri: input.localAudioUri ?? existing.localAudioUri,
          markedTimestamps: input.markedTimestamps,
          liveTranscript: input.liveTranscript ?? existing.liveTranscript,
          liveTranscriptZh: input.liveTranscriptZh ?? existing.liveTranscriptZh,
          translatedLiveTranscript: input.translatedLiveTranscript ?? existing.translatedLiveTranscript,
          sourceLanguage: existing.sourceLanguage ?? input.sourceLanguage ?? 'en',
          translationLanguage: existing.translationLanguage ?? input.translationLanguage ?? 'zh-Hans',
          liveCaptionLines: input.liveCaptionLines ?? existing.liveCaptionLines,
          notes: nextNotes,
          noteStrokes: nextStrokes,
          noteImages: nextImages,
          noteUpdatedAt: notesChanged && hasNoteContent ? new Date().toISOString() : existing.noteUpdatedAt,
          status: 'in_progress',
          // Provenance is set once by the engine that started the capture and is
          // never downgraded by a later autosave.
          recordingEngine: existing.recordingEngine ?? input.recordingEngine,
        };
        saved = patched;
        return prev.map((l) => (l.id === id ? patched : l));
      }
      const lecture: Lecture = {
        id,
        courseId: input.courseId,
        title: input.title,
        date: new Date().toISOString(),
        durationMillis: input.durationMillis,
        localAudioUri: input.localAudioUri,
        remoteRecordingId: makeUuid(),
        uploadStatus: 'not_uploaded',
        processingStatus: 'not_started',
        markedTimestamps: input.markedTimestamps,
        status: 'in_progress',
        ...(input.recordingEngine ? { recordingEngine: input.recordingEngine } : {}),
        transcript: '',
        summaryEn: '',
        summaryZh: '',
        keyPoints: [],
        liveTranscript: input.liveTranscript ?? '',
        liveTranscriptZh: input.liveTranscriptZh ?? '',
        translatedLiveTranscript: input.translatedLiveTranscript ?? '',
        sourceLanguage: input.sourceLanguage ?? 'en',
        translationLanguage: input.translationLanguage ?? 'zh-Hans',
        liveCaptionLines: input.liveCaptionLines ?? [],
        notes: input.notes ?? '',
        noteStrokes: input.noteStrokes ?? [],
        noteImages: input.noteImages ?? [],
        noteUpdatedAt:
          (input.notes && input.notes.length > 0) ||
          (input.noteStrokes && input.noteStrokes.length > 0) ||
          (input.noteImages && input.noteImages.length > 0)
            ? new Date().toISOString()
            : undefined,
      };
      saved = lecture;
      return [...prev, lecture];
    });
    return saved ?? ({ id } as Lecture);
  }, []);

  const renameCourse = useCallback((courseId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();

    // Update the local course name immediately (also persisted to the per-user
    // AsyncStorage cache via the effect that watches `courses`). The id never
    // changes — a rename is a name edit, not a new course.
    setCourses((prev) => prev.map((c) => (c.id === courseId ? { ...c, name: trimmed } : c)));

    if (currentUserId) {
      // Stage 4: the authoritative write is `courses.name` keyed by the stable
      // course id. This is what makes an EMPTY course rename persist and keeps
      // the id fixed across devices. A legacy name-derived id matches no row
      // (harmless no-op); a project without the table simply errors and the
      // local name stands.
      void supabase
        .from('courses')
        .update({ name: trimmed, updated_at: now })
        .eq('id', courseId)
        .eq('user_id', currentUserId)
        .then(({ error }) => {
          if (error) console.info('[store] courses.name update skipped', { courseId, message: error.message });
        });

      // Compatibility dual-write: the legacy `recordings.course` label every
      // pre-Stage-4 client reads. Update every cloud-backed lecture in this
      // course so name-only clients (and name-derivation fallback) stay in step.
      const remoteIds = lecturesRef.current
        .filter((l) => l.courseId === courseId && l.remoteRecordingId)
        .map((l) => l.remoteRecordingId as string);
      if (remoteIds.length > 0) {
        void supabase
          .from('recordings')
          .update({ course: trimmed, updated_at: now })
          .in('id', remoteIds)
          .eq('user_id', currentUserId)
          .then(({ error }) => {
            if (error) console.info('[store] legacy course label update skipped', { courseId, message: error.message });
          });
      }
    }
  }, [currentUserId]);

  const renameLecture = useCallback((lectureId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();

    // Capture the lecture's remoteRecordingId before the state update so we
    // can decide whether to push to Supabase, without depending on the
    // updater closure.
    const target = lecturesRef.current.find((l) => l.id === lectureId);
    const remoteId = target?.remoteRecordingId ?? null;

    // Local state + the per-user AsyncStorage cache (via the persistence
    // effect that watches `lectures`) get the new title immediately, plus
    // a freshness stamp the cloud-merge uses to defeat stale-remote reverts.
    setLectures((prev) =>
      prev.map((l) => (l.id === lectureId ? { ...l, title: trimmed, titleUpdatedAt: now } : l)),
    );

    // Cloud-backed lecture: push the title + its Stage-2 freshness clock so
    // other devices reflect the rename and title-vs-title conflicts resolve
    // deterministically. `updated_at` is kept for production compatibility; the
    // resilient push drops whichever of updated_at / title_updated_at the target
    // project lacks.
    if (remoteId) {
      pushRecordingPatch(
        { title: trimmed, title_updated_at: now, updated_at: now },
        [remoteId],
        'lecture rename',
      );
    }
  }, [pushRecordingPatch]);

  // Deleting moves an item to Recently Deleted (soft delete) — data is never
  // destroyed here. permanentlyDelete* below is the only path that removes data.
  // Stage 2: the deletion is also pushed to the cloud (deleted_at +
  // deletion_updated_at) so it becomes account-level and reconciles on every
  // other client; a stale ACTIVE snapshot can never resurrect it (deletionSync).
  const deleteLecture = useCallback((id: string) => {
    const now = new Date().toISOString();
    const remoteId = lecturesRef.current.find((l) => l.id === id)?.remoteRecordingId ?? null;
    setLectures((prev) =>
      prev.map((l) =>
        l.id === id ? { ...l, deletedAt: now, deletionUpdatedAt: now, deletedReason: 'manual' } : l,
      ),
    );
    if (remoteId) pushRecordingPatch({ deleted_at: now, deletion_updated_at: now }, [remoteId], 'lecture delete');
  }, [pushRecordingPatch]);

  // Batch multi-select soft delete. Local-first: snapshot the selected UUIDs
  // from the LIVE ref, stamp the same soft-delete fields deleteLecture uses,
  // then push ONE remote update (`.in('id', ids)`) — all-or-nothing server-side,
  // so a partial network failure can never half-delete the batch, and a full
  // failure leaves the local soft-delete authoritative with no rollback.
  const deleteLectures = useCallback((ids: string[]) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const now = new Date().toISOString();
    const plan = buildBatchSoftDelete({ lectures: lecturesRef.current, ids, now });
    if (batchSoftDeleteIsEmpty(plan)) return;
    const patchesById = new Map(plan.localPatches.map((p) => [p.id, p.patch]));
    setLectures((prev) =>
      prev.map((l) => (patchesById.has(l.id) ? { ...l, ...patchesById.get(l.id)! } : l)),
    );
    if (plan.remoteIds.length > 0) {
      pushRecordingPatch(plan.remotePatch, plan.remoteIds, 'lecture batch delete');
    }
  }, [pushRecordingPatch]);

  const deleteCourse = useCallback(
    (id: string): DeleteCourseResult => {
      // Only an empty course can be deleted. Lectures already in Recently
      // Deleted do not count — a course of only deleted lectures is "empty".
      const activeLectureCount = lectures.filter(
        (l) => l.courseId === id && !l.deletedAt,
      ).length;
      if (activeLectureCount > 0) {
        return { ok: false, reason: 'course_not_empty', activeLectureCount };
      }
      const now = new Date().toISOString();
      const courseName = coursesRef.current.find((c) => c.id === id)?.name ?? '';
      setCourses((prev) =>
        prev.map((c) => (c.id === id ? { ...c, deletedAt: now, deletionUpdatedAt: now, deletedReason: 'manual' } : c)),
      );
      setSelectedCourseId((current) => (current === id ? null : current));
      // Stage 4: account-level course deletion (courses.deleted_at + freshness).
      if (currentUserId) writeCourseDeletion(currentUserId, id, courseName, now, now);
      return { ok: true };
    },
    [lectures, currentUserId],
  );

  const restoreCourse = useCallback((id: string) => {
    const now = new Date().toISOString();
    const courseName = coursesRef.current.find((c) => c.id === id)?.name ?? '';
    // Explicit restore stamps a NEW deletion clock so it wins over any stale
    // tombstone on other clients (only an explicit newer restore un-deletes).
    setCourses((prev) =>
      prev.map((c) => (c.id === id ? { ...c, deletedAt: null, deletionUpdatedAt: now, deletedReason: null } : c)),
    );
    if (currentUserId) writeCourseDeletion(currentUserId, id, courseName, null, now);
  }, [currentUserId]);

  const restoreLecture = useCallback(
    (id: string) => {
      const target = lectures.find((l) => l.id === id);
      const now = new Date().toISOString();
      // Explicit restore stamps a NEW deletion clock so it wins over any stale
      // tombstone on other clients (only an explicit newer restore un-deletes).
      setLectures((prev) =>
        prev.map((l) => (l.id === id ? { ...l, deletedAt: null, deletionUpdatedAt: now, deletedReason: null } : l)),
      );
      // A lecture cannot live in a deleted course — restore the parent course
      // too so the recovered lecture is reachable again in active views.
      if (target) {
        setCourses((prev) =>
          prev.map((c) =>
            c.id === target.courseId && c.deletedAt
              ? { ...c, deletedAt: null, deletedReason: null }
              : c,
          ),
        );
        if (target.remoteRecordingId) {
          pushRecordingPatch({ deleted_at: null, deletion_updated_at: now }, [target.remoteRecordingId], 'lecture restore');
        }
      }
    },
    [lectures, pushRecordingPatch],
  );

  // Permanent deletion removes the local record outright, so — unlike a soft
  // delete, whose `deletedAt` rides along on the record itself — there is
  // nothing left for the cloud merge to recognise. The remote row stays active
  // forever (no `deleted_at` column), so without a tombstone the next merge
  // rebuilds the record as a brand-new active lecture with no local audio.
  const permanentlyDeleteCourse = useCallback((id: string) => {
    const course = coursesRef.current.find((c) => c.id === id);
    const purgedRemoteIds = lecturesRef.current
      .filter((lecture) => lecture.courseId === id)
      .map((lecture) => lecture.remoteRecordingId)
      .filter((remoteId): remoteId is string => typeof remoteId === 'string' && remoteId.length > 0);

    setTombstones((prev) => {
      let next = addPurgedRecordings(prev, purgedRemoteIds);
      // Also block the course itself from being re-derived from any remote
      // row that still carries its name.
      if (course?.name) next = addPurgedCourseNames(next, [course.name]);
      return next;
    });

    setCourses((prev) => prev.filter((c) => c.id !== id));
    setLectures((prev) => prev.filter((lecture) => lecture.courseId !== id));
    setSelectedCourseId((current) => (current === id ? null : current));
  }, []);

  const permanentlyDeleteLecture = useCallback((id: string) => {
    const remoteId = lecturesRef.current.find((lecture) => lecture.id === id)?.remoteRecordingId;
    if (remoteId) setTombstones((prev) => addPurgedRecordings(prev, [remoteId]));
    setLectures((prev) => prev.filter((lecture) => lecture.id !== id));
  }, []);

  // ---- Course Materials CRUD (Build 7 V1.1) ----
  const addMaterial = useCallback((material: CourseMaterial) => {
    setMaterials((prev) => [...prev, material]);
  }, []);

  const renameMaterial = useCallback((materialId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    setMaterials((prev) =>
      prev.map((m) => (m.id === materialId ? { ...m, title: trimmed, updatedAt: now } : m)),
    );
  }, []);

  /**
   * Idempotent update. If none of the patched fields actually differ from the
   * stored material, returns the same `prev` array reference — no state
   * mutation, no re-render. This is essential because the PDF viewer calls
   * updateMaterial on every onLoadComplete / debounced page change; without
   * this guard, a stable value would still bump `updatedAt`, churn material
   * identity, and produce a "Maximum update depth exceeded" loop in any
   * effect whose deps include `material`.
   */
  const updateMaterial = useCallback((materialId: string, patch: Partial<CourseMaterial>) => {
    setMaterials((prev) => {
      let mutated = false;
      const next = prev.map((m) => {
        if (m.id !== materialId) return m;
        let anyDifferent = false;
        for (const key of Object.keys(patch) as (keyof CourseMaterial)[]) {
          if (m[key] !== patch[key]) {
            anyDifferent = true;
            break;
          }
        }
        if (!anyDifferent) return m;
        mutated = true;
        return { ...m, ...patch, updatedAt: new Date().toISOString() };
      });
      return mutated ? next : prev;
    });
  }, []);

  const deleteMaterial = useCallback((materialId: string) => {
    const now = new Date().toISOString();
    setMaterials((prev) =>
      prev.map((m) => (m.id === materialId ? { ...m, deletedAt: now, deletedReason: 'manual' } : m)),
    );
  }, []);

  const reserveLectureId = useCallback(() => makeId('lecture'), []);

  const linkMaterialToLecture = useCallback((lectureId: string, materialId: string): LectureMaterialLink => {
    const now = new Date().toISOString();
    let result: LectureMaterialLink | null = null;
    setMaterialLinks((prev) => {
      const existing = prev.find((link) => link.lectureId === lectureId && link.materialId === materialId);
      if (existing) {
        if (!existing.deletedAt && !existing.deletedReason) {
          result = existing;
          return prev;
        }
        const revived = { ...existing, deletedAt: null, deletedReason: null, updatedAt: now };
        result = revived;
        return prev.map((link) => (link === existing ? revived : link));
      }
      const next: LectureMaterialLink = { lectureId, materialId, createdAt: now, updatedAt: now };
      result = next;
      return [...prev, next];
    });
    return result ?? { lectureId, materialId, createdAt: now, updatedAt: now };
  }, []);

  const updateLectureMaterialLink = useCallback((
    lectureId: string,
    materialId: string,
    patch: Partial<LectureMaterialLink>,
  ) => {
    setMaterialLinks((prev) => {
      let mutated = false;
      const now = new Date().toISOString();
      const next = prev.map((link) => {
        if (link.lectureId !== lectureId || link.materialId !== materialId || link.deletedAt) return link;
        let anyDifferent = false;
        for (const key of Object.keys(patch) as (keyof LectureMaterialLink)[]) {
          if (key === 'lectureId' || key === 'materialId' || key === 'createdAt' || key === 'updatedAt') continue;
          if (link[key] !== patch[key]) {
            anyDifferent = true;
            break;
          }
        }
        if (!anyDifferent) return link;
        mutated = true;
        return { ...link, ...patch, lectureId, materialId, updatedAt: now };
      });
      return mutated ? next : prev;
    });
  }, []);

  const removeLectureMaterialLink = useCallback((lectureId: string, materialId: string, reason = 'manual') => {
    const now = new Date().toISOString();
    setMaterialLinks((prev) =>
      prev.map((link) =>
        link.lectureId === lectureId && link.materialId === materialId && !link.deletedAt
          ? { ...link, deletedAt: now, deletedReason: reason, updatedAt: now }
          : link,
      ),
    );
  }, []);

  const cleanupOrphanMaterialLinks = useCallback((validLectureIds: string[]) => {
    const validSet = new Set(validLectureIds);
    const now = new Date().toISOString();
    setMaterialLinks((prev) => {
      let mutated = false;
      const next = prev.map((link) => {
        if (link.deletedAt || validSet.has(link.lectureId)) return link;
        mutated = true;
        return { ...link, deletedAt: now, deletedReason: 'recording_abandoned', updatedAt: now };
      });
      return mutated ? next : prev;
    });
  }, []);

  const upsertAnnotationPage = useCallback((
    lectureId: string,
    materialId: string,
    pageNumber: number,
    updater: (strokes: MaterialAnnotationStroke[]) => MaterialAnnotationStroke[],
  ) => {
    if (!lectureId || !materialId || pageNumber < 1) return;
    const normalizedPage = Math.max(1, Math.round(pageNumber));
    setMaterialAnnotations((prev) => {
      const existingIndex = prev.findIndex(
        (annotation) =>
          annotation.lectureId === lectureId &&
          annotation.materialId === materialId &&
          annotation.pageNumber === normalizedPage &&
          !annotation.deletedAt,
      );
      const now = new Date().toISOString();
      if (existingIndex >= 0) {
        const existing = prev[existingIndex];
        const nextStrokes = updater(existing.strokes);
        if (nextStrokes === existing.strokes) return prev;
        if (
          nextStrokes.length === existing.strokes.length &&
          nextStrokes.every((stroke, index) => stroke === existing.strokes[index])
        ) {
          return prev;
        }
        const next = [...prev];
        next[existingIndex] = { ...existing, strokes: nextStrokes, updatedAt: now };
        return next;
      }

      const strokes = updater([]);
      if (strokes.length === 0) return prev;
      const annotation: MaterialPageAnnotation = {
        id: makeMaterialAnnotationId(lectureId, materialId, normalizedPage),
        lectureId,
        materialId,
        pageNumber: normalizedPage,
        strokes,
        createdAt: now,
        updatedAt: now,
      };
      return [...prev, annotation];
    });
  }, []);

  const saveAnnotationStrokes = useCallback((
    lectureId: string,
    materialId: string,
    pageNumber: number,
    strokes: MaterialAnnotationStroke[],
  ) => {
    upsertAnnotationPage(lectureId, materialId, pageNumber, (prev) => {
      if (
        prev.length === strokes.length &&
        prev.every((stroke, index) => stroke === strokes[index])
      ) {
        return prev;
      }
      return strokes;
    });
  }, [upsertAnnotationPage]);

  const replaceMaterialPageAnnotationStrokesForMaterial = useCallback((
    materialId: string,
    pageNumber: number,
    strokes: MaterialAnnotationStroke[],
    materialScopeLectureId: string,
  ) => {
    if (!materialId || pageNumber < 1 || !materialScopeLectureId) return;
    const normalizedPage = Math.max(1, Math.round(pageNumber));
    const remainingIds = new Set(strokes.map((stroke) => stroke.id));
    const incomingById = new Map(strokes.map((stroke) => [stroke.id, stroke]));
    const now = new Date().toISOString();

    setMaterialAnnotations((prev) => {
      let mutated = false;
      const claimedIds = new Set<string>();
      let materialScopeIndex = -1;

      const next = prev.map((annotation, index) => {
        if (
          annotation.materialId !== materialId ||
          annotation.pageNumber !== normalizedPage ||
          annotation.deletedAt
        ) {
          return annotation;
        }

        if (annotation.lectureId === materialScopeLectureId) {
          materialScopeIndex = index;
        }

        const nextStrokes = annotation.strokes
          .filter((stroke) => stroke.coordSpace !== 'pdfPage' || remainingIds.has(stroke.id))
          .map((stroke) => {
            if (stroke.coordSpace !== 'pdfPage') return stroke;
            claimedIds.add(stroke.id);
            return incomingById.get(stroke.id) ?? stroke;
          });

        if (
          nextStrokes.length === annotation.strokes.length &&
          nextStrokes.every((stroke, strokeIndex) => stroke === annotation.strokes[strokeIndex])
        ) {
          return annotation;
        }

        mutated = true;
        return { ...annotation, strokes: nextStrokes, updatedAt: now };
      });

      const unclaimedStrokes = strokes.filter((stroke) => !claimedIds.has(stroke.id));
      if (unclaimedStrokes.length > 0) {
        mutated = true;
        if (materialScopeIndex >= 0) {
          const existing = next[materialScopeIndex];
          next[materialScopeIndex] = {
            ...existing,
            strokes: [...existing.strokes, ...unclaimedStrokes],
            updatedAt: now,
          };
        } else {
          next.push({
            id: makeMaterialAnnotationId(materialScopeLectureId, materialId, normalizedPage),
            lectureId: materialScopeLectureId,
            materialId,
            pageNumber: normalizedPage,
            strokes: unclaimedStrokes,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      return mutated ? next : prev;
    });
  }, []);

  const addAnnotationStroke = useCallback((
    lectureId: string,
    materialId: string,
    pageNumber: number,
    stroke: MaterialAnnotationStroke,
  ) => {
    upsertAnnotationPage(lectureId, materialId, pageNumber, (prev) => {
      if (prev.some((existing) => existing.id === stroke.id)) return prev;
      return [...prev, stroke];
    });
  }, [upsertAnnotationPage]);

  /**
   * Material-wide text layer. Unlike legacy lecture-scoped ink, text always
   * belongs to the shared material scope so opening the same PDF from another
   * lecture shows one canonical annotation document.
   */
  const replaceMaterialPageTextAnnotationsForMaterial = useCallback((
    materialId: string,
    pageNumber: number,
    annotations: MaterialTextAnnotation[],
    materialScopeLectureId: string,
  ) => {
    if (!materialId || pageNumber < 1 || !materialScopeLectureId) return;
    const normalizedPage = Math.max(1, Math.round(pageNumber));
    const sanitized = annotations.filter((annotation) =>
      Boolean(annotation?.id) && typeof annotation.text === 'string' && annotation.text.trim().length > 0,
    );
    const now = new Date().toISOString();
    setMaterialAnnotations((prev) => {
      const index = prev.findIndex((annotation) =>
        annotation.lectureId === materialScopeLectureId &&
        annotation.materialId === materialId &&
        annotation.pageNumber === normalizedPage &&
        !annotation.deletedAt,
      );
      if (index >= 0) {
        const existing = prev[index];
        const current = existing.textAnnotations ?? [];
        if (current.length === sanitized.length && current.every((item, i) => item === sanitized[i])) return prev;
        const next = [...prev];
        next[index] = { ...existing, textAnnotations: sanitized, updatedAt: now };
        return next;
      }
      if (sanitized.length === 0) return prev;
      return [...prev, {
        id: makeMaterialAnnotationId(materialScopeLectureId, materialId, normalizedPage),
        lectureId: materialScopeLectureId,
        materialId,
        pageNumber: normalizedPage,
        strokes: [],
        textAnnotations: sanitized,
        createdAt: now,
        updatedAt: now,
      }];
    });
  }, []);

  const undoLastAnnotationStroke = useCallback((lectureId: string, materialId: string, pageNumber: number) => {
    upsertAnnotationPage(lectureId, materialId, pageNumber, (prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
  }, [upsertAnnotationPage]);

  const clearAnnotationsForPage = useCallback((lectureId: string, materialId: string, pageNumber: number) => {
    upsertAnnotationPage(lectureId, materialId, pageNumber, (prev) => (prev.length > 0 ? [] : prev));
  }, [upsertAnnotationPage]);

  const clearAll = useCallback(async () => {
    setCourses([]);
    setLectures([]);
    setMaterials([]);
    setMaterialLinks([]);
    setMaterialAnnotations([]);
    setSelectedCourseId(null);
    if (storageScopeId) {
      await AsyncStorage.multiRemove([
        scopedCoursesKey(storageScopeId),
        scopedLecturesKey(storageScopeId),
        scopedMaterialsKey(storageScopeId),
        scopedMaterialLinksKey(storageScopeId),
        scopedMaterialAnnotationsKey(storageScopeId),
      ]).catch(() => {});
    }
  }, [storageScopeId]);

  const visibleStoreReady = loaded && hydratedUserId === storageScopeId;
  const visibleCourses = visibleStoreReady ? courses : [];
  const visibleLectures = visibleStoreReady ? lectures : [];
  const visibleMaterials = visibleStoreReady ? materials : [];
  const visibleMaterialLinks = visibleStoreReady ? materialLinks : [];
  const visibleMaterialAnnotations = visibleStoreReady ? materialAnnotations : [];

  // Active (non-soft-deleted) materials. A material whose parent course is in
  // Recently Deleted is hidden from active views — same pattern as lectures.
  const activeMaterials = useMemo(
    () => visibleMaterials.filter((m) => !m.deletedAt),
    [visibleMaterials],
  );
  const activeMaterialLinks = useMemo(
    () => visibleMaterialLinks.filter((link) => !link.deletedAt),
    [visibleMaterialLinks],
  );
  const activeMaterialAnnotations = useMemo(
    () => visibleMaterialAnnotations.filter((annotation) => !annotation.deletedAt),
    [visibleMaterialAnnotations],
  );

  // Active vs Recently Deleted. A course/lecture with deletedAt set is in
  // Recently Deleted. Lectures whose parent course is deleted are hidden from
  // active views too, but keep their own (unset) deleted state so they return
  // automatically when the course is restored.
  const activeCourses = useMemo(
    () => visibleCourses.filter((c) => !c.deletedAt),
    [visibleCourses],
  );
  const deletedCourses = useMemo(
    () => visibleCourses.filter((c) => Boolean(c.deletedAt)),
    [visibleCourses],
  );
  const deletedCourseIds = useMemo(
    () => new Set(deletedCourses.map((c) => c.id)),
    [deletedCourses],
  );
  const activeLectures = useMemo(
    () => visibleLectures.filter((l) => !l.deletedAt && !deletedCourseIds.has(l.courseId)),
    [visibleLectures, deletedCourseIds],
  );
  const deletedLectures = useMemo(
    () => visibleLectures.filter((l) => Boolean(l.deletedAt)),
    [visibleLectures],
  );

  const value = useMemo<DataContextValue>(
    () => ({
      loaded: visibleStoreReady,
      currentUserId,
      courses: activeCourses,
      lectures: activeLectures,
      refreshCloudLibrary,
      deletedCourses,
      deletedLectures,
      selectedCourseId: visibleStoreReady ? selectedCourseId : null,
      setSelectedCourseId,
      createCourse,
      createLecture,
      saveInProgressLecture,
      updateLecture,
      moveLectureToCourse,
      deleteLecture,
      deleteLectures,
      deleteCourse,
      restoreCourse,
      restoreLecture,
      permanentlyDeleteCourse,
      permanentlyDeleteLecture,
      renameCourse,
      renameLecture,
      getCourse: (id) => activeCourses.find((c) => c.id === id),
      getLecture: (id) => activeLectures.find((l) => l.id === id),
      lecturesForCourse: (courseId) => activeLectures.filter((l) => l.courseId === courseId),
      materials: activeMaterials,
      materialsForCourse: (courseId) =>
        activeMaterials
          .filter((m) => m.courseId === courseId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      getMaterial: (id) => activeMaterials.find((m) => m.id === id),
      addMaterial,
      renameMaterial,
      updateMaterial,
      deleteMaterial,
      materialLinks: activeMaterialLinks,
      reserveLectureId,
      linkMaterialToLecture,
      updateLectureMaterialLink,
      materialLinksForLecture: (lectureId) =>
        activeMaterialLinks.filter((link) => link.lectureId === lectureId),
      materialLinksForMaterial: (materialId) =>
        activeMaterialLinks.filter((link) => link.materialId === materialId),
      removeLectureMaterialLink,
      cleanupOrphanMaterialLinks,
      materialAnnotations: activeMaterialAnnotations,
      annotationForPage: (lectureId, materialId, pageNumber) =>
        activeMaterialAnnotations.find(
          (annotation) =>
            annotation.lectureId === lectureId &&
            annotation.materialId === materialId &&
            annotation.pageNumber === Math.max(1, Math.round(pageNumber)),
        ),
      annotationsForPage: (lectureId, materialId, pageNumber) =>
        activeMaterialAnnotations.find(
          (annotation) =>
            annotation.lectureId === lectureId &&
            annotation.materialId === materialId &&
            annotation.pageNumber === Math.max(1, Math.round(pageNumber)),
        )?.strokes ?? [],
      annotationsForMaterialPage: (materialId, pageNumber) =>
        activeMaterialAnnotations
          .filter(
            (annotation) =>
              annotation.materialId === materialId &&
              annotation.pageNumber === Math.max(1, Math.round(pageNumber)),
          )
          .flatMap((annotation) => annotation.strokes),
      textAnnotationsForMaterialPage: (materialId, pageNumber) =>
        activeMaterialAnnotations
          .filter((annotation) =>
            annotation.materialId === materialId &&
            annotation.pageNumber === Math.max(1, Math.round(pageNumber)),
          )
          .flatMap((annotation) => annotation.textAnnotations ?? []),
      countAnnotationsForMaterial: (materialId) =>
        activeMaterialAnnotations
          .filter((annotation) => annotation.materialId === materialId)
          .reduce((total, annotation) => total + annotation.strokes.length, 0),
      saveAnnotationStrokes,
      replaceMaterialPageAnnotationStrokes: saveAnnotationStrokes,
      replaceMaterialPageAnnotationStrokesForMaterial,
      replaceMaterialPageTextAnnotationsForMaterial,
      addAnnotationStroke,
      undoLastAnnotationStroke,
      clearAnnotationsForPage,
      clearAll,
    }),
    [visibleStoreReady, currentUserId, activeCourses, activeLectures, refreshCloudLibrary, deletedCourses, deletedLectures, selectedCourseId, createCourse, createLecture, saveInProgressLecture, updateLecture, moveLectureToCourse, deleteLecture, deleteLectures, deleteCourse, restoreCourse, restoreLecture, permanentlyDeleteCourse, permanentlyDeleteLecture, renameCourse, renameLecture, activeMaterials, addMaterial, renameMaterial, updateMaterial, deleteMaterial, activeMaterialLinks, reserveLectureId, linkMaterialToLecture, updateLectureMaterialLink, removeLectureMaterialLink, cleanupOrphanMaterialLinks, activeMaterialAnnotations, saveAnnotationStrokes, replaceMaterialPageAnnotationStrokesForMaterial, replaceMaterialPageTextAnnotationsForMaterial, addAnnotationStroke, undoLastAnnotationStroke, clearAnnotationsForPage, clearAll],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

/** Access the local data store. Must be used within a DataProvider. */
export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) {
    throw new Error('useData must be used within a DataProvider');
  }
  return ctx;
}

// Keep these exported for diagnostics/migration notes only; they are never
// hydrated because they are not user-scoped.
export const legacyUnscopedStorageKeys = [LEGACY_COURSES_KEY, LEGACY_LECTURES_KEY] as const;
