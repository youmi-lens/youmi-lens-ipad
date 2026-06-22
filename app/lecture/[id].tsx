import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ComponentProps, useState } from 'react';
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
import { RenameModal } from '@/components/RenameModal';
import { StatusPill, StatusVariant } from '@/components/StatusPill';
import { WorkspaceSidebar } from '@/components/WorkspaceSidebar';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { exportLectureNotesPdf, hasExportableLectureNotes } from '@/lib/exportLectureNotesPdf';
import { formatClock, formatDate, formatDuration } from '@/lib/format';
import {
  getLectureSummaryByLanguage,
  getLectureTranscriptByLanguage,
  getSummarySectionLabel,
  getTranscriptSectionLabel,
} from '@/lib/languageContent';
import type { NoteStroke } from '@/lib/models';
import { useData } from '@/lib/store';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const TABS = ['Summary', 'Transcript', 'Marked', 'Notes'] as const;
type Tab = (typeof TABS)[number];

const STATUS_INFO: Record<string, { label: string; variant: StatusVariant }> = {
  local_recorded: { label: 'RECORDED', variant: 'idle' },
};

/** A study-note style block header: icon tile + label. */
function BlockHeader({ icon, label }: { icon: IoniconName; label: string }) {
  return (
    <View style={styles.blockHeader}>
      <View style={styles.blockIcon}>
        <Ionicons name={icon} size={15} color={colors.textPrimary} />
      </View>
      <Text style={styles.blockLabel}>{label}</Text>
    </View>
  );
}

export default function LectureDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const { getLecture, getCourse, updateLecture, renameLecture } = useData();

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
  const audioAvailable = Boolean(lecture?.localAudioUri);
  const player = useAudioPlayer(audioAvailable ? { uri: lecture?.localAudioUri ?? '' } : null, { updateInterval: 250 });
  const audioStatus = useAudioPlayerStatus(player);
  const playbackDuration = audioStatus.duration || (lecture?.durationMillis ?? 0) / 1000;
  const playbackProgress = playbackDuration > 0 ? Math.min(audioStatus.currentTime / playbackDuration, 1) : 0;

  if (!lecture) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.notFound}>
          <Ionicons name="document-outline" size={36} color={colors.mutedBlueGray} />
          <Text style={styles.notFoundText}>This lecture could not be found.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/')}
            style={({ pressed }) => [styles.notFoundBtn, pressed && styles.pressed]}
          >
            <Text style={styles.notFoundBtnText}>Back to Home</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // V1 transcript + summary are fixed English-first / Chinese-second.
  const transcriptEn = getLectureTranscriptByLanguage(lecture, 'en');
  const transcriptZh = getLectureTranscriptByLanguage(lecture, 'zh');
  const summaryEn = getLectureSummaryByLanguage(lecture, 'en');
  const summaryZh = getLectureSummaryByLanguage(lecture, 'zh');
  const typedNotes = lecture.notes.trim();
  const strokeCount = lecture.noteStrokes?.length ?? 0;
  const notesHasContent = typedNotes.length > 0 || strokeCount > 0;
  const status =
    lecture.processingStatus === 'ready'
      ? { label: 'READY', variant: 'done' as StatusVariant }
      : lecture.processingStatus === 'processing'
        ? { label: 'PROCESSING', variant: 'processing' as StatusVariant }
        : lecture.processingStatus === 'failed'
          ? { label: 'FAILED', variant: 'idle' as StatusVariant }
          : STATUS_INFO[lecture.status] ?? STATUS_INFO.local_recorded;

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
      Alert.alert('Nothing to export yet', 'There are no notes to export yet.');
      return;
    }

    setExportingPdf(true);
    try {
      await exportLectureNotesPdf({ lecture, course });
    } catch (err) {
      Alert.alert(
        'Could not export PDF',
        err instanceof Error ? err.message : 'Please try again in a moment.',
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
          accessibilityLabel="Back"
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
            {lecture.title}
          </Text>
          <Text style={styles.headerMeta} numberOfLines={1}>
            {course?.name ?? 'Lecture'} · {formatDate(lecture.date)} ·{' '}
            {formatDuration(lecture.durationMillis)}
          </Text>
        </View>
        <StatusPill label={status.label} variant={status.variant} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Rename lecture"
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
              <Pressable accessibilityRole="button" onPress={() => audioStatus.playing ? player.pause() : player.play()} style={styles.playPauseButton}>
                <Ionicons name={audioStatus.playing ? 'pause' : 'play'} size={20} color={colors.textOnNavy} />
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => void skipBy(-10)} style={styles.skipButton}><Text style={styles.skipText}>↺ 10s</Text></Pressable>
              <Text style={styles.playerTimeText}>{formatClock(Math.floor(audioStatus.currentTime))}</Text>
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${playbackProgress * 100}%` }]} /></View>
              <Text style={styles.playerTimeText}>{formatClock(Math.floor(playbackDuration))}</Text>
              <Pressable accessibilityRole="button" onPress={() => void skipBy(10)} style={styles.skipButton}><Text style={styles.skipText}>10s ↻</Text></Pressable>
            </View>
          ) : (
            <Text style={styles.emptyInline}>
              {lecture.storagePath ? 'Audio playback from cloud storage is coming soon.' : 'Audio playback is not available for this lecture.'}
            </Text>
          )}
        </GlassCard>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {TABS.map((t) => {
          const active = t === tab;
          return (
            <Pressable
              key={t}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setTab(t)}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text
                style={[styles.tabLabel, active && styles.tabLabelActive]}
                numberOfLines={1}
              >
                {t}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.content}>
          {/* ---- Transcript — English then Chinese (fixed for V1) ---- */}
          {tab === 'Transcript' && (
            <>
              <GlassCard>
                <BlockHeader
                  icon="document-text-outline"
                  label={getTranscriptSectionLabel('en')}
                />
                {transcriptEn ? (
                  <Text style={styles.bodyText}>{transcriptEn}</Text>
                ) : (
                  <Text style={styles.emptyInline}>Transcript is not ready yet.</Text>
                )}
              </GlassCard>
              <GlassCard>
                <BlockHeader icon="language-outline" label={getTranscriptSectionLabel('zh')} />
                {transcriptZh ? (
                  <Text style={[styles.bodyText, styles.bodyZh]}>{transcriptZh}</Text>
                ) : (
                  <Text style={styles.emptyInline}>
                    Chinese transcript has not been generated yet.
                  </Text>
                )}
              </GlassCard>
            </>
          )}

          {/* ---- Summary — English then Chinese (fixed for V1) ---- */}
          {tab === 'Summary' && (
            <>
              {summaryEn || summaryZh ? (
                <View style={[styles.summaryGrid, compactLayout && styles.summaryGridCompact]}>
                  <GlassCard>
                    <BlockHeader icon="language-outline" label={getSummarySectionLabel('en')} />
                    {summaryEn ? (
                      <Text style={styles.bodyText}>{summaryEn}</Text>
                    ) : (
                      <Text style={styles.emptyInline}>
                        English summary has not been generated yet.
                      </Text>
                    )}
                  </GlassCard>
                  <GlassCard>
                    <BlockHeader icon="chatbubbles-outline" label={getSummarySectionLabel('zh')} />
                    {summaryZh ? (
                      <Text style={[styles.bodyText, styles.bodyZh]}>{summaryZh}</Text>
                    ) : (
                      <Text style={styles.emptyInline}>
                        Chinese summary has not been generated yet.
                      </Text>
                    )}
                  </GlassCard>
                </View>
              ) : (
                <GlassCard>
                  <Text style={styles.emptyInline}>Summary will appear after processing.</Text>
                </GlassCard>
              )}
            </>
          )}

          {/* ---- Marked ---- */}
          {tab === 'Marked' && (
            <GlassCard>
              <BlockHeader icon="star-outline" label="MARKED IMPORTANT" />
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
                      <Text style={styles.momentLabel}>Important moment</Text>
                      <Ionicons name="star" size={15} color={colors.textPrimary} />
                    </Pressable>
                  ))}
                </View>
              ) : (
                <Text style={styles.emptyInline}>No important moments were marked during this lecture.</Text>
              )}
              {!audioAvailable ? <Text style={styles.markedHint}>Audio playback is not available for this lecture.</Text> : null}
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
                  <Text style={styles.blockLabel}>LECTURE NOTES</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Export lecture notes as PDF"
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
                  <Text style={styles.noteExportText}>{exportingPdf ? 'Exporting…' : 'Export PDF'}</Text>
                </Pressable>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open lecture notes"
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
                          <Text style={styles.handwritingLabel}>
                            Handwriting · {strokeCount} {strokeCount === 1 ? 'stroke' : 'strokes'}
                          </Text>
                        </View>
                        <HandwritingPreview strokes={lecture.noteStrokes ?? []} />
                      </View>
                    ) : null}
                    <Text style={styles.noteEditHint}>Tap to open the full notebook editor.</Text>
                  </View>
                ) : (
                  <Text style={styles.notePreviewEmpty}>Tap to add notes for this lecture.</Text>
                )}
              </Pressable>
            </View>
          )}
        </View>
      </ScrollView>

      <RenameModal
        visible={renameVisible}
        title="Rename Lecture"
        label="Lecture title"
        initialValue={lecture.title}
        placeholder="e.g. Week 3 — Cell Division"
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
              <Text style={styles.modalActionText}>Cancel</Text>
            </Pressable>
            <Text style={styles.modalTitle}>Lecture Notes</Text>
            <Pressable accessibilityRole="button" onPress={saveNotes} style={styles.modalAction}>
              <Text style={styles.modalActionText}>Done</Text>
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
  summaryGrid: { flexDirection: 'row', gap: 16, alignItems: 'stretch' },
  summaryGridCompact: { flexDirection: 'column' },

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
