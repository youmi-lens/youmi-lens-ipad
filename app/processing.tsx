import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { AppBackground } from '@/components/AppBackground';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { WorkspaceSidebar } from '@/components/WorkspaceSidebar';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { formatDuration } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { startRemoteProcessing } from '@/lib/processRecording';
import { useData } from '@/lib/store';
import { fetchRemoteRecording } from '@/lib/syncRecording';
import { uploadLectureAudio } from '@/lib/uploadRecording';

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

function remoteStatusLabel(status?: string) {
  switch (status) {
    case 'queued': return 'Starting AI processing…';
    case 'transcribing': return 'Transcribing lecture…';
    case 'transcript_ready': return 'Generating summary…';
    case 'done': return 'Processing complete';
    case 'failed': return 'Processing failed';
    default: return 'Waiting to start processing';
  }
}

export default function ProcessingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ lectureId?: string }>();
  const { getLecture, getCourse, updateLecture } = useData();
  const { session } = useAuth();

  const lecture = getLecture(params.lectureId);
  const course = getCourse(lecture?.courseId);
  const [uploadRetryCount, setUploadRetryCount] = useState(0);
  const [processingRetryCount, setProcessingRetryCount] = useState(0);
  const attemptedUploadFor = useRef<string | null>(null);
  const startedProcessingFor = useRef<string | null>(null);

  useEffect(() => {
    if (!lecture) return;
    if (lecture.uploadStatus === 'uploaded' || lecture.uploadStatus === 'uploading') return;
    const attemptKey = `${lecture.id}:${uploadRetryCount}`;
    if (attemptedUploadFor.current === attemptKey) return;
    attemptedUploadFor.current = attemptKey;

    if (!lecture.localAudioUri) {
      updateLecture(lecture.id, { uploadStatus: 'upload_failed', uploadError: 'No local audio file is available for upload.' });
      return;
    }
    if (!session?.access_token) {
      updateLecture(lecture.id, { uploadStatus: 'upload_failed', uploadError: 'Please sign in to upload this recording.' });
      return;
    }
    if (!lecture.remoteRecordingId) {
      updateLecture(lecture.id, { uploadStatus: 'upload_failed', uploadError: 'Missing remote recording id. Create a new recording and try again.' });
      return;
    }

    updateLecture(lecture.id, { uploadStatus: 'uploading', uploadError: undefined });
    if (__DEV__) {
      console.info('[processing] audio upload started', {
        hasLocalAudio: Boolean(lecture.localAudioUri),
        durationMillis: lecture.durationMillis,
      });
    }
    void uploadLectureAudio({
      localUri: lecture.localAudioUri,
      lectureId: lecture.id,
      recordingId: lecture.remoteRecordingId,
      mimeType: 'audio/m4a',
      accessToken: session.access_token,
      durationMillis: lecture.durationMillis,
      course: course?.name,
      title: lecture.title,
      liveTranscript: lecture.liveTranscript,
    })
      .then((result) => {
        if (__DEV__) {
          console.info('[processing] audio upload completed', {
            size: result.size,
            mime: result.mime,
          });
        }
        updateLecture(lecture.id, {
          uploadStatus: 'uploaded',
          storagePath: result.storagePath,
          uploadError: undefined,
          uploadedAt: new Date().toISOString(),
        });
      })
      .catch((error: unknown) => {
        if (__DEV__) {
          console.warn('[processing] audio upload failed', {
            message: error instanceof Error ? error.message : 'unknown',
          });
        }
        updateLecture(lecture.id, {
          uploadStatus: 'upload_failed',
          uploadError: error instanceof Error ? error.message : 'Upload failed.',
        });
      });
  }, [course?.name, lecture, session?.access_token, updateLecture, uploadRetryCount]);

  useEffect(() => {
    if (!lecture || lecture.uploadStatus !== 'uploaded') return;
    if (!session?.access_token || !lecture.remoteRecordingId) return;
    if (lecture.processingStatus === 'ready') return;
    const attemptKey = `${lecture.id}:${processingRetryCount}`;
    if (startedProcessingFor.current === attemptKey) return;
    startedProcessingFor.current = attemptKey;

    updateLecture(lecture.id, { processingStatus: 'processing', processingError: undefined });
    if (__DEV__) console.info('[processing] backend processing requested');
    void startRemoteProcessing({
      remoteRecordingId: lecture.remoteRecordingId,
      accessToken: session.access_token,
    }).catch((error: unknown) => {
      if (__DEV__) {
        console.warn('[processing] backend processing request failed', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
      updateLecture(lecture.id, {
        processingStatus: 'failed',
        processingError: error instanceof Error ? error.message : 'Could not start processing.',
      });
    });
  }, [lecture, processingRetryCount, session?.access_token, updateLecture]);

  useEffect(() => {
    if (!lecture || lecture.processingStatus !== 'processing') return;
    if (!session?.access_token || !lecture.remoteRecordingId) return;

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 80;

    const poll = async () => {
      attempts += 1;
      try {
        const remote = await fetchRemoteRecording({
          remoteRecordingId: lecture.remoteRecordingId!,
          accessToken: session.access_token,
          userId: session.user.id,
        });
        if (cancelled) return;

        const patch = {
          transcript: remote.transcript ?? '',
          transcriptZh: remote.transcript_zh ?? '',
          summaryEn: remote.summary_en ?? '',
          summaryZh: remote.summary_zh ?? '',
          remoteAiStatus: remote.ai_status ?? undefined,
          remoteAiError: remote.ai_error ?? undefined,
          processingError: remote.ai_error ?? undefined,
          lastSyncedAt: new Date().toISOString(),
        };

        if (remote.ai_status === 'failed') {
          updateLecture(lecture.id, { ...patch, processingStatus: 'failed' });
          return;
        }

        if (remote.ai_status === 'done' || (remote.transcript && remote.summary_en && remote.summary_zh)) {
          updateLecture(lecture.id, { ...patch, processingStatus: 'ready' });
          return;
        }

        updateLecture(lecture.id, patch);
        if (attempts >= maxAttempts) {
          updateLecture(lecture.id, {
            processingStatus: 'failed',
            processingError: 'Processing is taking longer than expected. Please retry in a moment.',
          });
          return;
        }
        setTimeout(poll, 3000);
      } catch (error) {
        if (cancelled) return;
        updateLecture(lecture.id, {
          processingStatus: 'failed',
          processingError: error instanceof Error ? error.message : 'Could not sync processing status.',
        });
      }
    };

    void poll();
    return () => { cancelled = true; };
  }, [lecture, session?.access_token, session?.user.id, updateLecture]);

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
            <Text style={styles.title}>{processingDone ? 'Lecture ready' : 'Processing your lecture'}</Text>
            <Text style={styles.subtitle}>{processingDone ? 'Your transcript and summaries are ready to review.' : 'You can return later to check the result.'}</Text>
          </View>

          <GlassCard elevated>
            <View style={styles.capturedHeader}>
              <Text style={styles.capturedTitle}>{lecture?.title ?? 'Untitled Lecture'}</Text>
              <View style={styles.localPill}><Text style={styles.localPillText}>Saved on device</Text></View>
            </View>
            <View style={styles.metaGrid}>
              <View style={styles.meta}><Text style={styles.metaLabel}>COURSE</Text><Text style={styles.metaValue}>{course?.name ?? 'Lecture'}</Text></View>
              <View style={styles.meta}><Text style={styles.metaLabel}>DURATION</Text><Text style={styles.metaValue}>{formatDuration(lecture?.durationMillis ?? 0)}</Text></View>
              <View style={styles.meta}><Text style={styles.metaLabel}>MARKED MOMENTS</Text><Text style={styles.metaValue}>{lecture?.markedTimestamps.length ?? 0}</Text></View>
              <View style={styles.meta}><Text style={styles.metaLabel}>RECORDED</Text><Text style={styles.metaValue}>{lecture ? new Date(lecture.date).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</Text></View>
            </View>
          </GlassCard>

          <GlassCard padding={spacing.xs}>
            <View style={styles.stepRow}>
              <StepIndicator state="done" />
              <View style={styles.stepText}><Text style={styles.stepTitle}>Recording captured</Text><Text style={styles.stepSubtitle}>Audio saved on this iPad.</Text></View>
            </View>
            <View style={styles.stepDivider} />
            <View style={styles.stepRow}>
              <StepIndicator state={uploadStatus === 'uploaded' ? 'done' : uploadStatus === 'uploading' ? 'active' : uploadStatus === 'upload_failed' ? 'failed' : 'pending'} />
              <View style={styles.stepText}>
                <Text style={styles.stepTitle}>{uploadStatus === 'uploaded' ? 'Audio uploaded' : uploadStatus === 'uploading' ? 'Uploading audio…' : uploadStatus === 'upload_failed' ? 'Upload failed' : 'Waiting to upload audio'}</Text>
                <Text style={styles.stepSubtitle}>{uploadStatus === 'uploaded' ? 'Sent to secure storage.' : uploadStatus === 'upload_failed' ? lecture?.uploadError ?? 'Please try again.' : 'Sending the local recording to secure storage.'}</Text>
                {uploadStatus === 'upload_failed' ? <SecondaryButton label="Retry Upload" icon="refresh-outline" onPress={() => { if (lecture) updateLecture(lecture.id, { uploadStatus: 'not_uploaded', uploadError: undefined }); setUploadRetryCount((count) => count + 1); }} style={styles.retryButton} /> : null}
              </View>
            </View>
            <View style={styles.stepDivider} />
            <View style={styles.stepRow}>
              <StepIndicator state={remoteStepState} />
              <View style={styles.stepText}>
                <Text style={styles.stepTitle}>{processingStatus === 'failed' ? 'Processing failed' : remoteStatusLabel(lecture?.remoteAiStatus)}</Text>
                <Text style={styles.stepSubtitle}>{processingStatus === 'failed' ? lecture?.processingError ?? 'Please retry processing.' : processingStatus === 'ready' ? 'Transcript and summaries are ready.' : lecture?.remoteAiError ?? 'Waiting for backend processing updates'}</Text>
                {processingStatus === 'failed' ? <SecondaryButton label="Retry Processing" icon="refresh-outline" onPress={() => { if (lecture) updateLecture(lecture.id, { processingStatus: 'not_started', processingError: undefined }); setProcessingRetryCount((count) => count + 1); }} style={styles.retryButton} /> : null}
              </View>
            </View>
            <View style={styles.stepDivider} />
            <View style={styles.stepRow}>
              <StepIndicator state={processingDone ? 'done' : 'pending'} />
              <View style={styles.stepText}><Text style={styles.stepTitle}>Ready to review</Text><Text style={styles.stepSubtitle}>Summary, key terms and bilingual notes.</Text></View>
            </View>
          </GlassCard>

          <View style={styles.actions}>
            {processingDone ? <PrimaryButton label="View Lecture" icon="document-text" onPress={viewLecture} /> : null}
            <SecondaryButton label="Back to Lectures" icon="chevron-back" onPress={backToLectures} />
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
  headerIcon: { width: 58, height: 58, borderRadius: 16, backgroundColor: colors.iceTint, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  headerIconDone: { backgroundColor: colors.success, borderColor: colors.success },
  title: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 21 },
  capturedHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  capturedTitle: { flex: 1, color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '700' },
  localPill: { borderRadius: radius.pill, backgroundColor: colors.iceTint, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
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
  indicatorActive: { backgroundColor: colors.iceTint },
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
