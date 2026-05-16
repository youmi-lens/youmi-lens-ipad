/**
 * Local data store for Youmi Lens for iPad.
 *
 * Holds the user's courses and lectures in React state, persisted to the
 * device with AsyncStorage. No network, no backend — everything is local.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type { Course, Lecture } from './models';

const COURSES_KEY = 'youmi.courses.v1';
const LECTURES_KEY = 'youmi.lectures.v1';

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
};

type DataContextValue = {
  /** True once the store has hydrated from device storage. */
  loaded: boolean;
  courses: Course[];
  lectures: Lecture[];
  /** The course currently selected on the Record Home screen. */
  selectedCourseId: string | null;
  setSelectedCourseId: (id: string | null) => void;
  createCourse: (input: NewCourseInput) => Course;
  createLecture: (input: NewLectureInput) => Lecture;
  updateLecture: (id: string, patch: Partial<Lecture>) => void;
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

export function DataProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);

  // Hydrate from device storage once on mount.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [rawCourses, rawLectures] = await Promise.all([
          AsyncStorage.getItem(COURSES_KEY),
          AsyncStorage.getItem(LECTURES_KEY),
        ]);
        if (!mounted) return;
        const storedCourses: Course[] = rawCourses ? JSON.parse(rawCourses) : [];
        const storedLectures: Lecture[] = rawLectures ? JSON.parse(rawLectures) : [];
        const hydratedLectures = storedLectures.map((lecture) => ({
          ...lecture,
          remoteRecordingId: lecture.remoteRecordingId ?? makeUuid(),
          uploadStatus: lecture.uploadStatus ?? 'not_uploaded',
          processingStatus: lecture.processingStatus ?? 'not_started',
          transcript: typeof lecture.transcript === 'string' ? lecture.transcript : '',
          liveTranscript: lecture.liveTranscript ?? '',
        }));
        setCourses(storedCourses);
        setLectures(hydratedLectures);
        setSelectedCourseId(storedCourses[0]?.id ?? null);
      } catch {
        // Corrupt or missing data — start from an empty state.
      } finally {
        if (mounted) setLoaded(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Persist whenever courses or lectures change (after the initial hydrate).
  useEffect(() => {
    if (loaded) AsyncStorage.setItem(COURSES_KEY, JSON.stringify(courses)).catch(() => {});
  }, [courses, loaded]);

  useEffect(() => {
    if (loaded) AsyncStorage.setItem(LECTURES_KEY, JSON.stringify(lectures)).catch(() => {});
  }, [lectures, loaded]);

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
      notes: '',
    };
    setLectures((prev) => [...prev, lecture]);
    return lecture;
  }, []);

  const updateLecture = useCallback((id: string, patch: Partial<Lecture>) => {
    setLectures((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  const clearAll = useCallback(async () => {
    setCourses([]);
    setLectures([]);
    setSelectedCourseId(null);
    await AsyncStorage.multiRemove([COURSES_KEY, LECTURES_KEY]).catch(() => {});
  }, []);

  const value = useMemo<DataContextValue>(
    () => ({
      loaded,
      courses,
      lectures,
      selectedCourseId,
      setSelectedCourseId,
      createCourse,
      createLecture,
      updateLecture,
      getCourse: (id) => courses.find((c) => c.id === id),
      getLecture: (id) => lectures.find((l) => l.id === id),
      lecturesForCourse: (courseId) => lectures.filter((l) => l.courseId === courseId),
      clearAll,
    }),
    [loaded, courses, lectures, selectedCourseId, createCourse, createLecture, updateLecture, clearAll],
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
