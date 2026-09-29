import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { PressableScale } from '@/components/PressableScale';
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
import { loadContentLanguagePreferences } from '@/lib/contentLanguagePreferences';
import { resolveLectureLanguagePair } from '@/lib/contentLanguages.mjs';
import { useLiveCaptions } from '@/lib/liveCaptions';
import { getLiveMicStreamStatus, startMicStream, stopMicStream } from '@/lib/liveMicStream';
import { useRecordingNotes } from '@/lib/recordingNotes';
import { useData } from '@/lib/store';
import { useRolloutEligibility } from '@/lib/recording/useRolloutEligibility';
import { useLectureRecorder } from '@/lib/useLectureRecorder';
import { useUnresolvedRecordingGuard } from '@/lib/recording/useUnresolvedRecordingGuard';
import { resolveCaptionAreaState, recordingControlsEnabled } from '@/lib/lectureStartupState.mjs';
import {
  captionsToTranscript,
  hasMeaningfulRecordingContent,
} from '@/lib/recordingPersistence.mjs';
import {
  isVerifiedDurableLectureAudio,
  localAudioFileHasBytes,
  persistLectureLocalAudio,
  persistLectureResumeSegment,
} from '@/lib/lectureLocalAudio';
import {
  LEGACY_RESUME_ASSEMBLY_REQUIRED,
  planLegacyResumeFinalization,
} from '@/lib/recording/resumeAudioIntegrity.mjs';
import { preserveLegacyAudioSourcesEarly } from '@/lib/recording/legacyAudioAssembly';
import { isPad } from '@/constants/deviceClass';
import { useIsCompactWidth } from '@/constants/responsive';

export default function RecordingScreen() {
  const router = useRouter();
  const t = useT();
  const isCompact = useIsCompactWidth();
  const visualFixture = __DEV__ && process.env.EXPO_PUBLIC_VISUAL_FIXTURE === '1';
  const params = useLocalSearchParams<{ courseId?: string; lectureTitle?: string; lectureId?: string }>();
  const { isGuest, exitGuest, user, loading: authLoading } = useAuth();
  // Fixture rendering may show the signed-in recording composition (captions,
  // Mini, Notebook) while retaining the real guest safety policy underneath.
  const visualGuest = isGuest && !visualFixture;
  // Inactive by default: with the activation gate off this issues no request
  // and stays null, so the policy resolves to legacy exactly as before.
  const rollout = useRolloutEligibility({ userId: user?.id ?? null, authLoading });
  const {
    getCourse,
    loaded: dataLoaded,
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
    registerLectureSessionPauseToggle,
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
  const initialLanguagePair = resolveLectureLanguagePair(resumeLecture);
  const [sourceLanguage, setSourceLanguage] = useState(initialLanguagePair.sourceLanguage);
  const [translationLanguage, setTranslationLanguage] = useState(initialLanguagePair.translationLanguage);
  const [contentPreferencesLoaded, setContentPreferencesLoaded] = useState(Boolean(resumeLecture));
  useEffect(() => {
    if (resumeLecture) { setContentPreferencesLoaded(true); return; }
    void loadContentLanguagePreferences().then((pair) => {
      setSourceLanguage(pair.sourceLanguage); setTranslationLanguage(pair.translationLanguage);
    }).finally(() => setContentPreferencesLoaded(true));
  }, [resumeLecture]);
  // Canonical id only — never title/name (same discipline as the same-name course ownership bugs this
  // app has already been burned by once). Scopes unresolved-recording recovery to the CURRENT course.
  const currentCourseId = resumeLecture?.courseId ?? params.courseId ?? '';
  const course = getCourse(currentCourseId);
  const courseName = course?.name ?? t('recording.defaultCourse');
  // One stable lecture identity owns both the local draft and (when gated on)
  // exactly one native durable recording session.
  const [pendingLectureId] = useState(() => resumeLecture?.id ?? reserveLectureId());

  // P0 identity-safety guard: only meaningful for the param-less "start
  // fresh" path (no explicit lectureId) — an explicit reopen is always
  // authoritative and already goes through the normal per-lecture recovery
  // lookup below.  `lectures` is already the DataContext's current-account,
  // non-deleted-course/non-deleted-lecture view; requiring in_progress here
  // makes that exact ID set the sole authority for automatic recovery.
  const activeRecoveryLectureIds = useMemo(
    () => lectures.filter((lecture) => lecture.status === 'in_progress').map((lecture) => lecture.id),
    [lectures],
  );
  const unresolvedGuard = useUnresolvedRecordingGuard(
    dataLoaded && !isResume && !isGuest && !visualFixture,
    pendingLectureId,
    activeRecoveryLectureIds,
    currentCourseId,
    lectures,
  );
  // P0 (2026-09-11): a single recoverable session used to silently hijack EVERY param-less "Start New
  // Lecture" tap with no user-facing choice. Recording safety (never orphan real audio) and user intent
  // (let them actually start something new) are separate concerns: once the owner explicitly chooses
  // "Start New Recording" for a matched session in this mount, that match must never re-block or
  // re-redirect this screen. The recoverable lecture itself is NOT touched — it stays exactly as
  // recoverable as before, reachable from its own course page.
  const [dismissedSingleMatchId, setDismissedSingleMatchId] = useState<string | null>(null);
  const singleMatchPendingChoice =
    unresolvedGuard.singleMatch !== null && unresolvedGuard.singleMatch.lectureId !== dismissedSingleMatchId;
  const unresolvedGuardHandledRef = useRef(false);
  useEffect(() => {
    if (isResume || isGuest || visualFixture) return;
    if (!unresolvedGuard.checked || unresolvedGuardHandledRef.current) return;
    if (unresolvedGuard.singleMatch && singleMatchPendingChoice) {
      const matchedLectureId = unresolvedGuard.singleMatch.lectureId;
      const matchedLecture = lectures.find((l) => l.id === matchedLectureId);
      // The guard only returns current-account active IDs. Keep this local
      // check as a defensive boundary too: an unknown historical session must
      // remain an orphaned recovery artifact, never be adopted by a new route.
      if (matchedLecture?.status === 'in_progress') {
        unresolvedGuardHandledRef.current = true;
        Alert.alert(
          t('recording.unresolvedFoundTitle'),
          t('recording.unresolvedFoundBody'),
          [
            {
              text: t('recording.startNewAnyway'),
              style: 'cancel',
              // The ref stays true: this exact match is fully resolved for this mount (see
              // singleMatchPendingChoice) and must never re-alert; the fresh recording just continues.
              onPress: () => setDismissedSingleMatchId(matchedLectureId),
            },
            {
              text: t('recording.resume'),
              onPress: () => router.replace({ pathname: '/recording', params: { lectureId: matchedLectureId } }),
            },
          ],
        );
        return;
      }
    }
    if (unresolvedGuard.ambiguous) {
      // More than one real unresolved recording exists — never guess which
      // one to reattach. Block this fresh recording and send the owner back
      // to resolve them from their course pages.
      unresolvedGuardHandledRef.current = true;
      Alert.alert(
        t('recording.multipleUnresolvedTitle'),
        t('recording.multipleUnresolvedBody'),
        [{ text: t('common.ok'), onPress: () => router.back() }],
      );
    }
  }, [isResume, isGuest, visualFixture, unresolvedGuard, singleMatchPendingChoice, lectures, router, t]);

  const {
    engine: recordingEngine,
    permissionChecked,
    permissionStatus,
    recoveryChecked,
    recoverableSession,
    isRecording,
    isPaused,
    durationMillis,
    liveFileUri,
    error,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    leaveRecording,
    recoverRecording,
    finishRecoverableRecording,
    acknowledgeFinalizedOutput,
    discardRecoverableRecording,
    dismissRecovery,
  } = useLectureRecorder({ lectureId: pendingLectureId, forceLegacy: isGuest, rollout, visualFixture });

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
  // A legacy recorder is physically paused while its cache file is promoted.
  // Until that promotion verifies, this state prevents the UI from claiming
  // the pause is safe and exposes a retry that never adopts an unknown file.
  const [pauseDurabilityError, setPauseDurabilityError] = useState<string | null>(null);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const [materialPickerVisible, setMaterialPickerVisible] = useState(false);
  const [importingMaterial, setImportingMaterial] = useState(false);
  // Reopening an in-progress lecture starts in a REVIEW state: prior captions
  // are shown but the recorder/mic/live captions do NOT start until the user
  // resumes from the existing central Pause/Continue control.
  const [continueRequested, setContinueRequested] = useState(false);
  // A legacy Pause finalizes a first segment.  If it is then resumed, the
  // next capture is a distinct M4A and must be assembled rather than replacing
  // the already-verified first segment.
  const [legacyResumeAfterCheckpoint, setLegacyResumeAfterCheckpoint] = useState(false);
  // A durable session that remains native-recording belongs to the persistent
  // native module, not to the earlier Recording screen instance. This is a
  // live reattachment, not the paused review state used for an intentional
  // reopen of a previously-paused lecture.
  const isLiveNativeReattachment = recordingEngine === 'nativeDurable'
    && recoverableSession?.state === 'recording'
    && isRecording;
  const isReviewingResume = isResume && !continueRequested && !isLiveNativeReattachment;
  // New content APPENDS to the resumed lecture's id (no duplicate); a fresh
  // recording reserves a new id. Prior caption history / marks / audio are
  // snapshotted once at mount so we can merge new content onto them.
  const priorCaptionLinesRef = useRef<PersistedCaptionLine[]>(resumeLecture?.liveCaptionLines ?? []);
  const priorMarksRef = useRef<number[]>(resumeLecture?.markedTimestamps ?? []);
  const priorAudioUriRef = useRef<string | null>(resumeLecture?.localAudioUri ?? null);
  // Snapshotted once at mount, like the other prior* refs above. `resumeLecture`
  // itself is a LIVE read from the store (getLecture), and this screen's own
  // autosave (persistProgress) periodically writes the combined session
  // duration back into that same store record. Reading resumeLecture.durationMillis
  // directly on every render — instead of this frozen snapshot — created a
  // feedback loop: each autosave baked the running total into the store, the
  // next render added the still-live recorder duration on top of that already-
  // inflated baseline, and the error compounded roughly every 5s for the rest
  // of the resumed session (quadratic runaway, e.g. a real ~60min class
  // displaying ~345min after a single mid-class resume).
  const priorDurationMillisRef = useRef<number>(resumeLecture?.durationMillis ?? 0);
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
  const sessionDurationMillis = recordingEngine === 'nativeDurable'
    ? durationMillis
    : isResume || legacyResumeAfterCheckpoint
    ? priorDurationMillisRef.current + (isReviewingResume ? 0 : durationMillis)
    : durationMillis;
  const legacyResumeHasPriorAudio = (isResume || legacyResumeAfterCheckpoint)
    && recordingEngine === 'legacy'
    && Boolean(priorAudioUriRef.current);
  const seconds = Math.floor(sessionDurationMillis / 1000);
  const recordingSessionActive = isRecording || isPaused || durationMillis > 0;
  const safelyPaused = isPaused && !pauseDurabilityError;
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
  const captionsVisibleForHint = !isGuest && (captionAreaState === 'captions_visible' || isReviewingResume);
  const showWordLookupHint = useWordLookupHint(captionsVisibleForHint);

  // ---- Resumable persistence: prior history + live session merged together ----
  // The caption feed and every save read the SAME merged source, so reopening a
  // lecture shows old + new content and continuing appends to one lecture.
  const priorFinalizedAsLive = priorCaptionLinesRef.current.map((line) => ({
    id: line.id,
    text: line.text,
    translatedText: line.translatedText ?? line.translationZh,
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
        translatedText: line.translatedText ?? line.translationZh,
        translationZh: line.translationZh,
      }));
      const { en, zh, translated } = captionsToTranscript(lines);
      const mergedMarks = [
        ...priorMarksRef.current,
        ...marksRef.current.map((mark) => mark.timestampMillis),
      ];
      // `null` explicitly clears an unsafe live/cache URI. `undefined` means
      // retain a previously verified canonical asset during ordinary autosave.
      const nextAudio = audioUri === null ? null : audioUri ?? priorAudioUriRef.current;
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
        recordingEngine,
        localAudioUri: nextAudio,
        markedTimestamps: mergedMarks,
        liveTranscript: en,
        liveTranscriptZh: zh,
        translatedLiveTranscript: translated,
        sourceLanguage,
        translationLanguage,
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
    [isGuest, pendingLectureId, recordingEngine, saveInProgressLecture, sourceLanguage, translationLanguage],
  );
  const persistProgressRef = useRef(persistProgress);
  persistProgressRef.current = persistProgress;

  // Native durability needs the product-side lecture identity to exist before
  // a process can be killed. This empty in-progress shell is local-only and is
  // later filled by the normal autosave/Finish paths.
  const ensureNativeProgressIdentity = useCallback(() => {
    if (recordingEngine !== 'nativeDurable' || isGuest || progressCreatedRef.current) return;
    saveInProgressLecture({
      id: pendingLectureId,
      courseId: sessionCourseIdRef.current,
      title: sessionTitleRef.current,
      durationMillis: 0,
      recordingEngine,
      localAudioUri: null,
      markedTimestamps: [],
      liveTranscript: '',
      liveTranscriptZh: '',
      translatedLiveTranscript: '',
      sourceLanguage,
      translationLanguage,
      liveCaptionLines: [],
      notes: '',
      noteStrokes: [],
      noteImages: [],
    });
    progressCreatedRef.current = true;
  }, [isGuest, pendingLectureId, recordingEngine, saveInProgressLecture, sourceLanguage, translationLanguage]);

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
      // A resumed session with prior audio to protect must never let this
      // autosave carry the CURRENT (in-flight, still-growing) file into
      // localAudioUri — that would replace the earlier, longer canonical
      // audio, the exact CS111 truncation mechanism. A fresh legacy session
      // also must not make its cache file the recovery authority: Pause
      // promotes a verified Documents checkpoint synchronously instead.
      persistProgress(recordingEngine === 'legacy' || legacyResumeHasPriorAudio ? undefined : liveFileUri);
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
    recordingEngine,
    legacyResumeHasPriorAudio,
    liveFileUri,
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
  // Fresh starts clear caption history. Pause→Resume / mid-session reconnect
  // must preserveHistory so accumulated live captions stay visible.
  const startCaptionPipeline = async (options?: { preserveHistory?: boolean }) => {
    if (__DEV__) {
      console.info('[recording] live caption pipeline requested', {
        courseSelected: Boolean(course),
        localRecordingActive: isRecordingRef.current,
        preserveHistory: Boolean(options?.preserveHistory),
      });
    }

    if (!options?.preserveHistory) {
      resetCaptions();
    }
    setMicStreamError(null);
    firstPcmFrameLoggedRef.current = false;
    await startLiveCaptions(48_000, sourceLanguage, translationLanguage);
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
        setMicStreamError(t('recording.captionsUnavailable'));
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
        micStatus.isSupported ? t('recording.captionsUnavailable') : micStatus.error,
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
    setLectureSessionPaused(isReviewingResume || safelyPaused);
  }, [isReviewingResume, safelyPaused, setLectureSessionPaused]);

  // Begin recording automatically when the screen opens with permission
  // granted. The local recorder starts first so it owns the audio session;
  // the live caption mic stream then attaches on top without being clobbered.
  useEffect(() => {
    if (visualFixture || autoStarted.current || !granted || !contentPreferencesLoaded || !recoveryChecked || recoverableSession) return;
    // Resumed lecture: wait for the existing central Pause/Continue control
    // before the recorder/mic/captions start, so opening it is a safe review.
    if (isResume && !continueRequested) return;
    // Do not silently start a brand-new recording while a real, unresolved
    // recoverable session belongs to another lecture — wait for the guard to
    // resolve, and never proceed if it found something (the effect above
    // handles redirecting/blocking in that case). See
    // useUnresolvedRecordingGuard.
    // singleMatchPendingChoice (not the raw singleMatch object): once the owner chooses Start New, the
    // stale non-null match must stop blocking or the screen hangs at "Preparing microphone…" forever.
    if (!isResume && (!dataLoaded || !unresolvedGuard.checked || singleMatchPendingChoice || unresolvedGuard.ambiguous)) return;
    autoStarted.current = true;
    void startRecording().then((started) => {
      if (__DEV__) console.info('[recording] automatic local recording result', { started });
      setStartFailed(!started);
      if (started) ensureNativeProgressIdentity();
      // Guests record locally only — no live caption WebSocket / backend calls.
      if (started && !isGuest) void startCaptionPipeline();
    });
  // The recorder and caption starters intentionally run once after permission resolves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualFixture, granted, isGuest, isResume, continueRequested, contentPreferencesLoaded, recoveryChecked, recoverableSession, dataLoaded, unresolvedGuard, singleMatchPendingChoice]);

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
      void startCaptionPipeline({ preserveHistory: true });
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
    if (started) ensureNativeProgressIdentity();
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
    if (started) ensureNativeProgressIdentity();
    if (started && !isGuest) await startCaptionPipeline();
  };

  const togglePause = async () => {
    if (isReviewingResume) {
      if (resumeLecture?.audioAssemblyStatus === 'required') {
        // This used to be a dead-end Alert with no connection to recovery.
        // A Back-triggered assembly-required save leaves the lecture's
        // status as 'in_progress' (handleBack intentionally preserves an
        // in-progress lecture), so reopening it always re-enters this exact
        // review screen — Resume is the natural first thing a user presses,
        // and it hit this guard every time with no way out. Route into
        // /processing instead: it is the ONE place that actually runs
        // recovery (see its own runAssembly effect), so this is a redirect
        // into the existing pipeline, not a second copy of it.
        if (__DEV__) console.info('[AudioAssembly] redirect-to-processing', { lectureId: pendingLectureId, from: 'togglePause' });
        router.replace({ pathname: '/processing', params: { lectureId: pendingLectureId } });
        return;
      }
      setContinueRequested(true);
      return;
    }
    if (pauseDurabilityError) {
      const retriedAudio = recordingEngine === 'legacy' && liveFileUri
        ? await persistLectureLocalAudio(liveFileUri, pendingLectureId)
        : null;
      if (retriedAudio && isVerifiedDurableLectureAudio(retriedAudio)) {
        setPauseDurabilityError(null);
        if (!isGuest && !finishedRef.current) {
          persistProgress(legacyResumeHasPriorAudio ? undefined : retriedAudio);
        }
        return;
      }
      Alert.alert(
        'Paused recording is not yet safe',
        'Its audio could not be verified in durable storage. Keep Youmi Lens open and use this control to retry saving it.',
      );
      return;
    }
    if (isPaused) {
      const resumed = await resumeRecording();
      if (resumed && recordingEngine === 'legacy') setLegacyResumeAfterCheckpoint(true);
      // Reconnect captions/mic only — never wipe accumulated live history.
      if (!isGuest) await startCaptionPipeline({ preserveHistory: true });
    } else {
      const paused = await pauseRecording();
      if (!paused) return;
      stopMicStream();
      stopLiveCaptions();
      // The current capture is now finalized by the legacy hook.  A resumed
      // legacy lecture already owns a first canonical segment, so preserve
      // this new segment separately and enter the existing safe assembly
      // gate.  Never overwrite the first segment merely because Pause was
      // pressed a second time.
      if (recordingEngine === 'legacy' && legacyResumeHasPriorAudio && liveFileUri) {
        const segmentUri = await persistLectureResumeSegment(liveFileUri, pendingLectureId);
        const plan = planLegacyResumeFinalization({
          priorCanonicalUri: priorAudioUriRef.current,
          resumedSegmentUri: segmentUri,
          existingSegments: resumeLecture?.audioSegments,
          priorCreatedAt: resumeLecture?.date,
          now: new Date().toISOString(),
        });
        if (plan.kind === 'assembly_required') {
          persistProgress();
          updateLecture(pendingLectureId, {
            recordingEngine,
            localAudioUri: plan.canonicalUri,
            audioAssemblyStatus: 'required',
            audioAssemblyReason: plan.reason,
            audioSegments: plan.segments,
            uploadStatus: 'upload_failed',
            uploadError: 'Audio segments were preserved. Final assembly is required before upload.',
          });
          void preserveLegacyAudioSourcesEarly(pendingLectureId, plan.segments).then((preserved) => {
            if (__DEV__ && !preserved.ok) {
              console.warn('[AudioAssembly] early-preservation-failed', { lectureId: pendingLectureId, error: preserved.error });
            }
          });
          router.replace({ pathname: '/processing', params: { lectureId: pendingLectureId } });
          return;
        }
        setPauseDurabilityError('durable_copy_failed');
        Alert.alert('Pause was not completed safely', 'The resumed audio could not be verified as a separate durable segment. Keep Youmi Lens open and do not retry this recording.');
        return;
      }
      // A legacy recorder writes under Caches/ExpoAudio. A paused recorder can
      // outlive this JS screen only if its current bytes are promoted now;
      // saving the cache URI alone made lock/process-restart Finish point at a
      // file iOS was free to evict. Do this synchronously at the Pause boundary.
      const pausedLegacyAudio = recordingEngine === 'legacy' && liveFileUri
        ? await persistLectureLocalAudio(liveFileUri, pendingLectureId)
        : null;
      const verifiedPausedLegacyAudio = pausedLegacyAudio && isVerifiedDurableLectureAudio(pausedLegacyAudio)
        ? pausedLegacyAudio
        : null;
      if (recordingEngine === 'legacy' && !verifiedPausedLegacyAudio) {
        // Do not make an ephemeral cache URI the recovery authority. The source
        // is left untouched for forensic recovery, but the user must not be
        // led to believe this paused recording is safely persisted.
        setPauseDurabilityError('durable_copy_failed');
        if (!isGuest && !finishedRef.current) persistProgress(null);
        Alert.alert(
          'Pause was not completed safely',
          'The captured audio could not be verified in durable storage. Keep Youmi Lens open and use the main control to retry saving the paused audio.',
        );
        return;
      }
      setPauseDurabilityError(null);
      if (recordingEngine === 'legacy' && verifiedPausedLegacyAudio) {
        // The legacy hook stopped the AVAudioRecorder before this copy, so
        // this is a finalized, native-validated Documents checkpoint.
        priorAudioUriRef.current = verifiedPausedLegacyAudio;
        priorDurationMillisRef.current = sessionDurationMillis;
      }
      // Pausing keeps the session — persist only a verified legacy checkpoint
      // so a later remount owns a Documents asset, never a cache-only URI.
      if (!isGuest && !finishedRef.current) {
        persistProgress(legacyResumeHasPriorAudio ? undefined : verifiedPausedLegacyAudio);
      }
    }
  };

  // Mini / Course popups call the same authoritative Pause↔Resume path.
  useEffect(() => {
    registerLectureSessionPauseToggle(() => togglePause());
    return () => registerLectureSessionPauseToggle(null);
    // Re-bind whenever pause/resume dependencies change so the handler is fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    registerLectureSessionPauseToggle,
    isPaused,
    pauseDurabilityError,
    isReviewingResume,
    isGuest,
    resumeRecording,
    pauseRecording,
  ]);

  // Leaving via Back keeps an in-progress lecture (no "Recording not saved" for
  // meaningful content). Finalize the current audio segment so it is retained,
  // then persist and exit. Empty sessions are simply discarded (nothing to keep).
  const handleBack = async () => {
    if (finishing) return;
    if (!isGuest && !finishedRef.current) {
      stopMicStream();
      stopLiveCaptions();
      // A nativeDurable recording is owned by the persistent native module,
      // so returning to Course must not be translated into Pause. Persist the
      // product-side lecture shell, then let this same native session keep
      // checkpointing until the owner explicitly presses Pause or Finish.
      if (recordingEngine === 'nativeDurable' && isRecording) {
        persistProgress();
        router.back();
        return;
      }
      let uri: string | null = null;
      try {
        uri = await leaveRecording();
      } catch {
        uri = null;
      }
      if (legacyResumeHasPriorAudio && uri) {
        const segmentUri = await persistLectureResumeSegment(uri, pendingLectureId);
        const plan = planLegacyResumeFinalization({
          priorCanonicalUri: priorAudioUriRef.current,
          resumedSegmentUri: segmentUri,
          existingSegments: resumeLecture?.audioSegments,
          priorCreatedAt: resumeLecture?.date,
          now: new Date().toISOString(),
        });
        if (plan.kind === 'assembly_required') {
          persistProgress();
          updateLecture(pendingLectureId, {
            recordingEngine,
            localAudioUri: plan.canonicalUri,
            audioAssemblyStatus: 'required',
            audioAssemblyReason: plan.reason,
            audioSegments: plan.segments,
            uploadStatus: 'upload_failed',
            uploadError: 'Audio segments were preserved. Final assembly is required before upload.',
          });
          // Best-effort: copy the sources into durable storage NOW, before
          // the user can leave — the legacy recorder's Cache file is not a
          // durable identity (eviction, or a reinstall that rotates the
          // container UUID, both invalidate it later). Never blocks Back:
          // /processing's eventual recovery retries persistence anyway.
          const preserved = await preserveLegacyAudioSourcesEarly(pendingLectureId, plan.segments);
          if (__DEV__ && !preserved.ok) {
            console.warn('[AudioAssembly] early-preservation-failed', { lectureId: pendingLectureId, error: preserved.error });
          }
        }
      } else {
        const persistedExitAudio = recordingEngine === 'legacy' && uri
          ? await persistLectureLocalAudio(uri, pendingLectureId)
          : uri;
        const verifiedExitAudio = recordingEngine === 'legacy'
          ? isVerifiedDurableLectureAudio(persistedExitAudio)
          : localAudioFileHasBytes(persistedExitAudio);
        persistProgress(verifiedExitAudio ? persistedExitAudio : null);
      }
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

  const finish = async (options?: { recoverable?: boolean }) => {
    if (finishing) return;
    // A lecture already blocked behind audioAssemblyStatus === 'required'
    // (e.g. reopened after a prior Back-triggered assembly-required save)
    // must not run the mic-stop / stopRecording sequence below at all — no
    // new audio was necessarily captured this session (uri could be falsy),
    // which previously fell through into the normal finish path using only
    // priorAudioUriRef.current and silently ignoring the resumed segment.
    // Route into the same recovery pipeline /processing already runs,
    // instead of duplicating that logic here.
    if (getLecture(pendingLectureId)?.audioAssemblyStatus === 'required') {
      if (__DEV__) console.info('[AudioAssembly] redirect-to-processing', { lectureId: pendingLectureId, from: 'finish' });
      router.replace({ pathname: '/processing', params: { lectureId: pendingLectureId } });
      return;
    }
    if (options?.recoverable) autoStarted.current = true;
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
    const uri = options?.recoverable
      ? await finishRecoverableRecording()
      : await stopRecording();
    if (__DEV__) {
      console.info('[recording] local recording stopped', {
        hasUri: Boolean(uri),
        durationMillis: finalDuration,
      });
    }
    if (recordingEngine === 'nativeDurable' && !uri) {
      finishedRef.current = false;
      setFinishing(false);
      return;
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
      const durableGuestAudio = await persistLectureLocalAudio(uri, pendingLectureId);
      const verifiedGuestAudio = recordingEngine === 'legacy'
        ? isVerifiedDurableLectureAudio(durableGuestAudio)
        : localAudioFileHasBytes(durableGuestAudio);
      if (!verifiedGuestAudio) {
        finishedRef.current = false;
        guestAutoStopped.current = false;
        setFinishing(false);
        Alert.alert(
          t('recording.notSavedTitle'),
          'The final audio could not be verified on this device. The original file was left untouched for recovery.',
        );
        return;
      }
      createLecture({
        id: pendingLectureId,
        courseId: params.courseId ?? '',
        title: (params.lectureTitle ?? '').trim() || 'Untitled Lecture',
        durationMillis: finalDuration,
        recordingEngine,
        localAudioUri: durableGuestAudio,
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
      translatedText: line.translatedText ?? line.translationZh,
      translationZh: line.translationZh,
    }));
    const { en, zh, translated } = captionsToTranscript(lines);
    const mergedMarks = [
      ...priorMarksRef.current,
      ...marks.map((mark) => mark.timestampMillis),
    ];
    const existing = getLecture(pendingLectureId);
    // A legacy recorder starts a new file after a recovered recording is
    // reopened. Preserve that file separately and stop here: assigning it to
    // localAudioUri would replace the original canonical audio and recreate
    // the CS111 truncation incident.
    if (legacyResumeHasPriorAudio && uri) {
      const segmentUri = await persistLectureResumeSegment(uri, pendingLectureId);
      const plan = planLegacyResumeFinalization({
        priorCanonicalUri: priorAudioUriRef.current,
        resumedSegmentUri: segmentUri,
        existingSegments: resumeLecture?.audioSegments,
        priorCreatedAt: resumeLecture?.date,
        now: new Date().toISOString(),
      });
      if (plan.kind !== 'assembly_required') {
        finishedRef.current = false;
        setFinishing(false);
        Alert.alert(
          'Recording preserved',
          'The resumed audio could not be safely preserved as a separate segment. Upload has been blocked; please keep this app open and contact support before retrying.',
        );
        return;
      }
      updateLecture(pendingLectureId, {
        status: 'local_recorded',
        recordingEngine,
        durationMillis: Math.max(existing?.durationMillis ?? 0, finalDuration),
        // Keep the previous canonical file untouched. It remains the first
        // source segment rather than becoming an upload authority.
        localAudioUri: plan.canonicalUri,
        audioAssemblyStatus: 'required',
        audioAssemblyReason: LEGACY_RESUME_ASSEMBLY_REQUIRED,
        audioSegments: plan.segments,
        uploadStatus: 'upload_failed',
        uploadError: 'Audio segments were preserved. Final assembly is required before upload.',
        processingStatus: 'not_started',
        markedTimestamps: mergedMarks,
        liveTranscript: en,
        liveTranscriptZh: zh,
        translatedLiveTranscript: translated,
        sourceLanguage,
        translationLanguage,
        liveCaptionLines: lines,
        notes: draftNotes,
        noteStrokes: draftStrokes,
        noteImages: draftImages,
      });
      // Best-effort: copy the sources into durable storage NOW, before
      // resetDraft/navigation — the legacy recorder's Cache file is not a
      // durable identity (eviction, or a reinstall that rotates the
      // container UUID, both invalidate it later). Never blocks Finish:
      // /processing's eventual recovery retries persistence anyway.
      const preserved = await preserveLegacyAudioSourcesEarly(pendingLectureId, plan.segments);
      if (__DEV__ && !preserved.ok) {
        console.warn('[AudioAssembly] early-preservation-failed', { lectureId: pendingLectureId, error: preserved.error });
      }
      resetDraft();
      router.replace({ pathname: '/processing', params: { lectureId: pendingLectureId } });
      return;
    }

    const rawFinalAudio = uri ?? priorAudioUriRef.current;
    const finalAudio = rawFinalAudio
      ? await persistLectureLocalAudio(rawFinalAudio, pendingLectureId)
      : null;
    const verifiedFinalAudio = recordingEngine === 'legacy'
      ? isVerifiedDurableLectureAudio(finalAudio)
      : localAudioFileHasBytes(finalAudio);
    // Captions and duration are valuable recovery evidence, but they cannot
    // turn a missing recording file into a "Recording Saved" result. Keep the
    // screen mounted and leave every candidate untouched if final ownership is
    // not proven.
    if (finalDuration > 0 && !verifiedFinalAudio) {
      finishedRef.current = false;
      setFinishing(false);
      Alert.alert(
        t('recording.notSavedTitle'),
        'The final audio could not be verified in durable storage. No upload was started and original audio candidates were left untouched for recovery.',
      );
      return;
    }
    const savedDuration = Math.max(existing?.durationMillis ?? 0, finalDuration);
    const currentLinks = materialLinksForLecture(pendingLectureId);
    const currentAnnotations = materialAnnotations.filter(
      (annotation) => annotation.lectureId === pendingLectureId && !annotation.deletedAt,
    );
    const meaningful = hasMeaningfulRecordingContent({
      durationMillis: savedDuration,
      hasAudio: Boolean(verifiedFinalAudio),
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
        recordingEngine,
        durationMillis: savedDuration,
        localAudioUri: finalAudio,
        markedTimestamps: mergedMarks,
        liveTranscript: en,
        liveTranscriptZh: zh,
        translatedLiveTranscript: translated,
        sourceLanguage,
        translationLanguage,
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
        recordingEngine,
        localAudioUri: finalAudio,
        markedTimestamps: mergedMarks,
        liveTranscript: en,
        liveTranscriptZh: zh,
        translatedLiveTranscript: translated,
        sourceLanguage,
        translationLanguage,
        liveCaptionLines: lines,
        notes: draftNotes,
        noteStrokes: draftStrokes,
        noteImages: draftImages,
      });
      lectureId = lecture.id;
    }
    if (recordingEngine === 'nativeDurable' && !(await acknowledgeFinalizedOutput())) {
      finishedRef.current = false;
      setFinishing(false);
      return;
    }
    resetDraft();

    router.replace({ pathname: '/processing', params: { lectureId } });
  };

  const resumeRecoveredRecording = async () => {
    if (finishing) return;
    autoStarted.current = true;
    const recovered = await recoverRecording();
    if (!recovered) return;
    setContinueRequested(true);
    await resumeRecording();
    if (!isGuest) await startCaptionPipeline();
  };

  const confirmDiscardRecoveredRecording = () => {
    Alert.alert(
      t('recording.recoveryDiscardTitle'),
      t('recording.recoveryDiscardBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('recording.recoveryDiscard'),
          style: 'destructive',
          onPress: () => {
            autoStarted.current = true;
            void discardRecoverableRecording();
          },
        },
      ],
    );
  };

  // Guest recordings are capped at 2 minutes. When the cap is reached we finish
  // the recording cleanly (same path as tapping Finish), exactly once.
  useEffect(() => {
    if (visualFixture || !isGuest || finishing || guestAutoStopped.current) return;
    if (seconds >= GUEST_MAX_RECORDING_SECONDS && (isRecording || isPaused)) {
      guestAutoStopped.current = true;
      void finish();
    }
  // `finish` closes over the current recording state; adding it would retrigger this cap watcher.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualFixture, isGuest, seconds, isRecording, isPaused, finishing]);

  const openMiniCaption = () => {
    // Mini's whole screen is a NotebookCanvas page (a floating caption/control
    // panel sits on top of it, but the destination's reason to exist is the
    // notebook underneath) — Notebook is iPad-only. On iPhone this shows the
    // same notice as the Lecture Detail gate and never navigates, so the
    // recorder/session/pendingLectureId/timer are completely untouched.
    if (!isPad) {
      Alert.alert(t('lecture.notebookIpadOnly'));
      return;
    }
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
      <View style={[styles.header, isCompact && styles.headerCompact]}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('recording.back')}
          onPress={() => void handleBack()}
          hitSlop={10}
          style={styles.iconBtn}
        >
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </PressableScale>

        {granted ? (
          <StatusPill
            label={pauseDurabilityError ? 'Audio needs saving' : isReviewingResume ? t('recording.pausedShort') : safelyPaused ? t('recording.pausedShort') : t('recording.recordingShort')}
            variant={pauseDurabilityError || isReviewingResume || safelyPaused ? 'paused' : 'recording'}
          />
        ) : null}
        <View style={[styles.courseChip, isCompact && styles.courseChipCompact]}>
          <Ionicons name={(course?.icon ?? 'book-outline') as keyof typeof Ionicons.glyphMap} size={13} color={colors.accent} />
          <Text style={styles.courseChipText} numberOfLines={1}>{courseName}</Text>
        </View>
        {granted ? (
          <Text
            style={[styles.headerTimer, isCompact && styles.headerTimerCompact]}
            numberOfLines={1}
          >
            {formatClock(seconds)}
          </Text>
        ) : <View style={styles.headerGrow} />}
        {granted && course ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('recording.materialTop')}
            onPress={() => setMaterialPickerVisible(true)}
            disabled={(!recordingSessionActive && !isReviewingResume) || finishing}
            hitSlop={isCompact ? 8 : undefined}
            style={isCompact ? styles.materialGhostButton : styles.materialTopButton}
          >
            <Ionicons name="document-text-outline" size={isCompact ? 17 : 14} color={colors.textTertiary} />
            {isCompact ? null : <Text style={styles.materialTopText}>{t('recording.materialTop')}</Text>}
          </PressableScale>
        ) : null}
        {/* Mini lives in the bottom control bar on phone — the top bar stays
            context/state only there (see BOTTOM CONTROLS below). */}
        {!isCompact ? (
          granted && !visualGuest ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('recording.miniCaption')}
              onPress={openMiniCaption}
              hitSlop={10}
              style={[styles.iconBtn, styles.iconBtnLabelled]}
            >
              <Ionicons name="contract-outline" size={19} color={colors.textPrimary} />
              <Text style={styles.iconBtnLabel}>{t('recording.miniLabel')}</Text>
            </PressableScale>
          ) : (
            <View style={styles.headerSpacer} />
          )
        ) : null}
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

          {!visualGuest && (captionAreaState === 'captions_visible' || isReviewingResume) ? (
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
                <View style={[styles.feedInfoBar, isCompact && styles.feedInfoBarCompact]}>
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
            contentContainerStyle={[styles.scroll, isCompact && styles.scrollCompact]}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.content}>
              {visualGuest ? (
                <GlassCard padding={spacing.xl} style={styles.guestCard}>
                  <View style={styles.stateHeader}>
                    <View style={[styles.stateIcon, safelyPaused && styles.stateIconPaused]}>
                      <Ionicons
                        name={safelyPaused ? 'pause' : 'mic'}
                        size={20}
                        color={safelyPaused ? colors.mutedBlueGray : colors.deepNavy}
                      />
                    </View>
                    <View style={styles.stateHeaderText}>
                      <Text style={styles.stateTitle}>{t('recording.localRecording')}</Text>
                      <Text style={styles.stateStatus}>
                        {pauseDurabilityError
                          ? 'Audio needs saving'
                          : safelyPaused
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
                  // Reachable while audio is active OR while a native forced
                  // pause (checkpoint rollover failure, interruption, route
                  // change) has since stopped capture without this state
                  // re-resolving — isRecording is checked directly at render
                  // so the "still active" claim is never shown when it's
                  // false. This is the P0 fix: the copy used to assume audio
                  // was always active here, which is exactly what silently
                  // broke down during the checkpoint-rollover incident.
                  <View style={styles.captionFallback}>
                    <Text style={styles.stateBody}>
                      {isRecording
                        ? (micStreamError ?? liveCaptionError ?? t('recording.captionsUnavailable'))
                        : t('recording.captionsUnavailablePaused')}
                    </Text>
                    <SecondaryButton
                      label={t('recording.retryCaptions')}
                      icon="refresh-outline"
                      onPress={() => void startCaptionPipeline({ preserveHistory: true })}
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

          {/* Actions. iPad: Mark Important · Pause/Resume · Finish, three even
              weights. Phone: a small utility cluster (Mark Important, Mini)
              next to the primary Pause control, with Finish as the wide,
              unmistakably primary action — this is the one persistent action
              hub on phone, since the top bar there carries no controls. */}
          <View style={[styles.actions, isCompact && styles.actionsCompact]}>
            {isCompact ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('recording.markImportant')}
                accessibilityState={{ disabled: !controlsEnabled }}
                disabled={!controlsEnabled}
                onPress={markImportant}
                style={[styles.utilityBtn, !controlsEnabled && styles.disabled]}
              >
                <Ionicons name="star-outline" size={20} color={colors.textPrimary} />
              </PressableScale>
            ) : (
              <SecondaryButton
                label={t('recording.markImportant')}
                icon="star"
                onPress={markImportant}
                disabled={!controlsEnabled}
                style={styles.sideAction}
              />
            )}

            {isCompact && granted && !visualGuest ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('recording.miniCaption')}
                onPress={openMiniCaption}
                style={styles.utilityBtn}
              >
                <Ionicons name="contract-outline" size={20} color={colors.textPrimary} />
              </PressableScale>
            ) : null}

            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={pauseDurabilityError ? 'Retry saving paused audio' : isReviewingResume || safelyPaused ? t('recording.resume') : t('recording.pause')}
              accessibilityState={{ disabled: !centralControlEnabled }}
              disabled={!centralControlEnabled}
              onPress={() => { void togglePause(); }}
              style={[styles.roundBtn, !centralControlEnabled && styles.disabled]}
            >
              <Ionicons
                name={pauseDurabilityError ? 'refresh' : isReviewingResume || safelyPaused ? 'play' : 'pause'}
                size={32}
                color={colors.pearlWhite}
              />
            </PressableScale>

            <PressableScale
              accessibilityRole="button"
              disabled={finishing}
              onPress={() => { void finish(); }}
              style={[styles.finishButton, finishing && styles.disabled]}
            >
              <Ionicons name="checkmark-done" size={18} color={colors.pearlWhite} />
              <Text style={styles.finishText}>{finishing ? t('recording.finishing') : t('recording.finish')}</Text>
            </PressableScale>
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

          <Modal
            visible={Boolean(recoverableSession) && !recoveryDismissed && !isLiveNativeReattachment}
            transparent
            animationType="fade"
            onRequestClose={() => { setRecoveryDismissed(true); dismissRecovery(); }}
          >
            <View style={styles.materialModalOverlay}>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => { setRecoveryDismissed(true); dismissRecovery(); }} />
              <View style={styles.recoveryCard}>
                <View style={styles.recoveryIcon}>
                  <Ionicons name="refresh-circle-outline" size={32} color={colors.accent} />
                </View>
                <Text style={styles.materialModalTitle}>{t('recording.recoveryTitle')}</Text>
                <Text style={styles.permBody}>{t('recording.recoveryBody')}</Text>
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                {recoverableSession?.state !== 'finalized' ? (
                  <PrimaryButton
                    label={t('recording.recoveryResume')}
                    icon="play"
                    onPress={() => { void resumeRecoveredRecording(); }}
                  />
                ) : null}
                {(recoverableSession?.segments.length ?? 0) > 0 ? (
                  <SecondaryButton
                    label={t('recording.recoveryFinish')}
                    icon="checkmark-done"
                    onPress={() => { void finish({ recoverable: true }); }}
                  />
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={confirmDiscardRecoveredRecording}
                  style={({ pressed }) => [styles.recoveryDiscardButton, pressed && styles.pressed]}
                >
                  <Text style={styles.recoveryDiscardText}>{t('recording.recoveryDiscard')}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => { setRecoveryDismissed(true); dismissRecovery(); }}>
                  <Text style={styles.markHint}>{t('common.notNow')}</Text>
                </Pressable>
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
  headerCompact: {
    gap: 8,
    paddingHorizontal: 14,
    flexWrap: 'wrap',
    rowGap: 8,
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
  courseChipCompact: { maxWidth: 130, minWidth: 0, flexShrink: 1 },
  courseChipText: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700' },
  headerTimer: { flex: 1, textAlign: 'right', color: colors.ink, fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: 0.3 },
  headerTimerCompact: { minWidth: 88, flexShrink: 0, fontSize: 22 },
  materialTopButton: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.glassElevated, borderWidth: 1, borderColor: colors.border },
  materialTopText: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700' },
  // De-emphasized on phone: a plain icon, no chip/background, so it reads as
  // secondary next to the state pill and timer rather than competing with them.
  materialGhostButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },

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
  recoveryCard: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    alignItems: 'stretch',
    gap: spacing.md,
    padding: spacing.xl,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  recoveryIcon: { alignSelf: 'center' },
  recoveryDiscardButton: { alignItems: 'center', paddingVertical: spacing.sm },
  recoveryDiscardText: { color: colors.recordingRed, fontSize: fontSize.sm, fontWeight: '700' },

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
  scrollCompact: {
    paddingHorizontal: 20,
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
  feedInfoBarCompact: { paddingHorizontal: 20 },
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
  actionsCompact: {
    gap: spacing.sm,
    paddingHorizontal: 14,
  },
  sideAction: {
    flex: 1,
  },
  // Phone-only utility buttons (Mark Important, Mini) flanking the primary
  // round control — small and quiet so Pause/Finish stay visually primary.
  utilityBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
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
