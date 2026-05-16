import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Linking,
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
import { useLiveCaptions } from '@/lib/liveCaptions';
import {
  getLiveMicStreamStatus,
  startMicStream,
  stopMicStream,
} from '@/lib/liveMicStream';
import { useData } from '@/lib/store';
import { useLectureRecorder } from '@/lib/useLectureRecorder';

export default function RecordingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ courseId?: string; lectureTitle?: string }>();
  const { getCourse, createLecture } = useData();
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
    finalCaptions,
    startLiveCaptions,
    stopLiveCaptions,
    resetCaptions,
    sendAudioChunk,
  } = useLiveCaptions();

  const [marks, setMarks] = useState<number[]>([]);
  const [pcmFramesReceived, setPcmFramesReceived] = useState(0);
  const [micStreamError, setMicStreamError] = useState<string | null>(null);
  const [lastCaptionAt, setLastCaptionAt] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const toast = useRef(new Animated.Value(0)).current;
  const autoStarted = useRef(false);

  const granted = permissionStatus === 'granted';
  const seconds = Math.floor(durationMillis / 1000);

  useEffect(() => {
    if (latestCaption) setLastCaptionAt(new Date().toLocaleTimeString());
  }, [latestCaption]);

  const startCaptionPipeline = async () => {
    resetCaptions();
    setPcmFramesReceived(0);
    setMicStreamError(null);
    await startLiveCaptions(48_000);
    const micStatus = await startMicStream({
      sampleRate: 48_000,
      onPcm16Frame: (frame) => {
        sendAudioChunk(frame);
        setPcmFramesReceived(getLiveMicStreamStatus().framesReceived);
      },
    });
    if (micStatus.error) setMicStreamError(micStatus.error);
  };

  // Begin recording automatically when the screen opens with permission granted.
  useEffect(() => {
    if (autoStarted.current || !granted) return;
    autoStarted.current = true;
    void startRecording().then((started) => {
      if (started) void startCaptionPipeline();
    });
  }, [granted]);

  const handleAllow = async () => {
    autoStarted.current = true;
    const started = await startRecording();
    if (started) {
      await startCaptionPipeline();
    }
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
    setMarks((m) => [...m, durationMillis]);
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
    const finalDuration = durationMillis;
    stopMicStream();
    stopLiveCaptions();
    const uri = await stopRecording();
    const lecture = createLecture({
      courseId: params.courseId ?? '',
      title: (params.lectureTitle ?? '').trim() || 'Untitled Lecture',
      durationMillis: finalDuration,
      localAudioUri: uri,
      markedTimestamps: marks,
      liveTranscript: finalCaptions.join('\n'),
    });
    router.replace({ pathname: '/processing', params: { lectureId: lecture.id } });
  };

  const openMiniCaption = () => {
    router.push({ pathname: '/mini-caption', params: { elapsed: String(seconds) } });
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

                {liveCaptionStatus === 'active' || liveCaptionStatus === 'listening' ? (
                  <>
                    <Text style={styles.captionLead}>
                      {partialCaption || latestCaption || 'Listening for speech…'}
                    </Text>
                    {finalCaptions.length > 0 ? (
                      <View style={styles.captionHistory}>
                        {finalCaptions.slice(-4).map((caption, index) => (
                          <Text key={`${caption}-${index}`} style={styles.captionHistoryLine}>
                            {caption}
                          </Text>
                        ))}
                      </View>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.stateBody}>
                    {micStreamError ?? liveCaptionError ?? 'Live captions are unavailable. Audio recording is still active.'}
                  </Text>
                )}
                <View style={styles.liveDebugRow}>
                  <Text style={styles.liveDebugText}>WS: {liveCaptionStatus}</Text>
                  <Text style={styles.liveDebugText}>PCM frames: {pcmFramesReceived}</Text>
                  {lastCaptionAt ? <Text style={styles.liveDebugText}>Last caption: {lastCaptionAt}</Text> : null}
                </View>
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
  captionLead: {
    fontSize: fontSize.xl,
    lineHeight: fontSize.xl * 1.45,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  captionHistory: {
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  captionHistoryLine: {
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.45,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  liveDebugRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  liveDebugText: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textTertiary,
  },
  stateBody: {
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.5,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  cardDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.lg,
  },
  stateZh: {
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.6,
    color: colors.secondaryNavy,
    fontWeight: '500',
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
});
