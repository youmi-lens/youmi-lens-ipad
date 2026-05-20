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
import { COURSE_PRESETS, type Course, type Lecture, type NoteStroke } from './models';
import { supabase } from './supabase';

// Legacy global keys from pre-account-isolation builds. Deliberately never
// loaded now because they have no trustworthy owner user id.
const LEGACY_COURSES_KEY = 'youmi.courses.v1';
const LEGACY_LECTURES_KEY = 'youmi.lectures.v1';
const scopedCoursesKey = (userId: string) => `youmi.courses.v1.${userId}`;
const scopedLecturesKey = (userId: string) => `youmi.lectures.v1.${userId}`;
const UNFILED_COURSE_NAME = 'Unfiled';
const REMOTE_RECORDING_COLUMNS =
  'id, user_id, course, title, duration_sec, ai_status, ai_error, created_at, storage_path, transcript, transcript_zh, summary_en, summary_zh, live_transcript';
const REMOTE_RECORDING_COLUMNS_LEGACY =
  'id, user_id, course, title, duration_sec, ai_status, ai_error, created_at, storage_path, transcript, summary_en, summary_zh, live_transcript';

export type NewCourseInput = {
  name: string;
  icon: string;
  tint: string;
  accent: string;
};

export type NewLectureInput = {
  courseId: string;
  title: string;
  durationMillis: number;
  localAudioUri: string | null;
  markedTimestamps: number[];
  liveTranscript?: string;
  /** Typed notes captured during recording (Mini Workspace). */
  notes?: string;
  /** Handwritten strokes captured during recording (Mini Workspace). */
  noteStrokes?: NoteStroke[];
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
  updated_at: string | null;
  storage_path: string | null;
  transcript: string | null;
  transcript_zh?: string | null;
  summary_en: string | null;
  summary_zh: string | null;
  live_transcript: string | null;
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

function keepLocalIfRemoteMissing(remoteValue: string | null | undefined, localValue: string | undefined): string {
  return remoteValue ?? localValue ?? '';
}

function makeUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
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

  if (error && /transcript_zh|updated_at/i.test(error.message)) {
    const legacy = await supabase
      .from('recordings')
      .select(REMOTE_RECORDING_COLUMNS_LEGACY)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    data = legacy.data;
    error = legacy.error;
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

    const transcript = keepLocalIfRemoteMissing(row.transcript, local?.transcript);
    const transcriptZh = keepLocalIfRemoteMissing(row.transcript_zh, local?.transcriptZh);
    const summaryEn = keepLocalIfRemoteMissing(row.summary_en, local?.summaryEn);
    const summaryZh = keepLocalIfRemoteMissing(row.summary_zh, local?.summaryZh);
    const liveTranscript = keepLocalIfRemoteMissing(row.live_transcript, local?.liveTranscript);

    return {
      id: local?.id ?? makeRemoteLectureId(row.id),
      courseId: course?.id ?? stableIdFromName('cloud_course', UNFILED_COURSE_NAME),
      title: row.title?.trim() || local?.title || 'Untitled Lecture',
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
      summaryEn,
      summaryZh,
      keyPoints: local?.keyPoints ?? [],
      liveTranscript,
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
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  const [loaded, setLoaded] = useState(false);
  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const hydrateSequence = useRef(0);
  const coursesRef = useRef<Course[]>([]);
  const lecturesRef = useRef<Lecture[]>([]);

  useEffect(() => {
    coursesRef.current = courses;
  }, [courses]);

  useEffect(() => {
    lecturesRef.current = lectures;
  }, [lectures]);

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
    setSelectedCourseId(null);

    if (!currentUserId) {
      setHydratedUserId(null);
      setLoaded(true);
      return () => {
        mounted = false;
      };
    }

    (async () => {
      try {
        const [rawCourses, rawLectures] = await Promise.all([
          AsyncStorage.getItem(scopedCoursesKey(currentUserId)),
          AsyncStorage.getItem(scopedLecturesKey(currentUserId)),
        ]);
        if (!mounted || hydrateSequence.current !== sequence) return;
        const storedCourses: Course[] = rawCourses ? JSON.parse(rawCourses) : [];
        const storedLectures: Lecture[] = rawLectures ? JSON.parse(rawLectures) : [];
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
        setHydratedUserId(currentUserId);
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
  }, [applyRemoteRecordings, currentUserId]);


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

  // Persist only after the current user's scoped store is loaded. Legacy global
  // keys remain intentionally ignored; they cannot safely be attributed.
  useEffect(() => {
    if (loaded && currentUserId && hydratedUserId === currentUserId) {
      AsyncStorage.setItem(scopedCoursesKey(currentUserId), JSON.stringify(courses)).catch(() => {});
    }
  }, [courses, currentUserId, hydratedUserId, loaded]);

  useEffect(() => {
    if (loaded && currentUserId && hydratedUserId === currentUserId) {
      AsyncStorage.setItem(scopedLecturesKey(currentUserId), JSON.stringify(lectures)).catch(() => {});
    }
  }, [lectures, currentUserId, hydratedUserId, loaded]);

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
      id: makeId('lecture'),
      courseId: input.courseId,
      title: input.title,
      date: new Date().toISOString(),
      durationMillis: input.durationMillis,
      localAudioUri: input.localAudioUri,
      remoteRecordingId: makeUuid(),
      uploadStatus: 'not_uploaded',
      processingStatus: 'not_started',
      markedTimestamps: input.markedTimestamps,
      status: 'local_recorded',
      transcript: '',
      summaryEn: '',
      summaryZh: '',
      keyPoints: [],
      liveTranscript: input.liveTranscript ?? '',
      notes: input.notes ?? '',
      noteStrokes: input.noteStrokes ?? [],
      noteUpdatedAt:
        (input.notes && input.notes.length > 0) ||
        (input.noteStrokes && input.noteStrokes.length > 0)
          ? new Date().toISOString()
          : undefined,
    };
    setLectures((prev) => [...prev, lecture]);
    return lecture;
  }, []);

  const updateLecture = useCallback((id: string, patch: Partial<Lecture>) => {
    setLectures((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  const renameCourse = useCallback((courseId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCourses((prev) => prev.map((c) => (c.id === courseId ? { ...c, name: trimmed } : c)));
  }, []);

  const renameLecture = useCallback((lectureId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setLectures((prev) => prev.map((l) => (l.id === lectureId ? { ...l, title: trimmed } : l)));
  }, []);

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

  const clearAll = useCallback(async () => {
    setCourses([]);
    setLectures([]);
    setSelectedCourseId(null);
    if (currentUserId) {
      await AsyncStorage.multiRemove([
        scopedCoursesKey(currentUserId),
        scopedLecturesKey(currentUserId),
      ]).catch(() => {});
    }
  }, [currentUserId]);

  const visibleStoreReady = loaded && hydratedUserId === currentUserId;
  const visibleCourses = visibleStoreReady ? courses : [];
  const visibleLectures = visibleStoreReady ? lectures : [];

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
      clearAll,
    }),
    [visibleStoreReady, currentUserId, activeCourses, activeLectures, deletedCourses, deletedLectures, selectedCourseId, createCourse, createLecture, updateLecture, deleteLecture, deleteCourse, restoreCourse, restoreLecture, permanentlyDeleteCourse, permanentlyDeleteLecture, renameCourse, renameLecture, clearAll],
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
