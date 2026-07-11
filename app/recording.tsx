import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { CaptionHistoryFeed } from '@/components/CaptionHistoryFeed';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { StatusPill } from '@/components/StatusPill';
import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { formatClock } from '@/lib/format';
import { useT, localizeSystemDefaultTitle } from '@/lib/i18n';
import { useWordLookupHint } from '@/lib/wordLookupHint';
import { GUEST_MAX_RECORDING_SECONDS, incrementGuestRecordingsUsed } from '@/lib/guest';
import { pickAndImportPdf } from '@/lib/importMaterial';
import { logLiveCaptionEvent, logLiveCaptionUnavailable } from '@/lib/liveCaptionDiagnostics';
import type { PersistedCaptionLine } from '@/lib/models';
import { useLiveCaptions } from '@/lib/liveCaptions';
import { getLiveMicStreamStatus, startMicStream, stopMicStream } from '@/lib/liveMicStream';
import { useRecordingNotes } from '@/lib/recordingNotes';
import { useData } from '@/lib/store';
import { useLectureRecorder } from '@/lib/useLectureRecorder';
import { resolveCaptionAreaState, recordingControlsEnabled } from '@/lib/lectureStartupState.mjs';
import {
  captionsToTranscript,
  hasMeaningfulRecordingContent,
} from '@/lib/recordingPersistence.mjs';

/** Calm, user-facing line shown when live captions cannot run. Diagnostics stay in the console. */
const LIVE_CAPTIONS_UNAVAILABLE_MESSAGE = 'Live captions unavailable. Audio recording is still active.';

export default function RecordingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ courseId?: string; lectureTitle?: string; lectureId?: string }>();
  const { isGuest, exitGuest } = useAuth();
  const {
    getCourse,
    createLecture,
    saveInProgressLecture,
    updateLecture,
    getLecture,
    currentUserId,
    lectures,
    materialsForCourse,
    addMaterial,
    reserveLectureId,
    linkMaterialToLecture,
    materialLinksForLecture,
    materialAnnotations,
    cleanupOrphanMaterialLinks,
  } = useData();
  const {
    draftNotes,
    draftStrokes,
    draftImages,
    marks,
    addMarkMillis,
    setCurrentDurationMillis,
    setLectureSessionPaused,
    resetDraft,
    hydrateDraft,
  } = useRecordingNotes();
  // Resume mode: reopening an in-progress lecture reuses its id + saved history.
  // Snapshot it once so course/title/prior-content come from the lecture, not
  // just the launch params. `getLecture` reflects live store updates, but we
  // only read identity/course/title here; the mount snapshot is held in refs.
  const resumeLectureId = (params.lectureId ?? '').trim() || null;
  const resumeLecture = resumeLectureId ? getLecture(resumeLectureId) : undefined;
  const isResume = Boolean(resumeLecture);
  const course = getCourse(resumeLecture?.courseId ?? params.courseId);
  const courseName = course?.name ?? 'Lecture';

  const {
    permissionChecked,
    permissionStatus,
    isRecording,
    isPaused,
    durationMillis,
    error,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
  } = useLectureRecorder();

  const {
    status: liveCaptionStatus,
    error: liveCaptionError,
    latestCaption,
    partialCaption,
    partialTranslationZh,
    captionLines,
    latestFinalLine,
    startLiveCaptions,
    stopLiveCaptions,
    resetCaptions,
    sendAudioChunk,
  } = useLiveCaptions();

  const [micStreamError, setMicStreamError] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [materialPickerVisible, setMaterialPickerVisible] = useState(false);
  const [importingMaterial, setImportingMaterial] = useState(false);
  // Reopening an in-progress lecture starts in a REVIEW state: prior captions
  // are shown but the recorder/mic/live captions do NOT start until the user
  // resumes from the existing central Pause/Continue control.
  const [continueRequested, setContinueRequested] = useState(false);
  const isReviewingResume = isResume && !continueRequested;
  // New content APPENDS to the resumed lecture's id (no duplicate); a fresh
  // recording reserves a new id. Prior caption history / marks / audio are
  // snapshotted once at mount so we can merge new content onto them.
  const [pendingLectureId] = useState(() => resumeLecture?.id ?? reserveLectureId());
  const priorCaptionLinesRef = useRef<PersistedCaptionLine[]>(resumeLecture?.liveCaptionLines ?? []);
  const priorMarksRef = useRef<number[]>(resumeLecture?.markedTimestamps ?? []);
  const priorAudioUriRef = useRef<string | null>(resumeLecture?.localAudioUri ?? null);
  const resumeDraftRef = useRef({
    notes: resumeLecture?.notes,
    strokes: resumeLecture?.noteStrokes,
    images: resumeLecture?.noteImages,
  });
  const progressCreatedRef = useRef(isResume);
  const lastProgressSaveRef = useRef(0);
  const toast = useRef(new Animated.Value(0)).current;
  const autoStarted = useRef(false);
  const isRecordingRef = useRef(false);
  const firstPcmFrameLoggedRef = useRef(false);
  const recoverCaptionsRef = useRef<() => void>(() => {});
  const finishedRef = useRef(false);
  const guestAutoStopped = useRef(false);
  const lecturesRef = useRef(lectures);
  const draftNotesRef = useRef(draftNotes);
  const draftStrokesRef = useRef(draftStrokes);
  const draftImagesRef = useRef(draftImages);
  const materialLinksForLectureRef = useRef(materialLinksForLecture);
  const materialAnnotationsRef = useRef(materialAnnotations);

  const granted = permissionStatus === 'granted';
  const sessionDurationMillis = isResume
    ? (resumeLecture?.durationMillis ?? 0) + (isReviewingResume ? 0 : durationMillis)
    : durationMillis;
  const seconds = Math.floor(sessionDurationMillis / 1000);
  const recordingSessionActive = isRecording || isPaused || durationMillis > 0;
  // Reliable "audio is genuinely capturing" signal — the recorder's own state,
  // not just permission. Controls and caption copy derive from this so the UI
  // never claims recording is active when startup failed.
  const audioActive = isRecording || isPaused;
  const controlsEnabled = recordingControlsEnabled(audioActive);
  const centralControlEnabled = isReviewingResume || controlsEnabled;
  const latestFinalEnglish = latestFinalLine?.text ?? captionLines[captionLines.length - 1]?.text ?? '';
  const visibleEnglishCaption = partialCaption || latestFinalEnglish || latestCaption;
  const captionAreaState = resolveCaptionAreaState({
    audioActive,
    startFailed,
    micStreamError: Boolean(micStreamError),
    hasCaptionContent:
      liveCaptionStatus === 'active' || liveCaptionStatus === 'listening' || Boolean(visibleEnglishCaption),
    captionsConnecting: liveCaptionStatus === 'connecting',
  });
  const courseMaterials = course ? materialsForCourse(course.id) : [];

  // Subtle one-time hint for double-tap word lookup, shown only while English
  // captions are on screen (same condition the caption feed renders under).
  const t = useT();
  const captionsVisibleForHint = !isGuest && (captionAreaState === 'captions_visible' || isReviewingResume);
  const showWordLookupHint = useWordLookupHint(captionsVisibleForHint);

  // ---- Resumable persistence: prior history + live session merged together ----
  // The caption feed and every save read the SAME merged source, so reopening a
  // lecture shows old + new content and continuing appends to one lecture.
  const priorFinalizedAsLive = priorCaptionLinesRef.current.map((line) => ({
    id: line.id,
    text: line.text,
    translationZh: line.translationZh,
    isFinal: true,
    createdAt: '',
  }));
  const priorIds = new Set(priorFinalizedAsLive.map((line) => line.id));
  const feedLines = [...priorFinalizedAsLive, ...captionLines.filter((line) => !priorIds.has(line.id))];

  // Session-stable identity/labels + fresh refs so save callbacks never read
  // stale closures.
  const sessionCourseIdRef = useRef(resumeLecture?.courseId ?? params.courseId ?? '');
  const sessionTitleRef = useRef(
    (resumeLecture?.title ?? (params.lectureTitle ?? '').trim()) || 'Untitled Lecture',
  );
  const feedLinesRef = useRef(feedLines);
  feedLinesRef.current = feedLines;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  draftNotesRef.current = draftNotes;
  draftStrokesRef.current = draftStrokes;
  draftImagesRef.current = draftImages;
  materialLinksForLectureRef.current = materialLinksForLecture;
  materialAnnotationsRef.current = materialAnnotations;
  const durationRef = useRef(durationMillis);
  durationRef.current = sessionDurationMillis;

  // Persist (create-or-update) the in-progress lecture from current content.
  // Returns true when something was saved. Signed-in only — guest recordings
  // keep their existing local-only, save-on-finish flow.
  const persistProgress = useCallback(
    (audioUri?: string | null): boolean => {
      if (isGuest) return false;
      const lines: PersistedCaptionLine[] = feedLinesRef.current.map((line) => ({
        id: line.id,
        text: line.text,
        translationZh: line.translationZh,
      }));
      const { en, zh } = captionsToTranscript(lines);
      const mergedMarks = [
        ...priorMarksRef.current,
        ...marksRef.current.map((mark) => mark.timestampMillis),
      ];
      const nextAudio = audioUri ?? priorAudioUriRef.current;
      const currentLinks = materialLinksForLectureRef.current(pendingLectureId);
      const currentAnnotations = materialAnnotationsRef.current.filter(
        (annotation) => annotation.lectureId === pendingLectureId && !annotation.deletedAt,
      );
      const meaningful = hasMeaningfulRecordingContent({
        durationMillis: durationRef.current,
        hasAudio: Boolean(nextAudio),
        captionCount: lines.length,
        markCount: mergedMarks.length,
        transcriptLength: en.length,
        notesLength: draftNotesRef.current.trim().length,
        strokeCount: draftStrokesRef.current.length,
        imageCount: draftImagesRef.current.length,
        materialLinkCount: currentLinks.length,
        materialAnnotationCount: currentAnnotations.reduce(
          (count, annotation) => count + annotation.strokes.length,
          0,
        ),
      });
      if (!meaningful) return false;
      saveInProgressLecture({
        id: pendingLectureId,
        courseId: sessionCourseIdRef.current,
        title: sessionTitleRef.current,
        durationMillis: durationRef.current,
        localAudioUri: nextAudio,
        markedTimestamps: mergedMarks,
        liveTranscript: en,
        liveTranscriptZh: zh,
        liveCaptionLines: lines,
        notes: draftNotesRef.current,
        noteStrokes: draftStrokesRef.current,
        noteImages: draftImagesRef.current,
      });
      if (nextAudio) priorAudioUriRef.current = nextAudio;
      progressCreatedRef.current = true;
      lastProgressSaveRef.current = Date.now();
      return true;
    },
    [isGuest, pendingLectureId, saveInProgressLecture],
  );
  const persistProgressRef = useRef(persistProgress);
  persistProgressRef.current = persistProgress;

  // Autosave: create the lecture as soon as meaningful content appears (so it
  // survives an app kill), then refresh it at most every 5s while recording.
  useEffect(() => {
    if (isGuest || finishedRef.current) return;
    // In the resumed-review state nothing new is being captured yet, and the
    // lecture is already persisted — don't rewrite it until recording continues.
    if (isReviewingResume) return;
    if (
      !hasMeaningfulRecordingContent({
        durationMillis: sessionDurationMillis,
        captionCount: feedLines.length,
        markCount: marks.length,
        notesLength: draftNotes.trim().length,
        strokeCount: draftStrokes.length,
        imageCount: draftImages.length,
        materialLinkCount: materialLinksForLecture(pendingLectureId).length,
        materialAnnotationCount: materialAnnotations
          .filter((annotation) => annotation.lectureId === pendingLectureId && !annotation.deletedAt)
          .reduce((count, annotation) => count + annotation.strokes.length, 0),
      })
    ) {
      return;
    }
    if (!progressCreatedRef.current || Date.now() - lastProgressSaveRef.current > 5000) {
      persistProgress();
    }
  }, [
    captionLines.length,
    marks.length,
    durationMillis,
    sessionDurationMillis,
    feedLines.length,
    draftNotes,
    draftStrokes.length,
    draftImages.length,
    materialLinksForLecture,
    materialAnnotations,
    pendingLectureId,
    isGuest,
    isReviewingResume,
    persistProgress,
  ]);

  // Never lose work when the screen is torn down (Back gesture, navigation away).
  useEffect(
    () => () => {
      if (!finishedRef.current) persistProgressRef.current();
    },
    [],
  );

  useEffect(() => {
    lecturesRef.current = lectures;
  }, [lectures]);

  // Start live captions, then the live PCM mic stream. The local lecture
  // recorder is already running by this point (recorder-first order), so the
  // mic stream configures the iOS audio session and attaches its tap last.
  // The no-PCM watchdog and single defensive retry live inside liveMicStream.
  const startCaptionPipeline = async () => {
    if (__DEV__) {
      console.info('[recording] live caption pipeline requested', {
        courseSelected: Boolean(course),
        localRecordingActive: isRecordingRef.current,
      });
    }
    resetCaptions();
    setMicStreamError(null);
    firstPcmFrameLoggedRef.current = false;
    await startLiveCaptions(48_000);
    const micStatus = await startMicStream({
      sampleRate: 48_000,
      onPcm16Frame: (frame) => {
        if (__DEV__ && !firstPcmFrameLoggedRef.current) {
          firstPcmFrameLoggedRef.current = true;
          console.info('[recording] first live PCM frame produced', {
            byteLength: frame.byteLength,
          });
        }
        sendAudioChunk(frame);
      },
      onUnavailable: () => {
        stopLiveCaptions();
        setMicStreamError(LIVE_CAPTIONS_UNAVAILABLE_MESSAGE);
        const mic = getLiveMicStreamStatus();
        logLiveCaptionUnavailable('no_pcm_callbacks', {
          micStarted: Boolean(mic.nativeRecorderStarted),
          micFramesReceived: mic.framesReceived,
          retryAttempted: Boolean(mic.retryAttempted),
          localRecordingActive: isRecordingRef.current,
        });
      },
    });
    if (micStatus.error) {
      stopLiveCaptions();
      // The "needs a development build" note is fine to show as-is; any other
      // startup failure is collapsed to the calm user-facing line.
      setMicStreamError(
        micStatus.isSupported ? LIVE_CAPTIONS_UNAVAILABLE_MESSAGE : micStatus.error,
      );
      if (__DEV__) {
        console.warn('[recording] live microphone unavailable', {
          supported: micStatus.isSupported,
          event: micStatus.lastEvent ?? null,
          permission: micStatus.permission ?? null,
        });
      }
    }
  };

  // Stop the live mic stream + live caption WebSocket (and their timers) when
  // the recording screen is left. Pushing Mini does not unmount this screen.
  useEffect(() => () => {
    stopMicStream();
    stopLiveCaptions();
  }, [stopLiveCaptions]);

  // Fresh recordings start with an empty Mini Workspace draft. Reopened
  // in-progress lectures rehydrate their saved draft instead of wiping it.
  useEffect(() => {
    if (isResume) {
      hydrateDraft(resumeDraftRef.current);
      return;
    }
    resetDraft();
  }, [hydrateDraft, isResume, pendingLectureId, resetDraft]);

  // If the user abandons the recording before Finish creates the Lecture,
  // discard any temporary material links created against the reserved id.
  useEffect(() => {
    return () => {
      if (!finishedRef.current) {
        const validLectureIds = lecturesRef.current.map((lecture) => lecture.id);
        if (progressCreatedRef.current) validLectureIds.push(pendingLectureId);
        cleanupOrphanMaterialLinks(validLectureIds);
      }
    };
  }, [cleanupOrphanMaterialLinks, pendingLectureId]);

  // Recording is the authoritative clock. Mini mirrors this value rather than
  // maintaining its own mark timeline, so marks from either surface align.
  useEffect(() => {
    setCurrentDurationMillis(sessionDurationMillis);
  }, [sessionDurationMillis, setCurrentDurationMillis]);

  useEffect(() => {
    setLectureSessionPaused(isReviewingResume || isPaused);
  }, [isPaused, isReviewingResume, setLectureSessionPaused]);

  // Begin recording automatically when the screen opens with permission
  // granted. The local recorder starts first so it owns the audio session;
  // the live caption mic stream then attaches on top without being clobbered.
  useEffect(() => {
    if (autoStarted.current || !granted) return;
    // Resumed lecture: wait for the existing central Pause/Continue control
    // before the recorder/mic/captions start, so opening it is a safe review.
    if (isResume && !continueRequested) return;
    autoStarted.current = true;
    void startRecording().then((started) => {
      if (__DEV__) console.info('[recording] automatic local recording result', { started });
      setStartFailed(!started);
      // Guests record locally only — no live caption WebSocket / backend calls.
      if (started && !isGuest) void startCaptionPipeline();
    });
  // The recorder and caption starters intentionally run once after permission resolves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granted, isGuest, isResume, continueRequested]);

  // Keep this fresh for the mount-once AppState listener below.
  isRecordingRef.current = isRecording;
  recoverCaptionsRef.current = () => {
    if (isGuest) return;
    if (!granted || finishing || isPaused || !isRecording) return;
    if (
      liveCaptionStatus === 'unavailable' ||
      liveCaptionStatus === 'error' ||
      liveCaptionStatus === 'idle'
    ) {
      logLiveCaptionEvent('foreground_caption_recovery', { liveCaptionStatus });
      void startCaptionPipeline();
    }
  };

  // When the app returns to the foreground, recover Live Caption if it failed
  // while backgrounded. This restarts ONLY captions + mic — never the recorder.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') recoverCaptionsRef.current();
      // Persist before the app is suspended so a background kill can't lose work.
      if (next === 'background' || next === 'inactive') {
        if (!finishedRef.current) persistProgressRef.current();
      }
    });
    return () => sub.remove();
  }, []);

  const handleAllow = async () => {
    autoStarted.current = true;
    const started = await startRecording();
    if (__DEV__) console.info('[recording] permission CTA recording result', { started });
    setStartFailed(!started);
    if (started && !isGuest) await startCaptionPipeline();
  };

  // Retry a failed lecture start (audio never began). Distinct from "Retry
  // captions", which only re-attaches the caption mic stream over live audio.
  const retryStart = async () => {
    setMicStreamError(null);
    setStartFailed(false);
    const started = await startRecording();
    if (__DEV__) console.info('[recording] retry start recording result', { started });
    setStartFailed(!started);
    if (started && !isGuest) await startCaptionPipeline();
  };

  const togglePause = () => {
    if (isReviewingResume) {
      setContinueRequested(true);
      return;
    }
    if (isPaused) {
      resumeRecording();
      if (!isGuest) void startCaptionPipeline();
    } else {
      pauseRecording();
      stopMicStream();
      stopLiveCaptions();
      // Pausing keeps the session — persist so it survives a later exit.
      if (!isGuest && !finishedRef.current) persistProgress();
    }
  };

  // Leaving via Back keeps an in-progress lecture (no "Recording not saved" for
  // meaningful content). Finalize the current audio segment so it is retained,
  // then persist and exit. Empty sessions are simply discarded (nothing to keep).
  const handleBack = async () => {
    if (finishing) return;
    if (!isGuest && !finishedRef.current) {
      stopMicStream();
      stopLiveCaptions();
      let uri: string | null = null;
      try {
        uri = await stopRecording();
      } catch {
        uri = null;
      }
      persistProgress(uri);
    }
    router.back();
  };

  const markImportant = () => {
    addMarkMillis(sessionDurationMillis);
    toast.setValue(1);
    Animated.timing(toast, {
      toValue: 0,
      duration: 1900,
      useNativeDriver: true,
    }).start();
  };

  const finish = async () => {
    if (finishing) return;
    if (__DEV__) {
      console.info('[recording] finish pressed', {
        durationMillis: sessionDurationMillis,
        hasCourse: Boolean(course),
        hasLectureTitle: Boolean((params.lectureTitle ?? '').trim()),
      });
    }
    setFinishing(true);
    finishedRef.current = true;
    const finalDuration = sessionDurationMillis;
    stopMicStream();
    stopLiveCaptions();
    const uri = await stopRecording();
    if (__DEV__) {
      console.info('[recording] local recording stopped', {
        hasUri: Boolean(uri),
        durationMillis: finalDuration,
      });
    }

    // Guest recordings are local-only with no captions, so audio is their only
    // content. Keep the strict empty-check: never save an empty lecture or count
    // it against the guest cap.
    if (isGuest) {
      if (!uri || finalDuration <= 0) {
        finishedRef.current = false;
        guestAutoStopped.current = false;
        setFinishing(false);
        router.back();
        Alert.alert(
          t('recording.notSavedTitle'),
          t('recording.notSavedBody'),
        );
        return;
      }
      createLecture({
        id: pendingLectureId,
        courseId: params.courseId ?? '',
        title: (params.lectureTitle ?? '').trim() || 'Untitled Lecture',
        durationMillis: finalDuration,
        localAudioUri: uri,
        markedTimestamps: marks.map((mark) => mark.timestampMillis),
        liveTranscript: '',
        notes: draftNotes,
        noteStrokes: draftStrokes,
        noteImages: draftImages,
      });
      resetDraft();
      await incrementGuestRecordingsUsed();
      router.replace('/');
      Alert.alert(
        t('recording.savedOnDeviceTitle'),
        t('recording.savedOnDeviceBody'),
        [
          { text: t('common.notNow'), style: 'cancel' },
          { text: t('common.signIn'), onPress: () => { void exitGuest().then(() => router.replace('/auth')); } },
        ],
      );
      return;
    }

    // Signed-in: finalize the in-progress lecture (or create it now) with the
    // merged bilingual history. "Meaningful content" — not just fresh audio —
    // decides whether to keep it, so a resumed lecture or a captions-only
    // session is never dropped as "Recording not saved".
    const lines: PersistedCaptionLine[] = feedLinesRef.current.map((line) => ({
      id: line.id,
      text: line.text,
      translationZh: line.translationZh,
    }));
    const { en, zh } = captionsToTranscript(lines);
    const mergedMarks = [
      ...priorMarksRef.current,
      ...marks.map((mark) => mark.timestampMillis),
    ];
    const existing = getLecture(pendingLectureId);
    const finalAudio = uri ?? priorAudioUriRef.current;
    const savedDuration = Math.max(existing?.durationMillis ?? 0, finalDuration);
    const currentLinks = materialLinksForLecture(pendingLectureId);
    const currentAnnotations = materialAnnotations.filter(
      (annotation) => annotation.lectureId === pendingLectureId && !annotation.deletedAt,
    );
    const meaningful = hasMeaningfulRecordingContent({
      durationMillis: savedDuration,
      hasAudio: Boolean(finalAudio),
      captionCount: lines.length,
      markCount: mergedMarks.length,
      transcriptLength: en.length,
      notesLength: draftNotes.trim().length,
      strokeCount: draftStrokes.length,
      imageCount: draftImages.length,
      materialLinkCount: currentLinks.length,
      materialAnnotationCount: currentAnnotations.reduce(
        (count, annotation) => count + annotation.strokes.length,
        0,
      ),
    });
    if (!meaningful) {
      finishedRef.current = false;
      setFinishing(false);
      router.back();
      Alert.alert(
        t('recording.notSavedTitle'),
        t('recording.notSavedBody'),
      );
      return;
    }

    let lectureId = pendingLectureId;
    if (existing) {
      updateLecture(pendingLectureId, {
        status: 'local_recorded',
        durationMillis: savedDuration,
        localAudioUri: finalAudio,
        markedTimestamps: mergedMarks,
        liveTranscript: en,
        liveTranscriptZh: zh,
        liveCaptionLines: lines,
        notes: draftNotes,
        noteStrokes: draftStrokes,
        noteImages: draftImages,
      });
    } else {
      const lecture = createLecture({
        id: pendingLectureId,
        courseId: sessionCourseIdRef.current,
        title: sessionTitleRef.current,
        durationMillis: savedDuration,
        localAudioUri: finalAudio,
        markedTimestamps: mergedMarks,
        liveTranscript: en,
        liveTranscriptZh: zh,
        liveCaptionLines: lines,
        notes: draftNotes,
        noteStrokes: draftStrokes,
        noteImages: draftImages,
      });
      lectureId = lecture.id;
    }
    resetDraft();

    router.replace({ pathname: '/processing', params: { lectureId } });
  };

  // Guest recordings are capped at 2 minutes. When the cap is reached we finish
  // the recording cleanly (same path as tapping Finish), exactly once.
  useEffect(() => {
    if (!isGuest || finishing || guestAutoStopped.current) return;
    if (seconds >= GUEST_MAX_RECORDING_SECONDS && (isRecording || isPaused)) {
      guestAutoStopped.current = true;
      void finish();
    }
  // `finish` closes over the current recording state; adding it would retrigger this cap watcher.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGuest, seconds, isRecording, isPaused, finishing]);

  const openMiniCaption = () => {
    router.push({ pathname: '/mini-caption', params: { elapsed: String(seconds) } });
  };

  const openLinkedMaterial = (materialId: string) => {
    if (!course) return;
    linkMaterialToLecture(pendingLectureId, materialId);
    setMaterialPickerVisible(false);
    router.push({
      pathname: '/lecture-material/[lectureId]/[materialId]',
      params: { lectureId: pendingLectureId, materialId },
    });
  };

  const importAndOpenMaterial = async () => {
    if (!course || importingMaterial) return;
    setImportingMaterial(true);
    const result = await pickAndImportPdf({ courseId: course.id, userId: currentUserId });
    setImportingMaterial(false);
    if (result.ok) {
      addMaterial(result.material);
      openLinkedMaterial(result.material.id);
      return;
    }
    if (!result.canceled) {
      Alert.alert(t('recording.importMaterialFailTitle'), result.reason);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('recording.back')}
          onPress={() => void handleBack()}
          hitSlop={10}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </Pressable>

        {granted ? (
          <StatusPill
            label={isReviewingResume ? t('recording.pausedShort') : isPaused ? t('recording.pausedShort') : t('recording.recordingShort')}
            variant={isReviewingResume || isPaused ? 'paused' : 'recording'}
          />
        ) : null}
        <View style={styles.courseChip}>
          <Ionicons name={(course?.icon ?? 'book-outline') as keyof typeof Ionicons.glyphMap} size={13} color={colors.accent} />
          <Text style={styles.courseChipText} numberOfLines={1}>{courseName}</Text>
        </View>
        {granted ? <Text style={styles.headerTimer}>{formatClock(seconds)}</Text> : <View style={styles.headerGrow} />}
        {granted && course ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setMaterialPickerVisible(true)}
            disabled={(!recordingSessionActive && !isReviewingResume) || finishing}
            style={({ pressed }) => [styles.materialTopButton, pressed && styles.pressed]}
          >
            <Ionicons name="document-text-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.materialTopText}>{t('recording.materialTop')}</Text>
          </Pressable>
        ) : null}
        {granted && !isGuest ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('recording.miniCaption')}
            onPress={openMiniCaption}
            hitSlop={10}
            style={({ pressed }) => [
              styles.iconBtn,
              styles.iconBtnLabelled,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons name="contract-outline" size={19} color={colors.textPrimary} />
            <Text style={styles.iconBtnLabel}>{t('recording.miniLabel')}</Text>
          </Pressable>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      {/* While the permission state is still being read */}
      {!permissionChecked && (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accentBright} />
        </View>
      )}

      {/* Calm permission state */}
      {permissionChecked && !granted && (
        <View style={styles.centered}>
          <View style={styles.permIcon}>
            <Ionicons name="mic-outline" size={36} color={colors.textPrimary} />
          </View>
          <Text style={styles.permTitle}>{t('recording.permissionTitle')}</Text>
          <Text style={styles.permBody}>
            {t('recording.permissionBody')}
            {permissionStatus === 'denied'
              ? t('recording.permissionDeniedDetail')
              : ''}
          </Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <PrimaryButton
            label={permissionStatus === 'denied' ? t('recording.openSettings') : t('common.continue')}
            icon={permissionStatus === 'denied' ? 'settings-outline' : 'mic'}
            onPress={
              permissionStatus === 'denied'
                ? () => Linking.openSettings()
                : handleAllow
            }
            style={styles.permButton}
          />
        </View>
      )}

      {/* Recording experience */}
      {granted && (
        <>
          {/* Marked-important confirmation toast */}
          <Animated.View pointerEvents="none" style={[styles.toast, { opacity: toast }]}>
            <Ionicons name="star" size={15} color={colors.pearlWhite} />
            <Text style={styles.toastText}>
              {t('recording.markedMoment', { time: formatClock(seconds) })}
            </Text>
          </Animated.View>

          {!isGuest && (captionAreaState === 'captions_visible' || isReviewingResume) ? (
            // Live transcript: a scrollable history of paired Chinese/English
            // caption blocks (not just the newest sentence). Kept OUTSIDE the
            // page ScrollView so the feed owns its own vertical scroll.
            <View style={styles.feedRegion}>
              <CaptionHistoryFeed
                lines={feedLines}
                partialEnglish={partialCaption}
                partialTranslationZh={partialTranslationZh}
                translatingPending={Boolean(
                  latestFinalLine && !latestFinalLine.translationZh && !partialCaption,
                )}
              />
              {showWordLookupHint || marks.length > 0 || (error && audioActive) ? (
                <View style={styles.feedInfoBar}>
                  {showWordLookupHint ? (
                    <Text style={styles.markHint}>{t('recording.wordLookupHint')}</Text>
                  ) : null}
                  {marks.length > 0 ? (
                    <Text style={styles.markHint}>
                      {t(marks.length === 1 ? 'recording.marksCountOne' : 'recording.marksCountOther', { count: marks.length })}
                    </Text>
                  ) : null}
                  {error && audioActive ? <Text style={styles.errorText}>{error}</Text> : null}
                </View>
              ) : null}
            </View>
          ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.content}>
              {isGuest ? (
                <GlassCard padding={spacing.xl} style={styles.guestCard}>
                  <View style={styles.stateHeader}>
                    <View style={[styles.stateIcon, isPaused && styles.stateIconPaused]}>
                      <Ionicons
                        name={isPaused ? 'pause' : 'mic'}
                        size={20}
                        color={isPaused ? colors.mutedBlueGray : colors.deepNavy}
                      />
                    </View>
                    <View style={styles.stateHeaderText}>
                      <Text style={styles.stateTitle}>{t('recording.localRecording')}</Text>
                      <Text style={styles.stateStatus}>
                        {isPaused
                          ? t('recording.paused')
                          : recordingSessionActive
                            ? t('recording.recordingToDevice')
                            : t('recording.preparingMic')}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.stateBody}>
                    {t('recording.guestBody')}
                  </Text>
                </GlassCard>
              ) : (
              <View style={styles.captionStage}>
                {captionAreaState === 'failed_start' ? (
                  // Audio never started: ONE coherent failed-start state. No
                  // "audio still active" copy, no "retry captions" — retry the
                  // whole start, or use Finish to leave cleanly.
                  <View style={styles.captionFallback}>
                    <Text style={styles.stateBody}>
                      {error ?? t('recording.couldNotStart')}
                    </Text>
                    <SecondaryButton
                      label={t('recording.retryStart')}
                      icon="refresh-outline"
                      onPress={() => void retryStart()}
                      style={styles.retryCaptionsButton}
                    />
                  </View>
                ) : captionAreaState === 'captions_connecting' ? (
                  <Text style={styles.stateBody}>{t('recording.connectingCaptions')}</Text>
                ) : captionAreaState === 'captions_unavailable' ? (
                  // Only reachable while audio is active — the copy is accurate.
                  <View style={styles.captionFallback}>
                    <Text style={styles.stateBody}>
                      {micStreamError ?? liveCaptionError ?? t('recording.captionsUnavailable')}
                    </Text>
                    <SecondaryButton
                      label={t('recording.retryCaptions')}
                      icon="refresh-outline"
                      onPress={() => void startCaptionPipeline()}
                      style={styles.retryCaptionsButton}
                    />
                  </View>
                ) : (
                  <Text style={styles.stateBody}>{t('recording.preparingMic')}</Text>
                )}
                {marks.length > 0 ? <Text style={styles.markHint}>{t(marks.length === 1 ? 'recording.marksCountOne' : 'recording.marksCountOther', { count: marks.length })}</Text> : null}
                {/* The start error owns the failed_start block above; only show
                    other recorder errors (pause/resume/finish) alongside a live session. */}
                {error && audioActive ? <Text style={styles.errorText}>{error}</Text> : null}
              </View>
              )}
            </View>
          </ScrollView>
          )}

          {/* Actions — Mark Important · Pause/Resume · Finish */}
          <View style={styles.actions}>
            <SecondaryButton
              label={t('recording.markImportant')}
              icon="star"
              onPress={markImportant}
              disabled={!controlsEnabled}
              style={styles.sideAction}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isReviewingResume || isPaused ? t('recording.resume') : t('recording.pause')}
              accessibilityState={{ disabled: !centralControlEnabled }}
              disabled={!centralControlEnabled}
              onPress={togglePause}
              style={({ pressed }) => [styles.roundBtn, !centralControlEnabled && styles.disabled, pressed && styles.pressed]}
            >
              <Ionicons
                name={isReviewingResume || isPaused ? 'play' : 'pause'}
                size={32}
                color={colors.pearlWhite}
              />
            </Pressable>

            <Pressable
              accessibilityRole="button"
              disabled={finishing}
              onPress={finish}
              style={({ pressed }) => [styles.finishButton, finishing && styles.disabled, pressed && styles.pressed]}
            >
              <Ionicons name="checkmark-done" size={18} color={colors.pearlWhite} />
              <Text style={styles.finishText}>{finishing ? t('recording.finishing') : t('recording.finish')}</Text>
            </Pressable>
          </View>

          <Modal
            visible={materialPickerVisible}
            transparent
            animationType="fade"
            onRequestClose={() => setMaterialPickerVisible(false)}
          >
            <View style={styles.materialModalOverlay}>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setMaterialPickerVisible(false)} />
              <View style={styles.materialModalCard}>
                <View style={styles.materialModalHeader}>
                  <View>
                    <Text style={styles.materialModalTitle}>{t('recording.materialPickerTitle')}</Text>
                    <Text style={styles.materialModalSubtitle} numberOfLines={1}>
                      {course?.name ? localizeSystemDefaultTitle(t, course.name) : t('recording.currentCourse')}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('recording.closeMaterialPicker')}
                    onPress={() => setMaterialPickerVisible(false)}
                    style={({ pressed }) => [styles.materialModalClose, pressed && styles.pressed]}
                  >
                    <Ionicons name="close" size={20} color={colors.textPrimary} />
                  </Pressable>
                </View>

                {courseMaterials.length > 0 ? (
                  <ScrollView style={styles.materialPickerList} contentContainerStyle={styles.materialPickerListContent}>
                    {courseMaterials.map((material) => (
                      <Pressable
                        key={material.id}
                        accessibilityRole="button"
                        onPress={() => openLinkedMaterial(material.id)}
                        style={({ pressed }) => [styles.materialPickerRow, pressed && styles.pressed]}
                      >
                        <View style={styles.materialPickerIcon}>
                          <Ionicons name="document-text-outline" size={19} color={colors.textPrimary} />
                        </View>
                        <View style={styles.materialPickerBody}>
                          <Text style={styles.materialPickerTitle} numberOfLines={1}>{localizeSystemDefaultTitle(t, material.title)}</Text>
                          <Text style={styles.materialPickerMeta}>
                            {material.pageCount ? t('recording.pagesValue', { count: material.pageCount }) : t('recording.pdfMaterial')}
                          </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                      </Pressable>
                    ))}
                  </ScrollView>
                ) : (
                  <View style={styles.materialEmptyState}>
                    <Ionicons name="folder-open-outline" size={34} color={colors.mutedBlueGray} />
                    <Text style={styles.materialEmptyTitle}>{t('recording.noMaterialsTitle')}</Text>
                    <Text style={styles.materialEmptyBody}>
                      {t('recording.noMaterialsBody')}
                    </Text>
                  </View>
                )}

                <SecondaryButton
                  label={importingMaterial ? t('recording.importing') : t('recording.importPdf')}
                  icon="cloud-upload-outline"
                  disabled={importingMaterial}
                  onPress={importAndOpenMaterial}
                />
              </View>
            </View>
          </Modal>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 13,
    backgroundColor: colors.glass,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  iconBtn: {
    height: 44,
    minWidth: 44,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnLabelled: {
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: spacing.md,
  },
  iconBtnLabel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  headerSpacer: {
    width: 44,
    height: 44,
  },
  headerGrow: { flex: 1 },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
  courseChip: { maxWidth: 220, minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: colors.glassElevated, borderWidth: 1, borderColor: colors.border },
  courseChipText: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700' },
  headerTimer: { flex: 1, textAlign: 'right', color: colors.ink, fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: 0.3 },
  materialTopButton: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.glassElevated, borderWidth: 1, borderColor: colors.border },
  materialTopText: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700' },

  // ---- Loading / permission ----
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  permIcon: {
    width: 84,
    height: 84,
    borderRadius: radius.xl,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  permTitle: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  permBody: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: fontSize.md * 1.5,
    maxWidth: 380,
  },
  permButton: {
    marginTop: spacing.md,
    minWidth: 240,
  },
  errorText: {
    fontSize: fontSize.sm,
    color: colors.recordingRed,
    fontWeight: '600',
    textAlign: 'center',
  },

  // ---- Recording ----
  toast: {
    position: 'absolute',
    top: 86,
    alignSelf: 'center',
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.deepNavy,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    ...shadows.button,
  },
  toastText: {
    color: colors.pearlWhite,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 72,
    paddingTop: 24,
    paddingBottom: 20,
    justifyContent: 'flex-end',
  },
  content: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'flex-start',
    gap: spacing.lg,
  },
  timerBlock: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  timer: {
    fontSize: fontSize.timer,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: 1.5,
    fontVariant: ['tabular-nums'],
  },
  timerHint: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  recordingToolRow: {
    alignItems: 'center',
  },
  recordingToolButton: {
    minWidth: 230,
  },
  guestCard: { maxWidth: 700, alignSelf: 'center' },

  // ---- Recording-state card ----
  stateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  stateIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateIconPaused: {
    backgroundColor: colors.surfaceMuted,
  },
  stateHeaderText: {
    flex: 1,
    gap: 2,
  },
  stateTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  stateStatus: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textTertiary,
  },
  // ---- Live caption body: English primary, Chinese secondary ----
  captionBody: {
    gap: 10,
  },
  captionStage: { minHeight: 360, justifyContent: 'flex-end', paddingBottom: 6 },
  feedRegion: { flex: 1, minHeight: 0 },
  feedInfoBar: { paddingHorizontal: 72, paddingBottom: 8, gap: 4 },
  captionHistory: { gap: 8, marginBottom: 18, maxWidth: 880 },
  historyLine: { color: 'rgba(71,85,105,0.40)', fontSize: 17, lineHeight: 26 },
  captionSection: {
    gap: spacing.xs,
  },
  captionLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: colors.textTertiary,
  },
  captionPrimary: {
    fontSize: 30,
    lineHeight: 42,
    color: colors.textPrimary,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  caret: { color: colors.accent, fontWeight: '400' },
  captionSecondary: {
    fontSize: 19,
    lineHeight: 30,
    color: colors.accent,
    fontWeight: '600',
  },
  captionTranslating: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '600',
  },
  stateBody: {
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.5,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  captionFallback: {
    gap: spacing.md,
  },
  retryCaptionsButton: {
    alignSelf: 'flex-start',
  },
  markHint: { color: colors.textTertiary, fontSize: 11.5, marginTop: 12 },

  // ---- Actions ----
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: 20,
    paddingTop: 13,
    paddingBottom: 18,
    width: '100%',
    backgroundColor: colors.glass,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  sideAction: {
    flex: 1,
  },
  roundBtn: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.navy,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.button,
  },
  finishButton: { flex: 1, minHeight: 50, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.navy },
  finishText: { color: colors.pearlWhite, fontSize: 14.5, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  materialModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  materialModalCard: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '72%',
    backgroundColor: colors.glassElevated,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    gap: spacing.md,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.08,
    shadowRadius: 28,
    elevation: 5,
  },
  materialModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  materialModalTitle: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  materialModalSubtitle: {
    marginTop: 2,
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '600',
  },
  materialModalClose: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  materialPickerList: {
    maxHeight: 330,
  },
  materialPickerListContent: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  materialPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
  },
  materialPickerIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  materialPickerBody: {
    flex: 1,
    gap: 2,
  },
  materialPickerTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  materialPickerMeta: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textTertiary,
  },
  materialEmptyState: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  materialEmptyTitle: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  materialEmptyBody: {
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.45,
    fontWeight: '500',
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
