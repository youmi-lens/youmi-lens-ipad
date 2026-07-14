import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { AppBackground } from '@/components/AppBackground';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { WorkspaceSidebar } from '@/components/WorkspaceSidebar';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { formatDateTime, formatDuration } from '@/lib/format';
import { useI18n, localizeSystemDefaultTitle } from '@/lib/i18n';
import { useData } from '@/lib/store';

type IndicatorState = 'done' | 'active' | 'pending' | 'failed';

function StepIndicator({ state }: { state: IndicatorState }) {
  if (state === 'done') {
    return <View style={[styles.indicator, styles.indicatorDone]}><Ionicons name="checkmark" size={20} color={colors.pearlWhite} /></View>;
  }
  if (state === 'active') {
    return <View style={[styles.indicator, styles.indicatorActive]}><ActivityIndicator size="small" color={colors.accentBright} /></View>;
  }
  if (state === 'failed') {
    return <View style={[styles.indicator, styles.indicatorFailed]}><Ionicons name="alert" size={18} color={colors.pearlWhite} /></View>;
  }
  return <View style={[styles.indicator, styles.indicatorPending]}><View style={styles.pendingDot} /></View>;
}

function remoteStatusKey(status?: string) {
  switch (status) {
    case 'queued': return 'processing.remote.queued';
    case 'transcribing': return 'processing.remote.transcribing';
    case 'transcript_ready': return 'processing.remote.transcriptReady';
    case 'done': return 'processing.remote.done';
    case 'failed': return 'processing.remote.failed';
    default: return 'processing.remote.waiting';
  }
}

export default function ProcessingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ lectureId?: string }>();
  const { getLecture, getCourse, updateLecture } = useData();
  const { t, language } = useI18n();

  // This screen is a viewer only. The durable upload → backend-processing →
  // status-poll chain is owned by the app-level orchestrator (see
  // lib/useProcessingOrchestrator.ts), so leaving this screen never abandons
  // processing. The Retry buttons below just reset the relevant status; the
  // orchestrator observes the change and re-drives the pending step.
  const lecture = getLecture(params.lectureId);
  const course = getCourse(lecture?.courseId);

  const uploadStatus = lecture?.uploadStatus ?? 'not_uploaded';
  const processingStatus = lecture?.processingStatus ?? 'not_started';
  const processingDone = processingStatus === 'ready';
  const remoteStepState: IndicatorState =
    processingStatus === 'ready' ? 'done' : processingStatus === 'processing' ? 'active' : processingStatus === 'failed' ? 'failed' : 'pending';

  const backToLectures = () => router.replace('/');
  const viewLecture = () => lecture ? router.replace({ pathname: '/lecture/[id]', params: { id: lecture.id } }) : router.replace('/');

  return (
    <View style={styles.root}>
      <AppBackground />
      <WorkspaceSidebar active="record" />
      <SafeAreaView style={styles.detail} edges={['top', 'bottom', 'right']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={[styles.headerIcon, processingDone && styles.headerIconDone]}>
              <Ionicons name={processingDone ? 'checkmark-done' : 'sparkles-outline'} size={30} color={processingDone ? colors.pearlWhite : colors.deepNavy} />
            </View>
            <Text style={styles.title}>{processingDone ? t('processing.titleDone') : t('processing.title')}</Text>
            <Text style={styles.subtitle}>{processingDone ? t('processing.subtitleDone') : t('processing.subtitle')}</Text>
          </View>

          <GlassCard elevated>
            <View style={styles.capturedHeader}>
              <Text style={styles.capturedTitle}>{localizeSystemDefaultTitle(t, lecture?.title) ?? t('processing.untitledLecture')}</Text>
              <View style={styles.localPill}><Text style={styles.localPillText}>{t('processing.savedOnDevice')}</Text></View>
            </View>
            <View style={styles.metaGrid}>
              <View style={styles.meta}><Text style={styles.metaLabel}>{t('processing.meta.course')}</Text><Text style={styles.metaValue}>{course?.name ? localizeSystemDefaultTitle(t, course.name) : t('processing.defaultCourse')}</Text></View>
              <View style={styles.meta}><Text style={styles.metaLabel}>{t('processing.meta.duration')}</Text><Text style={styles.metaValue}>{formatDuration(lecture?.durationMillis ?? 0)}</Text></View>
              <View style={styles.meta}><Text style={styles.metaLabel}>{t('processing.meta.markedMoments')}</Text><Text style={styles.metaValue}>{lecture?.markedTimestamps.length ?? 0}</Text></View>
              <View style={styles.meta}><Text style={styles.metaLabel}>{t('processing.meta.recorded')}</Text><Text style={styles.metaValue}>{lecture ? formatDateTime(lecture.date, language) : '—'}</Text></View>
            </View>
          </GlassCard>

          <GlassCard padding={spacing.xs}>
            <View style={styles.stepRow}>
              <StepIndicator state="done" />
              <View style={styles.stepText}><Text style={styles.stepTitle}>{t('processing.step.capturedTitle')}</Text><Text style={styles.stepSubtitle}>{t('processing.step.capturedSubtitle')}</Text></View>
            </View>
            <View style={styles.stepDivider} />
            <View style={styles.stepRow}>
              <StepIndicator state={uploadStatus === 'uploaded' ? 'done' : uploadStatus === 'uploading' ? 'active' : uploadStatus === 'upload_failed' ? 'failed' : 'pending'} />
              <View style={styles.stepText}>
                <Text style={styles.stepTitle}>{uploadStatus === 'uploaded' ? t('processing.step.audioUploaded') : uploadStatus === 'uploading' ? t('processing.step.uploadingAudio') : uploadStatus === 'upload_failed' ? t('processing.step.uploadFailed') : t('processing.step.waitingUpload')}</Text>
                <Text style={styles.stepSubtitle}>{uploadStatus === 'uploaded' ? t('processing.step.sentSecure') : uploadStatus === 'upload_failed' ? lecture?.uploadError ?? t('processing.step.tryAgain') : t('processing.step.sendingSecure')}</Text>
                {uploadStatus === 'upload_failed' ? <SecondaryButton label={t('processing.step.retryUpload')} icon="refresh-outline" onPress={() => { if (lecture) updateLecture(lecture.id, { uploadStatus: 'not_uploaded', uploadError: undefined }); }} style={styles.retryButton} /> : null}
              </View>
            </View>
            <View style={styles.stepDivider} />
            <View style={styles.stepRow}>
              <StepIndicator state={remoteStepState} />
              <View style={styles.stepText}>
                <Text style={styles.stepTitle}>{processingStatus === 'failed' ? t('processing.remote.failed') : t(remoteStatusKey(lecture?.remoteAiStatus))}</Text>
                <Text style={styles.stepSubtitle}>{processingStatus === 'failed' ? lecture?.processingError ?? t('processing.step.retryProcessingBody') : processingStatus === 'ready' ? t('processing.step.readyBody') : lecture?.remoteAiError ?? t('processing.step.waitingUpdates')}</Text>
                {processingStatus === 'failed' ? <SecondaryButton label={t('processing.step.retryProcessing')} icon="refresh-outline" onPress={() => { if (lecture) updateLecture(lecture.id, { processingStatus: 'not_started', processingError: undefined }); }} style={styles.retryButton} /> : null}
              </View>
            </View>
            <View style={styles.stepDivider} />
            <View style={styles.stepRow}>
              <StepIndicator state={processingDone ? 'done' : 'pending'} />
              <View style={styles.stepText}><Text style={styles.stepTitle}>{t('processing.step.readyTitle')}</Text><Text style={styles.stepSubtitle}>{t('processing.step.readySubtitle')}</Text></View>
            </View>
          </GlassCard>

          <View style={styles.actions}>
            {processingDone ? <PrimaryButton label={t('processing.viewLecture')} icon="document-text" onPress={viewLecture} /> : null}
            <SecondaryButton label={t('processing.backToLectures')} icon="chevron-back" onPress={backToLectures} />
          </View>
        </View>
      </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  detail: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 38, paddingVertical: 28 },
  content: { width: '100%', maxWidth: 700, alignSelf: 'center', gap: 16 },
  header: { alignItems: 'center', gap: spacing.md },
  headerIcon: { width: 58, height: 58, borderRadius: 16, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  headerIconDone: { backgroundColor: colors.success, borderColor: colors.success },
  title: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 21 },
  capturedHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  capturedTitle: { flex: 1, color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '700' },
  localPill: { borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  localPillText: { color: colors.textPrimary, fontSize: fontSize.xs, fontWeight: '700' },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  meta: { width: '47%', gap: 3 },
  metaLabel: { color: colors.textTertiary, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  metaValue: { color: colors.ink, fontSize: 13.5, fontWeight: '700' },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statLabel: { color: colors.textSecondary, fontSize: fontSize.sm, width: 110 },
  statValue: { flex: 1, color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '600' },
  indicator: { width: 28, height: 28, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  indicatorDone: { backgroundColor: colors.successTint },
  indicatorActive: { backgroundColor: colors.surfaceMuted },
  indicatorFailed: { backgroundColor: colors.recordingRed },
  indicatorPending: { backgroundColor: colors.surfaceMuted },
  pendingDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.borderStrong },
  stepRow: { flexDirection: 'row', gap: 14, padding: 16 },
  stepDivider: { height: 1, backgroundColor: colors.border },
  stepText: { flex: 1, gap: spacing.xs },
  stepTitle: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700' },
  stepSubtitle: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', marginTop: spacing.md },
  actions: { gap: spacing.md, alignSelf: 'center', minWidth: 260 },
});
