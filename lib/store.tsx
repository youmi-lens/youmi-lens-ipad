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
import { GUEST_STORAGE_SCOPE } from './guest';
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
  type NoteImage,
  type NoteStroke,
  type PersistedCaptionLine,
} from './models';
import { supabase } from './supabase';
import {
  keepLocalIfRemoteContentEmpty,
  REMOTE_RECORDING_COLUMNS,
  remoteRecordingFallbackColumns,
} from './remoteRecordingColumns.mjs';

// Legacy global keys from pre-account-isolation builds. Deliberately never
// loaded now because they have no trustworthy owner user id.
const LEGACY_COURSES_KEY = 'youmi.courses.v1';
const LEGACY_LECTURES_KEY = 'youmi.lectures.v1';
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

type DataContextValue = {
  /** True once the current user's scoped store has hydrated from device storage. */
  loaded: boolean;
  currentUserId: string | null;
  courses: Course[];
  lectures: Lecture[];
  /** The course currently selected on the Record Home screen. */
  selectedCourseId: string | null;
  setSelectedCourseId: (id: string | null) => void;
  createCourse: (input: NewCourseInput) => Course;
  createLecture: (input: NewLectureInput) => Lecture;
  /** Create-or-update a resumable in-progress lecture (never lose partial work). */
  saveInProgressLecture: (input: NewLectureInput) => Lecture;
  updateLecture: (id: string, patch: Partial<Lecture>) => void;
  /** Soft-delete a lecture — moves it to Recently Deleted; does not destroy data. */
  deleteLecture: (id: string) => void;
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
};

const DataContext = createContext<DataContextValue | null>(null);

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

function mergeRemoteRecordingsIntoStore(
  localCourses: Course[],
  localLectures: Lecture[],
  remoteRows: RemoteRecordingRow[],
): { courses: Course[]; lectures: Lecture[]; restoredLectureCount: number; derivedCourseCount: number } {
  const coursesById = new Map(localCourses.map((course) => [course.id, course]));
  const coursesByName = new Map(localCourses.map((course) => [course.name.trim().toLowerCase(), course]));
  const remoteCourseIds = new Set<string>();

  for (const row of remoteRows) {
    const courseName = normalizedCourseName(row.course);
    const nameKey = courseName.toLowerCase();
    const existing = coursesByName.get(nameKey);
    if (existing) {
      remoteCourseIds.add(existing.id);
      continue;
    }

    const preset = choosePreset(coursesById.size);
    const course: Course = {
      id: stableIdFromName('cloud_course', courseName),
      name: courseName,
      icon: preset.icon,
      tint: preset.tint,
      accent: preset.accent,
      createdAt: row.created_at ?? new Date().toISOString(),
    };
    coursesById.set(course.id, course);
    coursesByName.set(nameKey, course);
    remoteCourseIds.add(course.id);
  }

  const lecturesByRemoteId = new Map<string, Lecture>();
  const localOnlyLectures: Lecture[] = [];
  for (const lecture of localLectures) {
    if (lecture.remoteRecordingId) {
      lecturesByRemoteId.set(lecture.remoteRecordingId, lecture);
    } else {
      localOnlyLectures.push(lecture);
    }
  }

  const mergedRemoteLectures = remoteRows.map((row) => {
    const local = lecturesByRemoteId.get(row.id);
    const courseName = normalizedCourseName(row.course);
    const course = coursesByName.get(courseName.toLowerCase());
    const processingStatus = processingStatusFromRemote(row.ai_status);
    const date = row.created_at ?? local?.date ?? new Date().toISOString();

    const transcript = keepLocalIfRemoteContentEmpty(row.transcript, local?.transcript);
    const transcriptZh = keepLocalIfRemoteContentEmpty(row.transcript_zh, local?.transcriptZh);
    const translatedTranscript = keepLocalIfRemoteContentEmpty(row.translated_transcript, local?.translatedTranscript);
    const summaryEn = keepLocalIfRemoteContentEmpty(row.summary_en, local?.summaryEn);
    const summaryZh = keepLocalIfRemoteContentEmpty(row.summary_zh, local?.summaryZh);
    const sourceSummary = keepLocalIfRemoteContentEmpty(row.source_summary, local?.sourceSummary);
    const translatedSummary = keepLocalIfRemoteContentEmpty(row.translated_summary, local?.translatedSummary);
    const liveTranscript = keepLocalIfRemoteContentEmpty(row.live_transcript, local?.liveTranscript);
    const translatedLiveTranscript = keepLocalIfRemoteContentEmpty(row.translated_live_transcript, local?.translatedLiveTranscript);

    // Title freshness: if the local lecture has been renamed more recently
    // than this remote row was updated, keep the local title — otherwise the
    // foreground refresh would revert a freshly-renamed lecture back to its
    // stale remote value before our async rename push has propagated.
    const remoteTitleTrim = row.title?.trim() ?? '';
    const localTitleTrim = local?.title?.trim() ?? '';
    const localTitleUpdatedAt = local?.titleUpdatedAt;
    const remoteUpdatedAt = row.updated_at;
    const preferLocalTitle =
      Boolean(localTitleTrim) &&
      Boolean(localTitleUpdatedAt) &&
      (!remoteUpdatedAt || localTitleUpdatedAt! > remoteUpdatedAt);
    const finalTitle = preferLocalTitle
      ? localTitleTrim
      : remoteTitleTrim || localTitleTrim || 'Untitled Lecture';

    return {
      id: local?.id ?? makeRemoteLectureId(row.id),
      courseId: course?.id ?? stableIdFromName('cloud_course', UNFILED_COURSE_NAME),
      title: finalTitle,
      titleUpdatedAt: localTitleUpdatedAt,
      date,
      durationMillis: parseDurationMillis(row.duration_sec) || local?.durationMillis || 0,
      localAudioUri: local?.localAudioUri ?? null,
      remoteRecordingId: row.id,
      uploadStatus: row.storage_path ? 'uploaded' : local?.uploadStatus ?? 'not_uploaded',
      storagePath: row.storage_path ?? local?.storagePath,
      uploadError: local?.uploadError,
      uploadedAt: row.updated_at ?? local?.uploadedAt,
      processingStatus,
      processingError: row.ai_error ?? local?.processingError,
      remoteAiStatus: row.ai_status ?? local?.remoteAiStatus,
      remoteAiError: row.ai_error ?? local?.remoteAiError,
      lastSyncedAt: new Date().toISOString(),
      markedTimestamps: local?.markedTimestamps ?? [],
      status: local?.status ?? 'local_recorded',
      transcript,
      transcriptZh,
      translatedTranscript,
      summaryEn,
      summaryZh,
      sourceSummary,
      translatedSummary,
      keyPoints: local?.keyPoints ?? [],
      liveTranscript,
      translatedLiveTranscript,
      sourceLanguage: row.source_language ?? local?.sourceLanguage ?? 'en',
      translationLanguage: row.translation_language ?? local?.translationLanguage ?? 'zh-Hans',
      notes: local?.notes ?? '',
      noteStrokes: local?.noteStrokes ?? [],
      noteUpdatedAt: local?.noteUpdatedAt,
      deletedAt: local?.deletedAt,
      deletedReason: local?.deletedReason,
    } satisfies Lecture;
  });

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
    derivedCourseCount: remoteCourseIds.size,
  };
}

export function DataProvider({ children }: { children: ReactNode }) {
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
  const hydrateSequence = useRef(0);
  const coursesRef = useRef<Course[]>([]);
  const lecturesRef = useRef<Lecture[]>([]);
  const materialsRef = useRef<CourseMaterial[]>([]);

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

      const remoteRows = await fetchRemoteRecordingsForUser(currentUserId);
      const merged = mergeRemoteRecordingsIntoStore(baseCourses, baseLectures, remoteRows);
      console.info('[store] remote recordings merged/restored', {
        userId: currentUserId,
        remoteRecordings: remoteRows.length,
        lecturesMerged: merged.restoredLectureCount,
        coursesDerived: merged.derivedCourseCount,
        cacheUpdated: true,
      });
      return { courses: merged.courses, lectures: merged.lectures };
    },
    [currentUserId],
  );

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

    if (!storageScopeId) {
      setHydratedUserId(null);
      setLoaded(true);
      return () => {
        mounted = false;
      };
    }

    (async () => {
      try {
        const [rawCourses, rawLectures, rawMaterials, rawMaterialLinks, rawMaterialAnnotations] = await Promise.all([
          AsyncStorage.getItem(scopedCoursesKey(storageScopeId)),
          AsyncStorage.getItem(scopedLecturesKey(storageScopeId)),
          AsyncStorage.getItem(scopedMaterialsKey(storageScopeId)),
          AsyncStorage.getItem(scopedMaterialLinksKey(storageScopeId)),
          AsyncStorage.getItem(scopedMaterialAnnotationsKey(storageScopeId)),
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
        let nextCourses = storedCourses;
        let nextLectures = normalizedLocalLectures;

        try {
          const merged = await applyRemoteRecordings(storedCourses, normalizedLocalLectures);
          nextCourses = merged.courses;
          nextLectures = merged.lectures;
        } catch {
          // Keep the user-scoped cache if cloud restore fails; RLS/network errors
          // are logged in fetchRemoteRecordingsForUser. Never fall back to global cache.
        }

        if (!mounted || hydrateSequence.current !== sequence) return;
        setCourses(nextCourses);
        setLectures(nextLectures);
        // Materials are local-only in V1.1 — no cloud merge yet.
        setMaterials(Array.isArray(storedMaterials) ? storedMaterials : []);
        setMaterialLinks(Array.isArray(storedMaterialLinks) ? storedMaterialLinks : []);
        setMaterialAnnotations(Array.isArray(storedMaterialAnnotations) ? storedMaterialAnnotations : []);
        setHydratedUserId(storageScopeId);
        setSelectedCourseId(nextCourses.find((course) => !course.deletedAt)?.id ?? null);
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
      void applyRemoteRecordings(coursesRef.current, lecturesRef.current)
        .then((merged) => {
          if (hydrateSequence.current <= 0) return;
          setCourses(merged.courses);
          setLectures(merged.lectures);
          setSelectedCourseId((current) =>
            current && merged.courses.some((course) => course.id === current && !course.deletedAt)
              ? current
              : merged.courses.find((course) => !course.deletedAt)?.id ?? null,
          );
        })
        .catch(() => {
          // Already logged by fetchRemoteRecordingsForUser; keep current cache.
        });
    });

    return () => subscription.remove();
  }, [applyRemoteRecordings, currentUserId, hydratedUserId, loaded]);

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
    const course: Course = {
      id: makeId('course'),
      name: input.name,
      icon: input.icon,
      tint: input.tint,
      accent: input.accent,
      createdAt: new Date().toISOString(),
    };
    setCourses((prev) => [...prev, course]);
    setSelectedCourseId(course.id);
    return course;
  }, []);

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

  const updateLecture = useCallback((id: string, patch: Partial<Lecture>) => {
    setLectures((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

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

    // Update the local course name immediately (also persisted to the per-user
    // AsyncStorage cache via the effect that watches `courses`).
    setCourses((prev) => prev.map((c) => (c.id === courseId ? { ...c, name: trimmed } : c)));

    // Persist to the backend. A course is NOT its own table — its name lives on the
    // `course` column of each recording, and the cloud merge rebuilds courses by
    // grouping recordings by that name on every hydrate (sign-in / launch) and
    // foreground refresh. Without this push a rename only changes local state, so
    // signing out and back in (which reloads from the backend) reverts the course to
    // its stale remote name. Update every cloud-backed lecture in this course; RLS
    // plus an explicit user_id filter scope the write to the current user. Fire-and-
    // forget, mirroring renameLecture: a failure is logged and the local name stands.
    const remoteIds = lecturesRef.current
      .filter((l) => l.courseId === courseId && l.remoteRecordingId)
      .map((l) => l.remoteRecordingId as string);
    if (remoteIds.length > 0 && currentUserId) {
      const now = new Date().toISOString();
      void supabase
        .from('recordings')
        .update({ course: trimmed, updated_at: now })
        .in('id', remoteIds)
        .eq('user_id', currentUserId)
        .then(({ error }) => {
          if (error) {
            console.warn('[store] remote course rename failed (kept local)', {
              courseId,
              message: error.message,
            });
          }
        });
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

    // Cloud-backed lecture: push the title to public.recordings so other
    // devices and a future restore both reflect the rename. RLS scopes the
    // update to the current user; we also constrain by user_id explicitly
    // as defense in depth. Fire-and-forget: if it fails the local title +
    // titleUpdatedAt still win the next merge until the push succeeds.
    if (remoteId && currentUserId) {
      void supabase
        .from('recordings')
        .update({ title: trimmed, updated_at: now })
        .eq('id', remoteId)
        .eq('user_id', currentUserId)
        .then(({ error }) => {
          if (error) {
            console.warn('[store] remote lecture rename failed (kept local)', {
              lectureId,
              message: error.message,
            });
          }
        });
    }
  }, [currentUserId]);

  // Deleting moves an item to Recently Deleted (soft delete) — data is never
  // destroyed here. permanentlyDelete* below is the only path that removes data.
  const deleteLecture = useCallback((id: string) => {
    const now = new Date().toISOString();
    setLectures((prev) =>
      prev.map((l) => (l.id === id ? { ...l, deletedAt: now, deletedReason: 'manual' } : l)),
    );
  }, []);

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
      setCourses((prev) =>
        prev.map((c) => (c.id === id ? { ...c, deletedAt: now, deletedReason: 'manual' } : c)),
      );
      setSelectedCourseId((current) => (current === id ? null : current));
      return { ok: true };
    },
    [lectures],
  );

  const restoreCourse = useCallback((id: string) => {
    setCourses((prev) =>
      prev.map((c) => (c.id === id ? { ...c, deletedAt: null, deletedReason: null } : c)),
    );
  }, []);

  const restoreLecture = useCallback(
    (id: string) => {
      const target = lectures.find((l) => l.id === id);
      setLectures((prev) =>
        prev.map((l) => (l.id === id ? { ...l, deletedAt: null, deletedReason: null } : l)),
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
      }
    },
    [lectures],
  );

  const permanentlyDeleteCourse = useCallback((id: string) => {
    setCourses((prev) => prev.filter((course) => course.id !== id));
    setLectures((prev) => prev.filter((lecture) => lecture.courseId !== id));
    setSelectedCourseId((current) => (current === id ? null : current));
  }, []);

  const permanentlyDeleteLecture = useCallback((id: string) => {
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
      deletedCourses,
      deletedLectures,
      selectedCourseId: visibleStoreReady ? selectedCourseId : null,
      setSelectedCourseId,
      createCourse,
      createLecture,
      saveInProgressLecture,
      updateLecture,
      deleteLecture,
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
      countAnnotationsForMaterial: (materialId) =>
        activeMaterialAnnotations
          .filter((annotation) => annotation.materialId === materialId)
          .reduce((total, annotation) => total + annotation.strokes.length, 0),
      saveAnnotationStrokes,
      replaceMaterialPageAnnotationStrokes: saveAnnotationStrokes,
      replaceMaterialPageAnnotationStrokesForMaterial,
      addAnnotationStroke,
      undoLastAnnotationStroke,
      clearAnnotationsForPage,
      clearAll,
    }),
    [visibleStoreReady, currentUserId, activeCourses, activeLectures, deletedCourses, deletedLectures, selectedCourseId, createCourse, createLecture, saveInProgressLecture, updateLecture, deleteLecture, deleteCourse, restoreCourse, restoreLecture, permanentlyDeleteCourse, permanentlyDeleteLecture, renameCourse, renameLecture, activeMaterials, addMaterial, renameMaterial, updateMaterial, deleteMaterial, activeMaterialLinks, reserveLectureId, linkMaterialToLecture, updateLectureMaterialLink, removeLectureMaterialLink, cleanupOrphanMaterialLinks, activeMaterialAnnotations, saveAnnotationStrokes, replaceMaterialPageAnnotationStrokesForMaterial, addAnnotationStroke, undoLastAnnotationStroke, clearAnnotationsForPage, clearAll],
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
