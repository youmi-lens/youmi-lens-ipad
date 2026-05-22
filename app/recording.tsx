import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { StatusPill } from '@/components/StatusPill';
import { colors, fontSize, layout, radius, shadows, spacing } from '@/constants/theme';
import { formatClock } from '@/lib/format';
import { pickAndImportPdf } from '@/lib/importMaterial';
import { logLiveCaptionEvent, logLiveCaptionUnavailable } from '@/lib/liveCaptionDiagnostics';
import { useLiveCaptions } from '@/lib/liveCaptions';
import { getLiveMicStreamStatus, startMicStream, stopMicStream } from '@/lib/liveMicStream';
import { useRecordingNotes } from '@/lib/recordingNotes';
import { useData } from '@/lib/store';
import { useLectureRecorder } from '@/lib/useLectureRecorder';

/** Calm, user-facing line shown when live captions cannot run. Diagnostics stay in the console. */
const LIVE_CAPTIONS_UNAVAILABLE_MESSAGE = 'Live captions unavailable. Audio recording is still active.';

export default function RecordingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ courseId?: string; lectureTitle?: string }>();
  const {
    getCourse,
    createLecture,
    currentUserId,
    lectures,
    materialsForCourse,
    addMaterial,
    reserveLectureId,
    linkMaterialToLecture,
    cleanupOrphanMaterialLinks,
  } = useData();
  const {
    draftNotes,
    draftStrokes,
    marks,
    addMarkMillis,
    setCurrentDurationMillis,
    resetDraft,
  } = useRecordingNotes();
  const course = getCourse(params.courseId);
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
    finalCaptions,
    startLiveCaptions,
    stopLiveCaptions,
    resetCaptions,
    sendAudioChunk,
  } = useLiveCaptions();

  const [micStreamError, setMicStreamError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [materialPickerVisible, setMaterialPickerVisible] = useState(false);
  const [importingMaterial, setImportingMaterial] = useState(false);
  const [pendingLectureId] = useState(() => reserveLectureId());
  const toast = useRef(new Animated.Value(0)).current;
  const autoStarted = useRef(false);
  const isRecordingRef = useRef(false);
  const recoverCaptionsRef = useRef<() => void>(() => {});
  const finishedRef = useRef(false);
  const lecturesRef = useRef(lectures);

  const granted = permissionStatus === 'granted';
  const seconds = Math.floor(durationMillis / 1000);
  const recordingSessionActive = isRecording || isPaused || durationMillis > 0;
  const latestFinalEnglish = latestFinalLine?.text ?? captionLines[captionLines.length - 1]?.text ?? '';
  const visibleEnglishCaption = partialCaption || latestFinalEnglish || latestCaption;
  const visibleChineseCaption = partialTranslationZh || latestFinalLine?.translationZh || '';
  const courseMaterials = course ? materialsForCourse(course.id) : [];

  useEffect(() => {
    lecturesRef.current = lectures;
  }, [lectures]);

  // Start live captions, then the live PCM mic stream. The local lecture
  // recorder is already running by this point (recorder-first order), so the
  // mic stream configures the iOS audio session and attaches its tap last.
  // The no-PCM watchdog and single defensive retry live inside liveMicStream.
  const startCaptionPipeline = async () => {
    resetCaptions();
    setMicStreamError(null);
    await startLiveCaptions(48_000);
    const micStatus = await startMicStream({
      sampleRate: 48_000,
      onPcm16Frame: (frame) => {
        sendAudioChunk(frame);
      },
      onUnavailable: () => {
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
      // The "needs a development build" note is fine to show as-is; any other
      // startup failure is collapsed to the calm user-facing line.
      setMicStreamError(
        micStatus.isSupported ? LIVE_CAPTIONS_UNAVAILABLE_MESSAGE : micStatus.error,
      );
    }
  };

  // Stop the live mic stream + live caption WebSocket (and their timers) when
  // the recording screen is left. Pushing Mini does not unmount this screen.
  useEffect(() => () => {
    stopMicStream();
    stopLiveCaptions();
  }, [stopLiveCaptions]);

  // Start each recording session with an empty Mini Workspace draft.
  useEffect(() => {
    resetDraft();
  }, [resetDraft]);

  // If the user abandons the recording before Finish creates the Lecture,
  // discard any temporary material links created against the reserved id.
  useEffect(() => {
    return () => {
      if (!finishedRef.current) {
        cleanupOrphanMaterialLinks(lecturesRef.current.map((lecture) => lecture.id));
      }
    };
  }, [cleanupOrphanMaterialLinks]);

  // Recording is the authoritative clock. Mini mirrors this value rather than
  // maintaining its own mark timeline, so marks from either surface align.
  useEffect(() => {
    setCurrentDurationMillis(durationMillis);
  }, [durationMillis, setCurrentDurationMillis]);

  // Begin recording automatically when the screen opens with permission
  // granted. The local recorder starts first so it owns the audio session;
  // the live caption mic stream then attaches on top without being clobbered.
  useEffect(() => {
    if (autoStarted.current || !granted) return;
    autoStarted.current = true;
    void startRecording().then((started) => {
      if (started) void startCaptionPipeline();
    });
  }, [granted]);

  // Keep this fresh for the mount-once AppState listener below.
  isRecordingRef.current = isRecording;
  recoverCaptionsRef.current = () => {
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
    });
    return () => sub.remove();
  }, []);

  const handleAllow = async () => {
    autoStarted.current = true;
    const started = await startRecording();
    if (started) await startCaptionPipeline();
  };

  const togglePause = () => {
    if (isPaused) {
      resumeRecording();
      void startCaptionPipeline();
    } else {
      pauseRecording();
      stopMicStream();
      stopLiveCaptions();
    }
  };

  const markImportant = () => {
    addMarkMillis(durationMillis);
    toast.setValue(1);
    Animated.timing(toast, {
      toValue: 0,
      duration: 1900,
      useNativeDriver: true,
    }).start();
  };

  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    finishedRef.current = true;
    const finalDuration = durationMillis;
    stopMicStream();
    stopLiveCaptions();
    const uri = await stopRecording();
    const lecture = createLecture({
      id: pendingLectureId,
      courseId: params.courseId ?? '',
      title: (params.lectureTitle ?? '').trim() || 'Untitled Lecture',
      durationMillis: finalDuration,
      localAudioUri: uri,
      markedTimestamps: marks.map((mark) => mark.timestampMillis),
      liveTranscript: finalCaptions.join('\n'),
      notes: draftNotes,
      noteStrokes: draftStrokes,
    });
    resetDraft();
    router.replace({ pathname: '/processing', params: { lectureId: lecture.id } });
  };

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
      Alert.alert('Could not import material', result.reason);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={24} color={colors.deepNavy} />
        </Pressable>

        <Text style={styles.headerTitle} numberOfLines={1}>
          {courseName}
        </Text>

        {granted ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mini caption mode"
            onPress={openMiniCaption}
            hitSlop={10}
            style={({ pressed }) => [
              styles.iconBtn,
              styles.iconBtnLabelled,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons name="contract-outline" size={19} color={colors.deepNavy} />
            <Text style={styles.iconBtnLabel}>Mini</Text>
          </Pressable>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      {/* While the permission state is still being read */}
      {!permissionChecked && (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.deepNavy} />
        </View>
      )}

      {/* Calm permission state */}
      {permissionChecked && !granted && (
        <View style={styles.centered}>
          <View style={styles.permIcon}>
            <Ionicons name="mic-outline" size={36} color={colors.deepNavy} />
          </View>
          <Text style={styles.permTitle}>Microphone access needed</Text>
          <Text style={styles.permBody}>
            Microphone access is needed to record your lecture.
            {permissionStatus === 'denied'
              ? ' Turn it on for Youmi Lens in your iPad Settings.'
              : ''}
          </Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <PrimaryButton
            label={permissionStatus === 'denied' ? 'Open Settings' : 'Allow Microphone'}
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
              Important moment marked at {formatClock(seconds)}
            </Text>
          </Animated.View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.content}>
              {/* Timer — the visual centre of the screen */}
              <View style={styles.timerBlock}>
                <StatusPill
                  label={isPaused ? 'PAUSED' : 'RECORDING'}
                  variant={isPaused ? 'paused' : 'recording'}
                />
                <Text style={styles.timer}>{formatClock(seconds)}</Text>
                <Text style={styles.timerHint}>
                  {marks.length > 0
                    ? `${marks.length} important moment${marks.length > 1 ? 's' : ''} marked`
                    : 'Tap Mark Important to flag key moments'}
                </Text>
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
              </View>

              {course ? (
                <View style={styles.recordingToolRow}>
                  <SecondaryButton
                    label="Use Course Material"
                    icon="document-text-outline"
                    disabled={!recordingSessionActive || finishing}
                    onPress={() => setMaterialPickerVisible(true)}
                    style={styles.recordingToolButton}
                  />
                </View>
              ) : null}

              <GlassCard padding={spacing.xl}>
                <View style={styles.stateHeader}>
                  <View style={[styles.stateIcon, isPaused && styles.stateIconPaused]}>
                    <Ionicons
                      name={liveCaptionStatus === 'active' ? 'chatbubble-ellipses' : isPaused ? 'pause' : 'mic'}
                      size={20}
                      color={isPaused ? colors.mutedBlueGray : colors.deepNavy}
                    />
                  </View>
                  <View style={styles.stateHeaderText}>
                    <Text style={styles.stateTitle}>Live captions</Text>
                    <Text style={styles.stateStatus}>
                      {liveCaptionStatus === 'connecting'
                        ? 'Connecting…'
                        : liveCaptionStatus === 'active'
                          ? 'Live captions active'
                          : liveCaptionStatus === 'listening'
                            ? 'Listening for speech…'
                            : liveCaptionStatus === 'unavailable'
                              ? 'Live captions unavailable'
                              : liveCaptionStatus === 'error'
                                ? 'Live captions unavailable'
                                : 'Preparing live captions'}
                    </Text>
                  </View>
                </View>

                {liveCaptionStatus === 'active' || liveCaptionStatus === 'listening' || visibleEnglishCaption ? (
                  <View style={styles.captionBody}>
                    {/* English — primary live caption: large, bold */}
                    <View style={styles.captionSection}>
                      <Text style={styles.captionLabel}>ENGLISH</Text>
                      <Text style={styles.captionPrimary}>
                        {visibleEnglishCaption || 'Listening for speech…'}
                      </Text>
                    </View>
                    {/* Chinese — translation support: smaller, lighter. Shown
                        when it has text, or briefly while a finalised English
                        line is still being translated. */}
                    {visibleChineseCaption ? (
                      <View style={styles.captionSection}>
                        <Text style={styles.captionLabel}>中文</Text>
                        <Text style={styles.captionSecondary}>{visibleChineseCaption}</Text>
                      </View>
                    ) : latestFinalLine && !partialCaption ? (
                      <View style={styles.captionSection}>
                        <Text style={styles.captionLabel}>中文</Text>
                        <Text style={styles.captionTranslating}>Translating…</Text>
                      </View>
                    ) : null}
                  </View>
                ) : liveCaptionStatus === 'connecting' ? (
                  <Text style={styles.stateBody}>Connecting live captions…</Text>
                ) : (
                  <View style={styles.captionFallback}>
                    <Text style={styles.stateBody}>
                      {micStreamError ?? liveCaptionError ?? LIVE_CAPTIONS_UNAVAILABLE_MESSAGE}
                    </Text>
                    <SecondaryButton
                      label="Retry captions"
                      icon="refresh-outline"
                      onPress={() => void startCaptionPipeline()}
                      style={styles.retryCaptionsButton}
                    />
                  </View>
                )}
              </GlassCard>
            </View>
          </ScrollView>

          {/* Actions — Mark Important · Pause/Resume · Finish */}
          <View style={styles.actions}>
            <SecondaryButton
              label="Mark Important"
              icon="star"
              onPress={markImportant}
              style={styles.sideAction}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isPaused ? 'Resume recording' : 'Pause recording'}
              onPress={togglePause}
              style={({ pressed }) => [styles.roundBtn, pressed && styles.pressed]}
            >
              <Ionicons
                name={isPaused ? 'play' : 'pause'}
                size={32}
                color={colors.pearlWhite}
              />
            </Pressable>

            <SecondaryButton
              label="Finish"
              icon="checkmark-done"
              danger
              disabled={finishing}
              onPress={finish}
              style={styles.sideAction}
            />
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
                    <Text style={styles.materialModalTitle}>Use course material</Text>
                    <Text style={styles.materialModalSubtitle} numberOfLines={1}>
                      {course?.name ?? 'Current course'}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close material picker"
                    onPress={() => setMaterialPickerVisible(false)}
                    style={({ pressed }) => [styles.materialModalClose, pressed && styles.pressed]}
                  >
                    <Ionicons name="close" size={20} color={colors.deepNavy} />
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
                          <Ionicons name="document-text-outline" size={19} color={colors.deepNavy} />
                        </View>
                        <View style={styles.materialPickerBody}>
                          <Text style={styles.materialPickerTitle} numberOfLines={1}>{material.title}</Text>
                          <Text style={styles.materialPickerMeta}>
                            {material.pageCount ? `${material.pageCount} pages` : 'PDF material'}
                          </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                      </Pressable>
                    ))}
                  </ScrollView>
                ) : (
                  <View style={styles.materialEmptyState}>
                    <Ionicons name="folder-open-outline" size={34} color={colors.mutedBlueGray} />
                    <Text style={styles.materialEmptyTitle}>No materials in this course yet.</Text>
                    <Text style={styles.materialEmptyBody}>
                      Import a PDF into this course, then use it during this lecture.
                    </Text>
                  </View>
                )}

                <SecondaryButton
                  label={importingMaterial ? 'Importing…' : 'Import PDF'}
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
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
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
    color: colors.deepNavy,
  },
  headerSpacer: {
    width: 44,
    height: 44,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    marginHorizontal: spacing.md,
  },

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
    backgroundColor: colors.iceTint,
    borderWidth: 1,
    borderColor: colors.iceBlue,
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
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    justifyContent: 'center',
  },
  content: {
    width: '100%',
    maxWidth: layout.content,
    alignSelf: 'center',
    gap: spacing.xl,
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
    backgroundColor: colors.iceTint,
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
    gap: spacing.lg,
  },
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
    fontSize: fontSize.xxl,
    lineHeight: fontSize.xxl * 1.34,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  captionSecondary: {
    fontSize: fontSize.lg,
    lineHeight: fontSize.lg * 1.55,
    color: colors.textSecondary,
    fontWeight: '500',
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

  // ---- Actions ----
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    maxWidth: layout.content,
    width: '100%',
    alignSelf: 'center',
  },
  sideAction: {
    flex: 1,
  },
  roundBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.deepNavy,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.button,
  },
  materialModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(6, 27, 52, 0.32)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  materialModalCard: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '72%',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    gap: spacing.md,
    shadowColor: '#0A2342',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.18,
    shadowRadius: 30,
    elevation: 12,
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
    backgroundColor: colors.iceTint,
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
