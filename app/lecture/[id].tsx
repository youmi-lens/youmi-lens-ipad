import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ComponentProps, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
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
import { NativeLookupText } from '@/components/NativeLookupText';
import { RenameModal } from '@/components/RenameModal';
import { StatusPill, StatusVariant } from '@/components/StatusPill';
import { WorkspaceSidebar } from '@/components/WorkspaceSidebar';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
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
  shouldShowLocalAudioPlayer,
} from '@/lib/lectureLocalAudio';
import { useRecordingNotes } from '@/lib/recordingNotes';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const TABS = ['Summary', 'Transcript', 'Marked', 'Notes'] as const;
type Tab = (typeof TABS)[number];

/** A study-note style block header: icon tile + label. */
function BlockHeader({
  icon,
  label,
  trailing,
}: {
  icon: IoniconName;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.blockHeader}>
      <View style={styles.blockIcon}>
        <Ionicons name={icon} size={15} color={colors.textPrimary} />
      </View>
      <Text style={styles.blockLabel}>{label}</Text>
      {trailing ? <View style={styles.blockTrailing}>{trailing}</View> : null}
    </View>
  );
}

export default function LectureDetailScreen() {
  const { t, language } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const { getLecture, getCourse, updateLecture, renameLecture } = useData();
  const { isLectureSessionActive } = useRecordingNotes();

  const lecture = getLecture(params.id);
  const course = getCourse(lecture?.courseId);

  const [tab, setTab] = useState<Tab>('Summary');
  const [notesDraft, setNotesDraft] = useState(lecture?.notes ?? '');
  const [strokesDraft, setStrokesDraft] = useState<NoteStroke[]>(lecture?.noteStrokes ?? []);
  const [imagesDraft, setImagesDraft] = useState(lecture?.noteImages ?? []);
  const [notesOpen, setNotesOpen] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const { width } = useWindowDimensions();
  const compactLayout = width < 1180;
  const audioPlayback = useMemo(
    () =>
      resolveLectureAudioPlaybackState({
        localAudioUri: lecture?.localAudioUri,
        storagePath: lecture?.storagePath,
        lectureId: lecture?.id,
      }),
    [lecture?.localAudioUri, lecture?.storagePath, lecture?.id],
  );
  const audioAvailable = shouldShowLocalAudioPlayer(audioPlayback);
  const player = useAudioPlayer(audioAvailable ? { uri: audioPlayback.uri ?? '' } : null, { updateInterval: 250 });
  const audioStatus = useAudioPlayerStatus(player);
  const playbackDuration = audioStatus.duration || (lecture?.durationMillis ?? 0) / 1000;
  const playbackProgress = playbackDuration > 0 ? Math.min(audioStatus.currentTime / playbackDuration, 1) : 0;

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

  const togglePlayback = useCallback(async () => {
    if (!audioAvailable) return;
    if (isLectureSessionActive) {
      Alert.alert(t('lecture.audioUnavailable'), t('lecture.playbackBlockedRecording'));
      return;
    }
    try {
      if (audioStatus.playing) {
        player.pause();
        return;
      }
      // Recording leave/stop leaves the session in ambient/record mode;
      // switch to audible playback before starting the player.
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      player.play();
    } catch (err) {
      console.warn('[lecture] playback failed', err);
      Alert.alert(t('lecture.audioUnavailable'), t('lecture.tryAgain'));
    }
  }, [audioAvailable, audioStatus.playing, isLectureSessionActive, player, t]);

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

  const openSummaryEditor = (side: 'source' | 'translated') => {
    if (!canEditSummaries) return;
    router.push(`/lecture/${lecture.id}/summary-edit?side=${side}` as Href);
  };
  const openTranscriptEditor = (side: 'source' | 'translated') => {
    if (!canEditTranscripts) return;
    router.push(`/lecture/${lecture.id}/transcript-edit?side=${side}` as Href);
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
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </Pressable>
        {course ? (
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('course.renameLecture')}
          onPress={() => setRenameVisible(true)}
          hitSlop={8}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        >
          <Ionicons name="pencil-outline" size={20} color={colors.textPrimary} />
        </Pressable>
      </View>

      <View style={styles.playerWrap}>
        <GlassCard padding={16}>
          {audioAvailable ? (
            <View style={[styles.compactPlayer, compactLayout && styles.compactPlayerNarrow]}>
              <Pressable accessibilityRole="button" onPress={() => void togglePlayback()} style={styles.playPauseButton}>
                <Ionicons name={audioStatus.playing ? 'pause' : 'play'} size={20} color={colors.textOnNavy} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={t('lecture.skipBack')} onPress={() => void skipBy(-10)} style={styles.skipButton}><Text style={styles.skipText}>↺ 10s</Text></Pressable>
              <Text style={styles.playerTimeText}>{formatClock(Math.floor(audioStatus.currentTime))}</Text>
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${playbackProgress * 100}%` }]} /></View>
              <Text style={styles.playerTimeText}>{formatClock(Math.floor(playbackDuration))}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t('lecture.skipForward')} onPress={() => void skipBy(10)} style={styles.skipButton}><Text style={styles.skipText}>10s ↻</Text></Pressable>
            </View>
          ) : (
            <Text style={styles.emptyInline}>
              {audioPlayback.kind === 'local-missing'
                ? t('lecture.audioLocalMissing')
                : audioPlayback.kind === 'cloud-soon'
                  ? t('lecture.audioCloudSoon')
                  : t('lecture.audioUnavailable')}
            </Text>
          )}
        </GlassCard>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {TABS.map((tabName) => {
          const active = tabName === tab;
          return (
            <Pressable
              key={tabName}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setTab(tabName)}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text
                style={[styles.tabLabel, active && styles.tabLabelActive]}
                numberOfLines={1}
              >
                {t(`lecture.tab.${tabName.toLowerCase()}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView
        style={styles.pageScroll}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.content}>
          {/* ---- Transcript — source language, then translation when source != target ---- */}
          {tab === 'Transcript' && (
            <>
              <GlassCard
                onPress={canEditTranscripts ? () => openTranscriptEditor('source') : undefined}
              >
                <BlockHeader
                  icon="document-text-outline"
                  label={getTranscriptSectionLabel(sourceLanguage)}
                  trailing={
                    canEditTranscripts ? (
                      <Ionicons name="create-outline" size={16} color={colors.textTertiary} />
                    ) : null
                  }
                />
                {canEditTranscripts ? (
                  sourceTranscript.trim() ? (
                    <NativeLookupText style={styles.bodyText}>{sourceTranscript}</NativeLookupText>
                  ) : (
                    <Text style={styles.emptyInline}>{t('lecture.transcriptEmpty')}</Text>
                  )
                ) : (
                  <Text style={styles.emptyInline}>{t('lecture.transcriptPending')}</Text>
                )}
              </GlassCard>
              {hasTranslation ? (
                <GlassCard
                  onPress={canEditTranscripts ? () => openTranscriptEditor('translated') : undefined}
                >
                  <BlockHeader
                    icon="language-outline"
                    label={getTranscriptSectionLabel(translationLanguage)}
                    trailing={
                      canEditTranscripts ? (
                        <Ionicons name="create-outline" size={16} color={colors.textTertiary} />
                      ) : null
                    }
                  />
                  {canEditTranscripts ? (
                    translatedTranscript.trim() ? (
                      <Text style={[styles.bodyText, cjk(translationLanguage) && styles.bodyZh]}>
                        {translatedTranscript}
                      </Text>
                    ) : (
                      <Text style={styles.emptyInline}>{t('lecture.transcriptEmpty')}</Text>
                    )
                  ) : (
                    <Text style={styles.emptyInline}>{t('lecture.transcriptPending')}</Text>
                  )}
                </GlassCard>
              ) : null}
            </>
          )}

          {/* ---- Summary — source language, then translation when source != target ---- */}
          {tab === 'Summary' && (
            <View style={styles.summaryStack}>
              <GlassCard
                style={styles.summaryCard}
                onPress={canEditSummaries ? () => openSummaryEditor('source') : undefined}
              >
                <BlockHeader
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
                  <BlockHeader
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
              <BlockHeader icon="star-outline" label={t('lecture.marked')} />
              {lecture.markedTimestamps.length > 0 ? (
                <View style={styles.momentList}>
                  {lecture.markedTimestamps.map((ms, i) => (
                    <Pressable
                      key={i}
                      accessibilityRole="button"
                      disabled={!audioAvailable}
                      onPress={() => void seekToSeconds(ms / 1000)}
                      style={({ pressed }) => [styles.momentRow, !audioAvailable && styles.momentRowDisabled, pressed && audioAvailable && styles.pressed]}
                    >
                      <View style={styles.momentTime}><Text style={styles.momentTimeText}>{formatClock(Math.floor(ms / 1000))}</Text></View>
                      <Text style={styles.momentLabel}>{t('lecture.importantMoment')}</Text>
                      <Ionicons name="star" size={15} color={colors.textPrimary} />
                    </Pressable>
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
              <View style={styles.noteHeaderRow}>
                <View style={styles.noteBlockHeader}>
                  <View style={styles.blockIcon}>
                    <Ionicons name="create-outline" size={15} color={colors.textPrimary} />
                  </View>
                  <Text style={styles.blockLabel}>{t('lecture.notes')}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('lecture.exportNotesA11y')}
                  onPress={() => void handleExportPdf()}
                  disabled={exportingPdf}
                  style={({ pressed }) => [
                    styles.noteExportBtn,
                    exportingPdf && styles.noteExportBtnDisabled,
                    pressed && !exportingPdf && styles.pressed,
                  ]}
                >
                  {exportingPdf ? (
                    <ActivityIndicator size="small" color={colors.accentBright} />
                  ) : (
                    <Ionicons name="share-outline" size={16} color={colors.textPrimary} />
                  )}
                  <Text style={styles.noteExportText}>{exportingPdf ? t('lecture.exporting') : t('lecture.exportPdf')}</Text>
                </Pressable>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('lecture.openNotes')}
                onPress={openNotesEditor}
                style={({ pressed }) => [styles.notePreviewPressable, pressed && styles.pressed]}
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
              </Pressable>
            </View>
          )}
        </View>
      </ScrollView>

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

      <Modal
        visible={notesOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setNotesOpen(false)}
      >
        <SafeAreaView style={styles.modalRoot} edges={['top', 'bottom', 'left', 'right']}>
          <View style={styles.modalHeader}>
            <Pressable accessibilityRole="button" onPress={() => setNotesOpen(false)} style={styles.modalAction}>
              <Text style={styles.modalActionText}>{t('common.cancel')}</Text>
            </Pressable>
            <Text style={styles.modalTitle}>{t('lecture.notesTitle')}</Text>
            <Pressable accessibilityRole="button" onPress={saveNotes} style={styles.modalAction}>
              <Text style={styles.modalActionText}>{t('common.done')}</Text>
            </Pressable>
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
  compactPlayer: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  compactPlayerNarrow: { flexWrap: 'wrap' },
  playerTimeText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  progressTrack: { flex: 1, minWidth: 160, height: 5, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.navy },
  playPauseButton: { width: 42, height: 42, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy },
  skipButton: { minHeight: 32, paddingHorizontal: 10, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  skipText: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700' },

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
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
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

  pageScroll: SUMMARY_PAGE_SCROLL_STYLE,
  scroll: {
    paddingHorizontal: 38,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxxl,
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
  blockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  blockTrailing: {
    marginLeft: 'auto',
  },
  blockIcon: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blockLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: colors.textSecondary,
  },
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
  noteHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  noteBlockHeader: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  noteExportBtn: {
    minHeight: 38,
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
