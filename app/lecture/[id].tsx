import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { AppBackground } from '@/components/AppBackground';
import { HandwritingPreview, NotebookCanvas } from '@/components/NotebookCanvas';
import { LectureSectionHeader } from '@/components/LectureSectionHeader';
import { MoveLectureToCourseModal } from '@/components/MoveLectureToCourseModal';
import { RenameModal } from '@/components/RenameModal';
import { PressableScale } from '@/components/PressableScale';
import { StatusPill, StatusVariant } from '@/components/StatusPill';
import { TranscriptReadList, TranscriptReadPrewarmer } from '@/components/TranscriptReadList';
import { WorkspaceSidebar } from '@/components/WorkspaceSidebar';
import { isPad } from '@/constants/deviceClass';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { exportLectureNotesPdf, hasExportableLectureNotes } from '@/lib/exportLectureNotesPdf';
import { formatClock, formatDate, formatDuration } from '@/lib/format';
import { useI18n, localizeSystemDefaultTitle } from '@/lib/i18n';
import {
  getSummarySectionLabel,
  getTranscriptSectionLabel,
} from '@/lib/languageContent';
import { resolveLectureLanguagePair, shouldTranslate } from '@/lib/contentLanguages.mjs';
import type { NoteStroke } from '@/lib/models';
import {
  getEditableSummaryText,
  hasUserEditedSummary,
} from '@/lib/summaryEdit.mjs';
import {
  getEditableTranscriptText,
  hasUserEditedTranscript,
} from '@/lib/transcriptEdit.mjs';
import {
  SUMMARY_CARD_STYLE,
  SUMMARY_PAGE_SCROLL_STYLE,
  SUMMARY_STACK_STYLE,
} from '@/lib/summaryLayout.mjs';
import { useData } from '@/lib/store';
import {
  resolveLectureAudioPlaybackState,
  shouldShowAudioPlayer,
} from '@/lib/lectureLocalAudio';
import { useRecordingNotes } from '@/lib/recordingNotes';
import { requestCloudLectureAudio } from '@/lib/cloudLectureAudio.mjs';
import { API_BASE_URL } from '@/lib/config';
import { useAuth } from '@/lib/auth';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const TABS = ['Summary', 'Transcript', 'Marked', 'Notes'] as const;
type Tab = (typeof TABS)[number];

// expo-audio's underlying AVPlayer never surfaces a load *failure* to JS (an
// AVPlayerItem going `.failed` — e.g. an expired signed URL — is silent:
// `isLoaded` just never becomes true, no error, no event). This bounded wait
// is the only way to notice a stuck cloud source and either recover or tell
// the user, instead of leaving a queued tap hanging forever.
const LOAD_TIMEOUT_MS = 8000;
// A finished track is left parked at `duration` by the native layer (it does
// not auto-rewind). Treat "at or past duration" as ended so replay always
// seeks to 0 first, regardless of which ended-signal actually fired.
const REPLAY_EPSILON_SEC = 0.25;

export default function LectureDetailScreen() {
  const { t, language } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const { courses, getLecture, getCourse, updateLecture, renameLecture, moveLectureToCourse } = useData();
  const { isLectureSessionActive } = useRecordingNotes();
  const { session } = useAuth();

  const lecture = getLecture(params.id);
  const course = getCourse(lecture?.courseId);

  const [tab, setTab] = useState<Tab>('Summary');
  const [notesDraft, setNotesDraft] = useState(lecture?.notes ?? '');
  const [strokesDraft, setStrokesDraft] = useState<NoteStroke[]>(lecture?.noteStrokes ?? []);
  const [imagesDraft, setImagesDraft] = useState(lecture?.noteImages ?? []);
  const [notesOpen, setNotesOpen] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [moveVisible, setMoveVisible] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [cloudRetry, setCloudRetry] = useState(0);
  const [cloudAudio, setCloudAudio] = useState<{ url: string | null; loading: boolean; failed: boolean }>({
    url: null,
    loading: false,
    failed: false,
  });
  const retriedExpiredCloudUrl = useRef(false);
  const pendingPlayIntentRef = useRef(false);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Forces useAudioPlayer to construct a genuinely NEW native player instance
  // (not an in-place item swap) for ended-replay. Verified on-device: both
  // seekTo(0)+play() and player.replace()+play() leave AVPlayer silently
  // paused after end-of-item; only a from-scratch AudioPlayer construction —
  // the exact path a fresh screen mount already takes reliably — resumes.
  const [suspendPlayerSource, setSuspendPlayerSource] = useState(false);
  const { width } = useWindowDimensions();
  const compactLayout = width < 1180;
  const isPhoneWidth = useIsCompactWidth();
  const audioPlayback = useMemo(
    () =>
      resolveLectureAudioPlaybackState({
        localAudioUri: lecture?.localAudioUri,
        storagePath: lecture?.storagePath,
        lectureId: lecture?.id,
      }),
    [lecture?.localAudioUri, lecture?.storagePath, lecture?.id],
  );
  const cloudRecordingId = lecture?.remoteRecordingId ?? lecture?.id ?? null;
  const cloudRequired = audioPlayback.kind === 'cloud';

  useEffect(() => {
    let cancelled = false;
    if (!cloudRequired || !cloudRecordingId) {
      setCloudAudio({ url: null, loading: false, failed: false });
      return () => { cancelled = true; };
    }

    setCloudAudio({ url: null, loading: true, failed: false });
    void requestCloudLectureAudio({
      apiBaseUrl: API_BASE_URL,
      recordingId: cloudRecordingId,
      accessToken: session?.access_token,
    })
      .then(({ signedUrl }) => {
        if (!cancelled) setCloudAudio({ url: signedUrl, loading: false, failed: false });
      })
      .catch((error) => {
        if (__DEV__) console.warn('[lecture] cloud audio resolution failed', error);
        if (!cancelled) setCloudAudio({ url: null, loading: false, failed: true });
      });
    return () => { cancelled = true; };
  }, [cloudRequired, cloudRecordingId, session?.access_token, cloudRetry]);

  const audioUri = audioPlayback.kind === 'local' ? audioPlayback.uri : cloudAudio.url;
  const audioAvailable = audioPlayback.kind === 'local'
    ? shouldShowAudioPlayer(audioPlayback)
    : Boolean(cloudAudio.url && shouldShowAudioPlayer(audioPlayback));
  const player = useAudioPlayer(
    audioAvailable && !suspendPlayerSource ? { uri: audioUri ?? '' } : null,
    { updateInterval: 250 },
  );
  const audioStatus = useAudioPlayerStatus(player);
  const playbackDuration = audioStatus.duration || (lecture?.durationMillis ?? 0) / 1000;
  const playbackProgress = playbackDuration > 0 ? Math.min(audioStatus.currentTime / playbackDuration, 1) : 0;

  // One-tick null→real flip: releases the (ended) native player, then
  // reconstructs it fresh on the very next render.
  useEffect(() => {
    if (suspendPlayerSource) {
      setSuspendPlayerSource(false);
    }
  }, [suspendPlayerSource]);

  // Heal stale sandbox URIs once a playable path is resolved.
  useEffect(() => {
    if (!lecture) return;
    if (
      audioPlayback.kind === 'local' &&
      audioPlayback.uri &&
      audioPlayback.uri !== lecture.localAudioUri
    ) {
      updateLecture(lecture.id, { localAudioUri: audioPlayback.uri });
    }
  }, [lecture, audioPlayback.kind, audioPlayback.uri, updateLecture]);

  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {
        /* best-effort cleanup on navigate away */
      }
    };
  }, [player]);

  const clearLoadTimeout = () => {
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  };

  const armLoadTimeout = () => {
    clearLoadTimeout();
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      if (!pendingPlayIntentRef.current) return;
      if (cloudRequired && !retriedExpiredCloudUrl.current) {
        if (__DEV__) console.info('[lecture] play: load timeout — re-resolving cloud URL once');
        retriedExpiredCloudUrl.current = true;
        setCloudRetry((value) => value + 1);
        armLoadTimeout();
        return;
      }
      if (__DEV__) console.info('[lecture] play: load timeout — giving up');
      pendingPlayIntentRef.current = false;
      Alert.alert(t('lecture.audioUnavailable'), t('lecture.tryAgain'));
    }, LOAD_TIMEOUT_MS);
  };

  // A tap queued while the player was still loading (cloud network fetch, a
  // just-swapped source after a signed-URL refresh, or a freshly-reconstructed
  // instance after ended-replay) starts automatically the moment the player
  // reports ready — the tap's intent is never dropped.
  //
  // Reads player.isLoaded/player.playing directly (synchronous native
  // getters), NOT audioStatus.isLoaded/.playing: useAudioPlayerStatus's
  // useEvent() seeds its React state with `initialValue` only on that hook's
  // very first mount (React ignores a changed lazy-init argument on later
  // renders) — proven on-device: right after a player-identity swap,
  // audioStatus briefly still reports the PREVIOUS player's last-known
  // values (e.g. currentTime at the old duration) for one render, before a
  // genuinely fresh event arrives from the new player. The synchronous
  // properties on the player object itself never have that lag. The effect
  // still re-runs on `audioStatus` changes (needed as the re-check trigger —
  // a replace-style reload can report the same isLoaded/playing primitive
  // values it already held, which the dependency array's Object.is check
  // would otherwise treat as "unchanged"), but the CONDITION is evaluated
  // against the live player, not the lagging React-state mirror of it.
  useEffect(() => {
    if (pendingPlayIntentRef.current && player.isLoaded && !player.playing) {
      pendingPlayIntentRef.current = false;
      clearLoadTimeout();
      if (__DEV__) console.info('[lecture] play: queued intent resolved — starting playback');
      player.play();
    }
  }, [audioStatus, player]);

  // If the source disappears (cloud resolution failed, local file went
  // missing) a stale queued tap must not fire a delayed alert later.
  useEffect(() => {
    if (!audioAvailable) {
      pendingPlayIntentRef.current = false;
      clearLoadTimeout();
    }
  }, [audioAvailable]);

  // True-unmount-only: a queued intent must survive a mid-flight player swap
  // (the signed-URL retry above swaps `player`), so it is not cleared by the
  // effect above, which is keyed to `[player]` and fires on every swap.
  useEffect(() => {
    return () => {
      clearLoadTimeout();
      pendingPlayIntentRef.current = false;
    };
  }, []);

  const togglePlayback = useCallback(async () => {
    if (!audioAvailable) return;
    if (isLectureSessionActive) {
      Alert.alert(t('lecture.audioUnavailable'), t('lecture.playbackBlockedRecording'));
      return;
    }
    if (__DEV__) {
      console.info('[lecture] play tap', {
        playing: audioStatus.playing,
        isLoaded: audioStatus.isLoaded,
        cloudRequired,
      });
    }
    try {
      if (audioStatus.playing) {
        pendingPlayIntentRef.current = false;
        clearLoadTimeout();
        player.pause();
        return;
      }
      // Recording leave/stop leaves the session in ambient/record mode;
      // switch to audible playback before starting the player.
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      const hasEnded =
        playbackDuration > 0 && audioStatus.currentTime >= playbackDuration - REPLAY_EPSILON_SEC;
      if (hasEnded) {
        // Neither seekTo(0)+play() nor player.replace()+play() reliably
        // resumed AVPlayer once it had already fired end-of-item when tested
        // on-device — a from-scratch AudioPlayer construction (the exact
        // path a fresh screen mount already takes reliably every time) is
        // what actually resumes it. Queue the tap exactly like a
        // still-loading cloud source so it starts the moment the
        // freshly-reconstructed player reports ready.
        if (__DEV__) console.info('[lecture] play: ended — forcing a fresh player instance');
        pendingPlayIntentRef.current = true;
        armLoadTimeout();
        setSuspendPlayerSource(true);
        return;
      }
      if (!audioStatus.isLoaded) {
        // Cloud source still resolving/buffering — queue the tap instead of
        // dropping it; the effect above fires play() once isLoaded flips true.
        if (__DEV__) console.info('[lecture] play: not loaded yet — queuing intent');
        pendingPlayIntentRef.current = true;
        armLoadTimeout();
        return;
      }
      pendingPlayIntentRef.current = false;
      clearLoadTimeout();
      if (__DEV__) console.info('[lecture] play: loaded — calling player.play()');
      player.play();
    } catch (err) {
      console.warn('[lecture] playback failed', err);
      // A signed URL can expire between resolution and play. Reacquire exactly
      // once, and honor the tap that already expressed intent — the queued-
      // intent effect above starts playback once the fresh source is ready.
      if (cloudRequired && !retriedExpiredCloudUrl.current) {
        retriedExpiredCloudUrl.current = true;
        pendingPlayIntentRef.current = true;
        setCloudRetry((value) => value + 1);
        return;
      }
      pendingPlayIntentRef.current = false;
      Alert.alert(t('lecture.audioUnavailable'), t('lecture.tryAgain'));
    }
  }, [
    audioAvailable,
    audioStatus.currentTime,
    audioStatus.isLoaded,
    audioStatus.playing,
    cloudRequired,
    isLectureSessionActive,
    playbackDuration,
    player,
    t,
  ]);

  const openTranscriptEditor = useCallback((side: 'source' | 'translated') => {
    if (!lecture) return;
    router.push(`/lecture/${lecture.id}/transcript-edit?side=${side}` as Href);
  }, [lecture, router]);

  if (!lecture) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.notFound}>
          <Ionicons name="document-outline" size={36} color={colors.mutedBlueGray} />
          <Text style={styles.notFoundText}>{t('lecture.notFound')}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/')}
            style={({ pressed }) => [styles.notFoundBtn, pressed && styles.pressed]}
          >
            <Text style={styles.notFoundBtnText}>{t('lecture.backHome')}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // Transcript + summary follow the lecture's persisted source/translation pair.
  const { sourceLanguage, translationLanguage } = resolveLectureLanguagePair(lecture);
  const hasTranslation = shouldTranslate(sourceLanguage, translationLanguage);
  const sourceTranscript = getEditableTranscriptText(lecture, 'source');
  const translatedTranscript = getEditableTranscriptText(lecture, 'translated');
  const sourceSummary = getEditableSummaryText(lecture, 'source');
  const translatedSummary = getEditableSummaryText(lecture, 'translated');
  const summariesReady =
    Boolean(sourceSummary.trim()) && (!hasTranslation || Boolean(translatedSummary.trim()))
    || hasUserEditedSummary(lecture)
    || lecture.processingStatus === 'ready';
  const canEditSummaries = summariesReady || hasUserEditedSummary(lecture) || lecture.processingStatus === 'ready';
  const canEditTranscripts =
    lecture.processingStatus === 'ready'
    || hasUserEditedTranscript(lecture)
    || Boolean(sourceTranscript.trim())
    || Boolean(translatedTranscript.trim());
  const transcriptDocumentVersion =
    lecture.transcriptUpdatedAt
    ?? lecture.remoteAiStatus
    ?? lecture.processingStatus
    ?? 'unmodified';
  const transcriptCacheKey = [
    lecture.id,
    transcriptDocumentVersion,
    sourceLanguage,
    translationLanguage,
    canEditTranscripts ? 'ready' : 'pending',
    sourceTranscript.length,
    translatedTranscript.length,
  ].join(':');
  const transcriptReadProps = {
    cacheKey: transcriptCacheKey,
    sourceLanguage,
    sourceLabel: getTranscriptSectionLabel(sourceLanguage),
    sourceText: canEditTranscripts ? sourceTranscript : '',
    translatedLanguage: hasTranslation ? translationLanguage : undefined,
    translatedLabel: hasTranslation ? getTranscriptSectionLabel(translationLanguage) : undefined,
    translatedText: hasTranslation && canEditTranscripts ? translatedTranscript : undefined,
  };

  const openSummaryEditor = (side: 'source' | 'translated') => {
    if (!canEditSummaries) return;
    router.push(`/lecture/${lecture.id}/summary-edit?side=${side}` as Href);
  };
  const cjk = (lang: string) => lang === 'zh-Hans' || lang === 'ja' || lang === 'ko';
  const typedNotes = lecture.notes.trim();
  const strokeCount = lecture.noteStrokes?.length ?? 0;
  const notesHasContent = typedNotes.length > 0 || strokeCount > 0;
  const status =
    lecture.processingStatus === 'ready'
      ? { label: t('status.ready'), variant: 'done' as StatusVariant }
      : lecture.processingStatus === 'processing'
        ? { label: t('status.processing'), variant: 'processing' as StatusVariant }
        : lecture.processingStatus === 'failed'
          ? { label: t('status.failed'), variant: 'idle' as StatusVariant }
          : { label: t('status.recorded'), variant: 'idle' as StatusVariant };

  const openNotesEditor = () => {
    // Notebook (the handwritten + typed Pencil editor) is an iPad-only
    // experience. iPhone never mounts NotebookCanvas or navigates into the
    // editor — it sees a concise notice instead. No draft state is touched,
    // so nothing here is at risk of divergent Notes data.
    if (!isPad) {
      Alert.alert(t('lecture.notebookIpadOnly'));
      return;
    }
    setNotesDraft(lecture.notes);
    setStrokesDraft(lecture.noteStrokes ?? []);
    setImagesDraft(lecture.noteImages ?? []);
    setNotesOpen(true);
  };

  const saveNotes = () => {
    updateLecture(lecture.id, {
      notes: notesDraft,
      noteStrokes: strokesDraft,
      noteImages: imagesDraft,
      noteUpdatedAt: new Date().toISOString(),
    });
    setNotesOpen(false);
  };

  const handleExportPdf = async () => {
    if (!hasExportableLectureNotes(lecture)) {
      Alert.alert(t('lecture.nothingExport'), t('lecture.noNotesExport'));
      return;
    }

    setExportingPdf(true);
    try {
      await exportLectureNotesPdf({ lecture, course });
    } catch (err) {
      // Raw technical detail stays in logs; the user sees a localized generic message.
      console.warn('[lecture] PDF export failed', err);
      Alert.alert(
        t('lecture.exportFailed'),
        t('lecture.tryAgain'),
      );
    } finally {
      setExportingPdf(false);
    }
  };

  const seekToSeconds = async (seconds: number) => {
    if (!audioAvailable) return;
    await player.seekTo(Math.max(0, Math.min(seconds, playbackDuration || seconds)));
  };

  const skipBy = async (delta: number) => {
    await seekToSeconds(audioStatus.currentTime + delta);
  };

  return (
    <View style={styles.root}>
      <AppBackground />
      <WorkspaceSidebar active="record" />
      <SafeAreaView style={styles.detail} edges={['top', 'right', 'bottom']}>
      {/* Header */}
      <View style={[styles.header, isPhoneWidth && styles.headerCompact]}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          onPress={() => router.back()}
          hitSlop={10}
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </PressableScale>
        {course && !isPhoneWidth ? (
          <View style={styles.courseTile}>
            <Ionicons
              name={course.icon as IoniconName}
              size={20}
              color={colors.textSecondary}
            />
          </View>
        ) : null}
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {localizeSystemDefaultTitle(t, lecture.title)}
          </Text>
          <Text style={styles.headerMeta} numberOfLines={1}>
            {course?.name ? localizeSystemDefaultTitle(t, course.name) : t('lecture.defaultCourse')} · {formatDate(lecture.date, language)} ·{' '}
            {formatDuration(lecture.durationMillis)}
          </Text>
        </View>
        <StatusPill label={status.label} variant={status.variant} />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('course.renameLecture')}
          onPress={() => setRenameVisible(true)}
          hitSlop={8}
          style={styles.iconBtn}
        >
          <Ionicons name="pencil-outline" size={20} color={colors.textPrimary} />
        </PressableScale>
        {!lecture.deletedAt ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('lecture.moveToCourse')}
            onPress={() => setMoveVisible(true)}
            hitSlop={8}
            style={styles.iconBtn}
          >
            <Ionicons name="swap-horizontal-outline" size={20} color={colors.textPrimary} />
          </PressableScale>
        ) : null}
      </View>

      <View style={[styles.playerWrap, isPhoneWidth && styles.playerWrapCompact]}>
        <GlassCard padding={16}>
          {audioAvailable ? (
            isPhoneWidth ? (
              // Phone: the familiar mobile player shape — seek bar with time
              // labels spans the full width, transport controls sit centered
              // below with Play/Pause as the obviously largest control.
              <View style={styles.playerStack}>
                <View style={styles.playerSeekRow}>
                  <Text style={styles.playerTimeText}>{formatClock(Math.floor(audioStatus.currentTime))}</Text>
                  <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${playbackProgress * 100}%` }]} /></View>
                  <Text style={styles.playerTimeText}>{formatClock(Math.floor(playbackDuration))}</Text>
                </View>
                <View style={styles.playerTransportRow}>
                  <PressableScale accessibilityRole="button" accessibilityLabel={t('lecture.skipBack')} onPress={() => void skipBy(-10)} style={styles.skipButtonCompact}><Text style={styles.skipText}>↺ 10s</Text></PressableScale>
                  <PressableScale accessibilityRole="button" onPress={() => void togglePlayback()} style={styles.playPauseButtonLarge}>
                    <Ionicons name={audioStatus.playing ? 'pause' : 'play'} size={26} color={colors.textOnNavy} />
                  </PressableScale>
                  <PressableScale accessibilityRole="button" accessibilityLabel={t('lecture.skipForward')} onPress={() => void skipBy(10)} style={styles.skipButtonCompact}><Text style={styles.skipText}>10s ↻</Text></PressableScale>
                </View>
              </View>
            ) : (
              <View style={[styles.compactPlayer, compactLayout && styles.compactPlayerNarrow]}>
                <PressableScale accessibilityRole="button" onPress={() => void togglePlayback()} style={styles.playPauseButton}>
                  <Ionicons name={audioStatus.playing ? 'pause' : 'play'} size={20} color={colors.textOnNavy} />
                </PressableScale>
                <PressableScale accessibilityRole="button" accessibilityLabel={t('lecture.skipBack')} onPress={() => void skipBy(-10)} style={styles.skipButton}><Text style={styles.skipText}>↺ 10s</Text></PressableScale>
                <Text style={styles.playerTimeText}>{formatClock(Math.floor(audioStatus.currentTime))}</Text>
                <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${playbackProgress * 100}%` }]} /></View>
                <Text style={styles.playerTimeText}>{formatClock(Math.floor(playbackDuration))}</Text>
                <PressableScale accessibilityRole="button" accessibilityLabel={t('lecture.skipForward')} onPress={() => void skipBy(10)} style={styles.skipButton}><Text style={styles.skipText}>10s ↻</Text></PressableScale>
              </View>
            )
          ) : cloudRequired && cloudAudio.loading ? (
            <View style={[styles.audioStateRow, isPhoneWidth && styles.audioStateRowCompact]}>
              <ActivityIndicator size="small" color={colors.accentBright} />
              <Text style={styles.emptyInline}>{t('lecture.audioCloudLoading')}</Text>
            </View>
          ) : cloudRequired && cloudAudio.failed ? (
            <View style={[styles.audioStateRow, isPhoneWidth && styles.audioStateRowCompact]}>
              <Text style={styles.emptyInline}>{t('lecture.audioCloudFailed')}</Text>
              <PressableScale accessibilityRole="button" onPress={() => setCloudRetry((value) => value + 1)} style={styles.audioRetryButton}>
                <Text style={styles.audioRetryText}>{t('lecture.audioRetry')}</Text>
              </PressableScale>
            </View>
          ) : (
            <Text style={styles.emptyInline}>
              {audioPlayback.kind === 'local-missing'
                ? t('lecture.audioLocalMissing')
                : t('lecture.audioUnavailable')}
            </Text>
          )}
        </GlassCard>
      </View>

      {/* Tab bar */}
      <TranscriptReadPrewarmer {...transcriptReadProps} />
      <View style={[styles.tabBar, isPhoneWidth && styles.tabBarCompact]}>
        {TABS.map((tabName) => {
          const active = tabName === tab;
          return (
            <PressableScale
              key={tabName}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setTab(tabName)}
              style={[styles.tab, isPhoneWidth && styles.tabCompact, active && styles.tabActive]}
            >
              <Text
                style={[styles.tabLabel, active && styles.tabLabelActive]}
                numberOfLines={1}
              >
                {t(`lecture.tab.${tabName.toLowerCase()}`)}
              </Text>
            </PressableScale>
          );
        })}
      </View>

      {/* NO opacity animation on the tab body — deliberately.
          A `swap` reveal used to fade this container on every tab change. On
          first open the timing animation could be interrupted before it
          reached 1, freezing Summary's text at partial opacity: it rendered
          gray until the user switched tabs and came back, which remounted the
          reveal and completed it. Static readable content must never depend on
          an animation finishing to be legible, and a segmented control's body
          does not need a fade — the selected state already changed on press. */}
      <View style={styles.tabBody}>
      {tab === 'Transcript' ? (
        <TranscriptReadList
          {...transcriptReadProps}
          canEdit={canEditTranscripts}
          pendingText={t('lecture.transcriptPending')}
          emptyText={t('lecture.transcriptEmpty')}
          onEdit={openTranscriptEditor}
        />
      ) : (
      <ScrollView
        style={styles.pageScroll}
        contentContainerStyle={[styles.scroll, isPhoneWidth && styles.scrollCompact]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.content}>
          {/* ---- Summary — source language, then translation when source != target ---- */}
          {tab === 'Summary' && (
            <View style={styles.summaryStack}>
              <GlassCard
                style={styles.summaryCard}
                onPress={canEditSummaries ? () => openSummaryEditor('source') : undefined}
              >
                <LectureSectionHeader
                  icon="language-outline"
                  label={getSummarySectionLabel(sourceLanguage)}
                  trailing={
                    canEditSummaries ? (
                      <Ionicons name="create-outline" size={16} color={colors.textTertiary} />
                    ) : null
                  }
                />
                {canEditSummaries ? (
                  sourceSummary.trim() ? (
                    <Text style={[styles.bodyText, cjk(sourceLanguage) && styles.bodyZh]}>{sourceSummary}</Text>
                  ) : (
                    <Text style={styles.emptyInline}>{t('lecture.summaryEmpty')}</Text>
                  )
                ) : (
                  <Text style={styles.emptyInline}>{t('lecture.summaryPending')}</Text>
                )}
              </GlassCard>
              {hasTranslation ? (
                <GlassCard
                  style={styles.summaryCard}
                  onPress={canEditSummaries ? () => openSummaryEditor('translated') : undefined}
                >
                  <LectureSectionHeader
                    icon="chatbubbles-outline"
                    label={getSummarySectionLabel(translationLanguage)}
                    trailing={
                      canEditSummaries ? (
                        <Ionicons name="create-outline" size={16} color={colors.textTertiary} />
                      ) : null
                    }
                  />
                  {canEditSummaries ? (
                    translatedSummary.trim() ? (
                      <Text style={[styles.bodyText, cjk(translationLanguage) && styles.bodyZh]}>{translatedSummary}</Text>
                    ) : (
                      <Text style={styles.emptyInline}>{t('lecture.summaryEmpty')}</Text>
                    )
                  ) : (
                    <Text style={styles.emptyInline}>{t('lecture.summaryPending')}</Text>
                  )}
                </GlassCard>
              ) : null}
            </View>
          )}

          {/* ---- Marked ---- */}
          {tab === 'Marked' && (
            <GlassCard>
              <LectureSectionHeader icon="star-outline" label={t('lecture.marked')} />
              {lecture.markedTimestamps.length > 0 ? (
                <View style={styles.momentList}>
                  {lecture.markedTimestamps.map((ms, i) => (
                    <PressableScale
                      key={i}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('lecture.importantMoment')} ${formatClock(Math.floor(ms / 1000))}`}
                      disabled={!audioAvailable}
                      onPress={() => void seekToSeconds(ms / 1000)}
                      scaleTo={0.995}
                      pressedStyle={audioAvailable ? styles.rowPressed : undefined}
                      style={[styles.momentRow, !audioAvailable && styles.momentRowDisabled]}
                    >
                      <View style={styles.momentTime}><Text style={styles.momentTimeText}>{formatClock(Math.floor(ms / 1000))}</Text></View>
                      <Text style={styles.momentLabel}>{t('lecture.importantMoment')}</Text>
                      <Ionicons name="star" size={15} color={colors.textPrimary} />
                    </PressableScale>
                  ))}
                </View>
              ) : (
                <Text style={styles.emptyInline}>{t('lecture.noMoments')}</Text>
              )}
              {!audioAvailable ? <Text style={styles.markedHint}>{t('lecture.audioUnavailable')}</Text> : null}
            </GlassCard>
          )}

          {/* ---- Notes ---- */}
          {tab === 'Notes' && (
            <View style={styles.noteSheet}>
              <View style={styles.foldedCorner} />
              <LectureSectionHeader
                icon="create-outline"
                label={t('lecture.notes')}
                trailing={<PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t('lecture.exportNotesA11y')}
                  accessibilityState={{ busy: exportingPdf, disabled: exportingPdf }}
                  hitSlop={7}
                  onPress={() => void handleExportPdf()}
                  disabled={exportingPdf}
                  style={[
                    styles.noteExportBtn,
                    exportingPdf && styles.noteExportBtnDisabled,
                  ]}
                >
                  {exportingPdf ? (
                    <ActivityIndicator size="small" color={colors.accentBright} />
                  ) : (
                    <Ionicons name="share-outline" size={16} color={colors.textPrimary} />
                  )}
                  <Text style={styles.noteExportText}>{exportingPdf ? t('lecture.exporting') : t('lecture.exportPdf')}</Text>
                </PressableScale>}
              />
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('lecture.openNotes')}
                onPress={openNotesEditor}
                style={styles.notePreviewPressable}
              >
                {notesHasContent ? (
                  <View style={styles.notePreview}>
                    {typedNotes ? (
                      <Text style={styles.notePreviewText} numberOfLines={6}>
                        {typedNotes}
                      </Text>
                    ) : null}
                    {strokeCount > 0 ? (
                      <View style={styles.handwritingBlock}>
                        <View style={styles.handwritingLabelRow}>
                          <Ionicons name="brush-outline" size={13} color={colors.textTertiary} />
                          <Text style={styles.handwritingLabel}>{t(strokeCount === 1 ? 'lecture.handwritingCountOne' : 'lecture.handwritingCount', { count: strokeCount })}</Text>
                        </View>
                        <HandwritingPreview strokes={lecture.noteStrokes ?? []} />
                      </View>
                    ) : null}
                    <Text style={styles.noteEditHint}>{t('lecture.editHint')}</Text>
                  </View>
                ) : (
                  <Text style={styles.notePreviewEmpty}>{t('lecture.addNotes')}</Text>
                )}
              </PressableScale>
            </View>
          )}
        </View>
      </ScrollView>
      )}
      </View>

      <RenameModal
        visible={renameVisible}
        title={t('rename.lectureTitle')}
        label={t('rename.lectureLabel')}
        initialValue={lecture.title}
        placeholder={t('rename.lecturePlaceholder')}
        onCancel={() => setRenameVisible(false)}
        onSave={(title) => {
          renameLecture(lecture.id, title);
          setRenameVisible(false);
        }}
      />

      <MoveLectureToCourseModal
        visible={moveVisible}
        lecture={lecture}
        courses={courses}
        onClose={() => setMoveVisible(false)}
        onSelect={(targetCourseId) => {
          if (moveLectureToCourse(lecture.id, targetCourseId)) setMoveVisible(false);
        }}
      />

      <Modal
        visible={notesOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setNotesOpen(false)}
      >
        <SafeAreaView style={styles.modalRoot} edges={['top', 'bottom', 'left', 'right']}>
          <View style={styles.modalHeader}>
            <PressableScale accessibilityRole="button" onPress={() => setNotesOpen(false)} style={styles.modalAction}>
              <Text style={styles.modalActionText}>{t('common.cancel')}</Text>
            </PressableScale>
            <Text style={styles.modalTitle}>{t('lecture.notesTitle')}</Text>
            <PressableScale accessibilityRole="button" onPress={saveNotes} style={styles.modalAction}>
              <Text style={styles.modalActionText}>{t('common.done')}</Text>
            </PressableScale>
          </View>
          <NotebookCanvas
            style={styles.modalCanvas}
            strokes={strokesDraft}
            text={notesDraft}
            images={imagesDraft}
            onStrokesChange={setStrokesDraft}
            onTextChange={setNotesDraft}
            onImagesChange={setImagesDraft}
            showFixedHistory
          />
        </SafeAreaView>
      </Modal>

      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: colors.background,
  },
  detail: { flex: 1 },
  audioStateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  audioStateRowCompact: { flexWrap: 'wrap' },
  audioRetryButton: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.deepNavy },
  audioRetryText: { color: colors.textOnNavy, fontSize: fontSize.sm, fontWeight: '700' },

  // ---- Not found ----
  notFound: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  notFoundText: {
    fontSize: fontSize.lg,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  notFoundBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.deepNavy,
  },
  notFoundBtnText: {
    color: colors.textOnNavy,
    fontWeight: '700',
    fontSize: fontSize.md,
  },

  // ---- Header ----
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: 38,
    paddingTop: 24,
    paddingBottom: 12,
  },
  headerCompact: {
    gap: spacing.sm,
    paddingHorizontal: 18,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnDisabled: {
    opacity: 0.55,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
  courseTile: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  headerMeta: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
  },

  playerWrap: {
    paddingHorizontal: 38,
    marginBottom: spacing.md,
    maxWidth: 1040,
    width: '100%',
    alignSelf: 'center',
  },
  playerWrapCompact: {
    paddingHorizontal: 18,
  },
  compactPlayer: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  compactPlayerNarrow: { flexWrap: 'wrap' },
  playerTimeText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  progressTrack: { flex: 1, minWidth: 160, height: 5, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.navy },
  playPauseButton: { width: 42, height: 42, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy },
  skipButton: { minHeight: 32, paddingHorizontal: 10, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  skipText: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700' },
  // ---- Phone player: seek row on top, transport controls centered below ----
  playerStack: { gap: 14 },
  playerSeekRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  playerTransportRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 22 },
  playPauseButtonLarge: { width: 56, height: 56, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy, ...shadows.button },
  skipButtonCompact: { minHeight: 40, minWidth: 56, paddingHorizontal: 12, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },

  // ---- Tabs ----
  tabBar: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginHorizontal: 38,
    marginBottom: spacing.md,
    padding: spacing.xs,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    maxWidth: 1040,
    alignSelf: 'center',
    width: '100%',
  },
  tabBarCompact: {
    marginHorizontal: 18,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabCompact: {
    paddingVertical: spacing.lg,
  },
  tabActive: {
    backgroundColor: colors.navy,
    shadowColor: colors.navy,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  tabLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textTertiary,
  },
  tabLabelActive: {
    color: colors.pearlWhite,
    fontWeight: '700',
  },

  // The reveal wrapper takes the flex slot the tab body used to occupy
  // directly, so Transcript's FlatList and the other tabs' ScrollView still
  // get the full remaining height (and stay virtualized / scrollable).
  tabBody: { flex: 1 },
  pageScroll: SUMMARY_PAGE_SCROLL_STYLE,
  scroll: {
    paddingHorizontal: 38,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxxl,
  },
  scrollCompact: {
    paddingHorizontal: 18,
  },
  content: {
    width: '100%',
    maxWidth: 1040,
    alignSelf: 'center',
    gap: spacing.md,
  },
  summaryStack: { ...SUMMARY_STACK_STYLE, gap: spacing.lg },
  summaryCard: SUMMARY_CARD_STYLE,

  // ---- Mock notice ----
  mockNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  mockNoticeText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '500',
  },

  // ---- Transcript timeline ----
  timeline: {
    paddingTop: spacing.xs,
  },
  tlRow: {
    flexDirection: 'row',
  },
  tlTimeCol: {
    width: 50,
    paddingTop: 1,
  },
  tlTime: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.mutedBlueGray,
    fontVariant: ['tabular-nums'],
  },
  tlRail: {
    width: 26,
  },
  tlDot: {
    position: 'absolute',
    top: 5,
    left: 7,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.mutedBlueGray,
  },
  tlDotImportant: {
    backgroundColor: colors.deepNavy,
    borderColor: colors.deepNavy,
  },
  tlLineUp: {
    position: 'absolute',
    top: 0,
    height: 5,
    left: 12,
    width: 2,
    backgroundColor: colors.borderStrong,
  },
  tlLineDown: {
    position: 'absolute',
    top: 17,
    bottom: 0,
    left: 12,
    width: 2,
    backgroundColor: colors.borderStrong,
  },
  tlContent: {
    flex: 1,
    paddingBottom: spacing.xl,
  },
  plainSegment: {
    gap: spacing.xs,
    paddingTop: 1,
  },
  importantCard: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.deepNavy,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  importantTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
  },
  importantTagText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: colors.textPrimary,
  },
  speaker: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.textTertiary,
    textTransform: 'uppercase',
  },
  segText: {
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.5,
    color: colors.textPrimary,
    fontWeight: '500',
  },

  // ---- Study-note blocks ----
  bodyText: {
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.6,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  bodyZh: {
    color: colors.secondaryNavy,
    lineHeight: fontSize.md * 1.7,
  },

  // ---- Key points ----
  pointList: {
    gap: spacing.md,
  },
  pointRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  pointBullet: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.deepNavy,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  pointNum: {
    color: colors.pearlWhite,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  pointText: {
    flex: 1,
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.5,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  momentList: {
    gap: spacing.sm,
  },
  markedHint: { marginTop: spacing.md, color: colors.textSecondary, fontSize: fontSize.sm },
  momentRowDisabled: { opacity: 0.55 },
  // The moment row already sits on `surfaceMuted`, so its press tint has to be
  // a step stronger to register at all.
  rowPressed: { backgroundColor: colors.border },
  momentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  momentTime: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  momentTimeText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  momentLabel: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  emptyInline: {
    flexShrink: 1,
    fontSize: fontSize.md,
    color: colors.textTertiary,
    fontWeight: '500',
  },

  // ---- Notes ----
  noteSheet: {
    minHeight: 180,
    borderRadius: radius.xl,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    overflow: 'hidden',
  },
  foldedCorner: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 34,
    height: 34,
    backgroundColor: colors.surfaceMuted,
    borderBottomLeftRadius: radius.md,
  },
  noteExportBtn: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noteExportBtnDisabled: {
    opacity: 0.6,
  },
  noteExportText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: '800',
  },
  notePreviewPressable: {
    borderRadius: radius.lg,
  },
  notePreviewText: { color: colors.textPrimary, fontSize: fontSize.md, lineHeight: 23 },
  notePreviewEmpty: { color: colors.textTertiary, fontSize: fontSize.md, lineHeight: 23 },
  notePreview: { gap: spacing.lg },
  handwritingBlock: { gap: spacing.sm },
  handwritingLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  handwritingLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: colors.textTertiary,
    textTransform: 'uppercase',
  },
  noteEditHint: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textTertiary },
  modalRoot: { flex: 1, backgroundColor: colors.background },
  modalCanvas: { flex: 1 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { color: colors.textPrimary, fontSize: fontSize.xl, fontWeight: '800' },
  modalAction: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
  modalActionText: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700' },
  modalInput: { flex: 1, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.paper, padding: spacing.xl, color: colors.textPrimary, fontSize: fontSize.lg, lineHeight: 26 },
  notesInput: {
    minHeight: 240,
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.6,
    color: colors.textPrimary,
    fontWeight: '500',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  notesFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    marginTop: spacing.md,
  },
  notesHint: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
  },
});
