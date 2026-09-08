import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { AppBackground } from '@/components/AppBackground';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { WorkspaceSidebar } from '@/components/WorkspaceSidebar';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { formatDateTime, formatDuration } from '@/lib/format';
import { useI18n, localizeSystemDefaultTitle } from '@/lib/i18n';
import { isLectureComplete } from '@/lib/processingResume.mjs';
import { runMediaReconciliation } from '@/lib/recording/mediaReconciliation';
import { useMediaReconciliation } from '@/lib/recording/useMediaReconciliation';
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

  // Reopening Processing (or landing here after an app relaunch mid-flow)
  // is also a safe re-entry point for general media reconciliation — same
  // shared hook as Lecture Detail, see lib/recording/useMediaReconciliation.ts.
  useMediaReconciliation(lecture, updateLecture);

  const uploadStatus = lecture?.uploadStatus ?? 'not_uploaded';
  const assemblyRequired = lecture?.audioAssemblyStatus === 'required';
  const processingStatus = lecture?.processingStatus ?? 'not_started';
  const processingDone = processingStatus === 'ready';
  const remoteStepState: IndicatorState =
    processingStatus === 'ready' ? 'done' : processingStatus === 'processing' ? 'active' : processingStatus === 'failed' ? 'failed' : 'pending';

  // The safety guard (audioAssemblyStatus === 'required') was always
  // correct — it never lost or overwrote a source. This is the missing
  // recovery operation that satisfies it: whenever a lecture arrives here
  // still needing assembly, automatically compose its preserved sources
  // into one verified file (native AVFoundation composition, never a
  // bypass) and only then let the normal upload/processing pipeline
  // proceed. A genuine failure leaves the guard up and offers a manual
  // retry — it never auto-loops.
  const [assembling, setAssembling] = useState(false);
  const [assemblyError, setAssemblyError] = useState<string | null>(null);
  const assemblyAttemptedForRef = useRef<string | null>(null);

  const runAssembly = useCallback(async () => {
    if (!lecture) return;
    if (__DEV__) console.info('[AudioAssembly] recovery-start', { lectureId: lecture.id, sourceCount: lecture.audioSegments?.length ?? 0 });
    setAssembling(true);
    setAssemblyError(null);

    // Complete media discovery + composition, shared with the general
    // media-reconciliation re-entry path (lib/recording/
    // mediaReconciliation.ts) so this orchestration exists in exactly one
    // place. recordingEngine/audioSegments alone is not a complete
    // manifest — this also finds recoverable native-durable media the
    // lecture may have accumulated before a later legacy resume, and
    // proves a safe non-overlapping order before anything is composed.
    const result = await runMediaReconciliation(lecture.id, lecture.audioSegments);
    if (!result.ok) {
      if (__DEV__) console.info('[AudioAssembly] discovery-failure', { lectureId: lecture.id, reason: result.reason, error: result.detail });
      updateLecture(lecture.id, {
        mediaIntegrityStatus: result.reason === 'composition_failed' ? undefined : result.reason,
        mediaIntegrityDetail: result.detail,
        mediaIntegrityCheckedAt: new Date().toISOString(),
      });
      setAssembling(false);
      setAssemblyError(result.detail);
      return;
    }

    if (__DEV__) console.info('[AudioAssembly] native-success', { lectureId: lecture.id, durationMillis: result.durationMillis, sourceCount: result.sourceIds.length });
    updateLecture(lecture.id, {
      // A Back-triggered assembly-required save leaves status
      // 'in_progress' (handleBack intentionally preserves an in-progress
      // lecture) — without correcting it here, a future re-open would
      // route straight back to /recording's review mode instead of here
      // or the lecture detail screen, even though assembly is now done.
      status: 'local_recorded',
      localAudioUri: result.localAudioUri,
      durationMillis: result.durationMillis,
      audioAssemblyStatus: undefined,
      audioAssemblyCompletedAt: new Date().toISOString(),
      mediaIntegrityStatus: undefined,
      mediaIntegrityDetail: undefined,
      mediaReconciliationStatus: 'complete',
      mediaReconciliationSourceIds: result.sourceIds,
      mediaReconciliationCompletedAt: new Date().toISOString(),
      uploadStatus: 'not_uploaded',
      uploadError: undefined,
    });
    if (__DEV__) console.info('[AudioAssembly] state-reconciled', { lectureId: lecture.id });
    setAssembling(false);
  }, [lecture, updateLecture]);

  useEffect(() => {
    if (!lecture || !assemblyRequired) return;
    if (assemblyAttemptedForRef.current === lecture.id) return;
    assemblyAttemptedForRef.current = lecture.id;
    if (__DEV__) console.info('[AudioAssembly] detected-required', { lectureId: lecture.id });
    void runAssembly();
    // Only re-run automatically when a DIFFERENT lecture needs it — a
    // failure on this one waits for the manual Retry button below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lecture?.id, assemblyRequired]);

  const retryAssembly = () => {
    assemblyAttemptedForRef.current = null;
    void runAssembly();
  };

  const backToLectures = () => router.replace('/');
  // This screen is the canonical gate for any incomplete lecture — View
  // Lecture must never let the user skip ahead into a Lecture Detail that
  // isn't ready yet (App Review-adjacent: a misleading blank Transcript/
  // Summary screen is worse than a brief "still processing" message).
  const viewLecture = () => {
    if (!lecture) { router.replace('/'); return; }
    if (!isLectureComplete(lecture)) { Alert.alert(t('processing.notReadyAlert')); return; }
    router.replace({ pathname: '/lecture/[id]', params: { id: lecture.id } });
  };

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
              <StepIndicator state={assembling ? 'active' : assemblyRequired || uploadStatus === 'upload_failed' ? 'failed' : uploadStatus === 'uploaded' ? 'done' : uploadStatus === 'uploading' ? 'active' : 'pending'} />
              <View style={styles.stepText}>
                <Text style={styles.stepTitle}>{assembling ? t('recording.assemblingAudio') : assemblyRequired ? 'Audio assembly required' : uploadStatus === 'uploaded' ? t('processing.step.audioUploaded') : uploadStatus === 'uploading' ? t('processing.step.uploadingAudio') : uploadStatus === 'upload_failed' ? t('processing.step.uploadFailed') : t('processing.step.waitingUpload')}</Text>
                <Text style={styles.stepSubtitle}>{assembling ? 'Your original audio and resumed segment are preserved. Composing them into one verified file…' : assemblyRequired ? (assemblyError ? t('processing.step.assemblyFailed') : 'Your original audio and resumed segment are preserved. Upload is blocked until a complete audio file is verified.') : uploadStatus === 'uploaded' ? t('processing.step.sentSecure') : uploadStatus === 'upload_failed' ? lecture?.uploadError ?? t('processing.step.tryAgain') : t('processing.step.sendingSecure')}</Text>
                {assemblyRequired && !assembling ? <SecondaryButton label={t('processing.step.retryRecovery')} icon="refresh-outline" onPress={retryAssembly} style={styles.retryButton} /> : null}
                {uploadStatus === 'upload_failed' && !assemblyRequired ? <SecondaryButton label={t('processing.step.retryUpload')} icon="refresh-outline" onPress={() => { if (lecture) updateLecture(lecture.id, { uploadStatus: 'not_uploaded', uploadError: undefined }); }} style={styles.retryButton} /> : null}
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
            {/* Processing is the canonical gate for an incomplete lecture:
                View Lecture stays tappable (never a dead/disabled control),
                but resolves into a brief "still processing" message instead
                of Lecture Detail until isLectureComplete() is true — see
                viewLecture() above. Back to Lectures always works; the list
                itself re-routes back here on the next tap while incomplete. */}
            {lecture ? <PrimaryButton label={t('processing.viewLecture')} icon="document-text" onPress={viewLecture} /> : null}
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
