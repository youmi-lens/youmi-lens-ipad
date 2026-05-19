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

import { useAuth } from './auth';
import type { Course, Lecture, NoteStroke } from './models';

// Legacy global keys from pre-account-isolation builds. Deliberately never
// loaded now because they have no trustworthy owner user id.
const LEGACY_COURSES_KEY = 'youmi.courses.v1';
const LEGACY_LECTURES_KEY = 'youmi.lectures.v1';
const scopedCoursesKey = (userId: string) => `youmi.courses.v1.${userId}`;
const scopedLecturesKey = (userId: string) => `youmi.lectures.v1.${userId}`;

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

const DataContext = createContext<DataContextValue | null>(null);

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
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

export function DataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  const [loaded, setLoaded] = useState(false);
  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const hydrateSequence = useRef(0);

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
        setCourses(storedCourses);
        setLectures(normalizeLectures(storedLectures));
        setHydratedUserId(currentUserId);
        setSelectedCourseId(storedCourses.find((course) => !course.deletedAt)?.id ?? null);
      } catch {
        // Corrupt or missing user-scoped data — start from an empty state.
      } finally {
        if (mounted && hydrateSequence.current === sequence) setLoaded(true);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [currentUserId]);

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
