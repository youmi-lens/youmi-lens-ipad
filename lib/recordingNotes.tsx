/**
 * Recording-draft state — notes and important marks.
 *
 * While a lecture is being recorded there is no Lecture object yet, so the
 * notes the user writes/types in Mini Workspace, and the "important moment"
 * marks they tap (on the recording screen or in Mini Workspace), are held here
 * in memory. When recording finishes, the recording screen reads this draft
 * and saves it into the newly created lecture, then clears it.
 *
 * This context lives above the recording + mini-caption screens so the draft
 * survives navigating between them. Nothing here is persisted to disk.
 */
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
import type { NoteImage, NoteStroke } from './models';

/** One "important moment" mark captured during recording. */
export type RecordingMark = {
  id: string;
  /** Offset into the recording, in milliseconds. */
  timestampMillis: number;
  /** ISO timestamp of when the mark was created. */
  createdAt: string;
  /** Optional short label — reserved for future use; unset in V1. */
  label?: string;
};

type RecordingNotesValue = {
  /** Typed notes for the in-progress recording. */
  draftNotes: string;
  /** Handwritten strokes for the in-progress recording. */
  draftStrokes: NoteStroke[];
  /** Image objects placed on the notebook page during recording. */
  draftImages: NoteImage[];
  setDraftNotes: (text: string) => void;
  setDraftStrokes: (strokes: NoteStroke[]) => void;
  setDraftImages: (images: NoteImage[]) => void;
  /** Important-moment marks for the in-progress recording. */
  marks: RecordingMark[];
  /** Authoritative recorder clock mirrored from the Recording screen. */
  currentDurationMillis: number;
  setCurrentDurationMillis: (durationMillis: number) => void;
  /** Whether the shared lecture session is paused. */
  isLectureSessionPaused: boolean;
  setLectureSessionPaused: (paused: boolean) => void;
  /**
   * True while the Recording screen has registered an authoritative pause toggle
   * (active record/pause session). Playback must not steal the audio session.
   */
  isLectureSessionActive: boolean;
  /**
   * Authoritative Pause/Resume toggle registered by the Recording screen.
   * Mini / Course must call this — never flip local UI-only pause state.
   */
  registerLectureSessionPauseToggle: (handler: (() => Promise<void>) | null) => void;
  toggleLectureSessionPause: () => Promise<void>;
  /** Add an important-moment mark in the canonical millisecond unit. */
  addMarkMillis: (timestampMillis: number, label?: string) => void;
  /** Add a mark at the latest mirrored recorder time. */
  addMarkAtCurrentTime: (label?: string) => void;
  /** Clear only marks, keeping in-progress notes intact. */
  clearMarks: () => void;
  /** Clear the draft — called when a new recording starts and after Finish. */
  resetDraft: () => void;
  /** Load a persisted draft when reopening an in-progress lecture. */
  hydrateDraft: (draft: {
    notes?: string;
    strokes?: NoteStroke[];
    images?: NoteImage[];
  }) => void;
};

const RecordingNotesContext = createContext<RecordingNotesValue | null>(null);

function makeMarkId(): string {
  return `mark_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function RecordingNotesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const previousUserId = useRef<string | null>(null);
  const [draftNotes, setDraftNotes] = useState('');
  const [draftStrokes, setDraftStrokes] = useState<NoteStroke[]>([]);
  const [draftImages, setDraftImages] = useState<NoteImage[]>([]);
  const [marks, setMarks] = useState<RecordingMark[]>([]);
  const [currentDurationMillis, setCurrentDurationMillisState] = useState(0);
  const [isLectureSessionPaused, setLectureSessionPaused] = useState(false);
  const [isLectureSessionActive, setLectureSessionActive] = useState(false);
  const lectureSessionPauseToggleRef = useRef<(() => Promise<void>) | null>(null);

  const registerLectureSessionPauseToggle = useCallback((handler: (() => Promise<void>) | null) => {
    lectureSessionPauseToggleRef.current = handler;
    setLectureSessionActive(Boolean(handler));
  }, []);

  const toggleLectureSessionPause = useCallback(async () => {
    const handler = lectureSessionPauseToggleRef.current;
    if (!handler) return;
    await handler();
  }, []);

  const setCurrentDurationMillis = useCallback((durationMillis: number) => {
    setCurrentDurationMillisState(Math.max(0, Math.round(durationMillis)));
  }, []);

  const addMarkMillis = useCallback((timestampMillis: number, label?: string) => {
    setMarks((prev) => [
      ...prev,
      {
        id: makeMarkId(),
        timestampMillis: Math.max(0, Math.round(timestampMillis)),
        createdAt: new Date().toISOString(),
        label,
      },
    ]);
  }, []);

  const addMarkAtCurrentTime = useCallback(
    (label?: string) => addMarkMillis(currentDurationMillis, label),
    [addMarkMillis, currentDurationMillis],
  );

  const clearMarks = useCallback(() => setMarks([]), []);

  const resetDraft = useCallback(() => {
    setDraftNotes('');
    setDraftStrokes([]);
    setDraftImages([]);
    setMarks([]);
    setCurrentDurationMillisState(0);
    setLectureSessionPaused(false);
  }, []);

  const hydrateDraft = useCallback(
    (draft: { notes?: string; strokes?: NoteStroke[]; images?: NoteImage[] }) => {
      setDraftNotes(draft.notes ?? '');
      setDraftStrokes(draft.strokes ?? []);
      setDraftImages(draft.images ?? []);
      setMarks([]);
      setCurrentDurationMillisState(0);
      setLectureSessionPaused(true);
    },
    [],
  );

  useEffect(() => {
    const nextUserId = user?.id ?? null;
    if (previousUserId.current !== nextUserId) {
      resetDraft();
      previousUserId.current = nextUserId;
    }
  }, [resetDraft, user?.id]);

  const value = useMemo<RecordingNotesValue>(
    () => ({
      draftNotes,
      draftStrokes,
      draftImages,
      setDraftNotes,
      setDraftStrokes,
      setDraftImages,
      marks,
      currentDurationMillis,
      setCurrentDurationMillis,
      isLectureSessionPaused,
      setLectureSessionPaused,
      isLectureSessionActive,
      registerLectureSessionPauseToggle,
      toggleLectureSessionPause,
      addMarkMillis,
      addMarkAtCurrentTime,
      clearMarks,
      resetDraft,
      hydrateDraft,
    }),
    [
      draftNotes,
      draftStrokes,
      draftImages,
      marks,
      currentDurationMillis,
      setCurrentDurationMillis,
      isLectureSessionPaused,
      isLectureSessionActive,
      registerLectureSessionPauseToggle,
      toggleLectureSessionPause,
      addMarkMillis,
      addMarkAtCurrentTime,
      clearMarks,
      resetDraft,
      hydrateDraft,
    ],
  );

  return (
    <RecordingNotesContext.Provider value={value}>
      {children}
    </RecordingNotesContext.Provider>
  );
}

/** Access the in-progress recording's draft notes and marks. */
export function useRecordingNotes(): RecordingNotesValue {
  const ctx = useContext(RecordingNotesContext);
  if (!ctx) {
    throw new Error('useRecordingNotes must be used within a RecordingNotesProvider');
  }
  return ctx;
}
