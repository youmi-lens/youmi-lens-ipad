import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { ComponentProps, useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { LogoMark } from '@/components/BrandHeader';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { IconTile, PageHeading, Pill, ProgressBar, SectionLabel } from '@/components/WorkspaceUI';
import { colors, layout } from '@/constants/theme';
import { user } from '@/data/mockData';
import { useAuth } from '@/lib/auth';
import { formatDuration, formatShortDate, greetingForNow } from '@/lib/format';
import { useGuestRecordingUsage } from '@/lib/guest';
import { COURSE_PRESETS } from '@/lib/models';
import { fetchPlanStatus, PlanStatus } from '@/lib/planStatus';
import { useData } from '@/lib/store';

type IconName = ComponentProps<typeof Ionicons>['name'];

export default function RecordHomeScreen() {
  const router = useRouter();
  const {
    loaded,
    courses,
    lectures,
    selectedCourseId,
    setSelectedCourseId,
    getCourse,
    createCourse,
  } = useData();
  const { session, isGuest, exitGuest } = useAuth();
  const { remaining: guestRemaining } = useGuestRecordingUsage();
  const [lectureTitle, setLectureTitle] = useState('');
  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
  const [planLoading, setPlanLoading] = useState(true);

  const loadPlan = useCallback(async () => {
    const token = session?.access_token;
    if (!token) {
      setPlanStatus(null);
      setPlanLoading(false);
      return;
    }
    setPlanLoading(true);
    try {
      setPlanStatus(await fetchPlanStatus(token));
    } catch {
      // Preserve the last backend-provided status when a refresh fails.
    } finally {
      setPlanLoading(false);
    }
  }, [session?.access_token]);

  useFocusEffect(useCallback(() => { void loadPlan(); }, [loadPlan]));

  const selectedCourse = getCourse(selectedCourseId) ?? courses[0];
  const recentLectures = [...lectures].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  const recordingsUsed = planStatus?.recordingsUsedToday ?? 0;
  const recordingsLimit = planStatus?.maxRecordingsPerDay ?? 0;
  const usageProgress = recordingsLimit > 0 ? recordingsUsed / recordingsLimit : 0;
  const guestAllowanceUsedUp = isGuest && guestRemaining <= 0;

  const openCreateCourse = () => router.push('/create-course');
  const goToSignIn = () => { void exitGuest().then(() => router.replace('/auth')); };
  const promptGuestSignIn = () => {
    Alert.alert('Sign in to continue', 'Sign in to continue recording lectures.', [
      { text: 'Not now', style: 'cancel' },
      { text: 'Sign In', onPress: goToSignIn },
    ]);
  };
  const startQuickRecording = () => {
    if (guestAllowanceUsedUp) return promptGuestSignIn();
    const preset = COURSE_PRESETS[0];
    const course = createCourse({
      name: 'General Lectures',
      icon: preset.icon,
      tint: preset.tint,
      accent: preset.accent,
    });
    router.push({ pathname: '/recording', params: { courseId: course.id, lectureTitle: '' } });
  };
  const startRecording = () => {
    if (!selectedCourse) return;
    if (guestAllowanceUsedUp) return promptGuestSignIn();
    router.push({
      pathname: '/recording',
      params: { courseId: selectedCourse.id, lectureTitle: lectureTitle.trim() },
    });
  };
  const cycleCourse = () => {
    if (courses.length < 2 || !selectedCourse) return;
    const index = courses.findIndex((course) => course.id === selectedCourse.id);
    setSelectedCourseId(courses[(index + 1) % courses.length].id);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          {!loaded ? (
            <View style={styles.loading}><ActivityIndicator color={colors.accent} /></View>
          ) : courses.length === 0 ? (
            <>
              <PageHeading eyebrow="Welcome to Youmi Lens" title="Your lectures, captured and understood" />
              <View style={styles.emptyGrid}>
                <GlassCard elevated style={styles.emptyHero}>
                  <LogoMark size={36} />
                  <Text style={styles.emptyTitle}>Create your first course</Text>
                  <Text style={styles.emptyBody}>
                    Courses keep every recording, transcript and summary organised. Add one, then record your first lecture.
                  </Text>
                  <View style={styles.emptyActions}>
                    <PrimaryButton label="Create course" icon="add" onPress={openCreateCourse} />
                    <SecondaryButton label="Quick recording" icon="mic-outline" onPress={startQuickRecording} />
                  </View>
                </GlassCard>
                <GlassCard style={styles.stepsCard}>
                  {[
                    ['Record in class', 'Live English captions with instant Chinese translation while your professor speaks.'],
                    ['Review the summary', 'AI outline, key terms and takeaways in both languages, ready after class.'],
                    ['Keep your notes', 'Mark key moments and export everything as a PDF.'],
                  ].map(([title, body], index) => (
                    <View key={title} style={styles.step}>
                      <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{index + 1}</Text></View>
                      <View style={styles.stepText}>
                        <Text style={styles.stepTitle}>{title}</Text>
                        <Text style={styles.stepBody}>{body}</Text>
                      </View>
                    </View>
                  ))}
                </GlassCard>
              </View>
            </>
          ) : (
            <>
              <PageHeading
                eyebrow={`${greetingForNow()}, ${user.firstName}`}
                title="Ready for your next lecture?"
              />
              <View style={styles.homeGrid}>
                <GlassCard elevated style={styles.recordCard}>
                  <SectionLabel>Record a lecture</SectionLabel>
                  <View style={styles.selectorRow}>
                    <Pressable onPress={cycleCourse} style={({ pressed }) => [styles.courseSelector, pressed && styles.pressed]}>
                      <IconTile
                        icon={(selectedCourse?.icon ?? 'people-outline') as IconName}
                        color={colors.textSecondary}
                        backgroundColor={colors.surfaceMuted}
                      />
                      <View style={styles.selectorText}>
                        <Text style={styles.selectorLabel}>COURSE</Text>
                        <Text style={styles.selectorValue} numberOfLines={1}>{selectedCourse?.name}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={17} color={colors.textTertiary} />
                    </Pressable>
                    <Pressable onPress={openCreateCourse} style={({ pressed }) => [styles.addCourse, pressed && styles.pressed]}>
                      <Ionicons name="add" size={22} color={colors.textTertiary} />
                    </Pressable>
                  </View>
                  <TextInput
                    value={lectureTitle}
                    onChangeText={setLectureTitle}
                    placeholder="Lecture title (optional)"
                    placeholderTextColor={colors.textTertiary}
                    style={styles.input}
                    maxLength={60}
                  />
                  <PrimaryButton label="Start Recording" icon="radio-button-on" size="lg" onPress={startRecording} />
                  <View style={styles.featureRow}>
                    <Pill>Live captions</Pill>
                    <Pill>文A Bilingual</Pill>
                    <Pill>Smart notes</Pill>
                  </View>
                </GlassCard>

                <View style={styles.sideStack}>
                  <GlassCard padding={20}>
                    <SectionLabel>Today</SectionLabel>
                    {isGuest ? (
                      <>
                        <View style={styles.metricRow}>
                          <Text style={styles.metricLabel}>Guest recordings left</Text>
                          <Text style={styles.metricValue}>{guestRemaining}</Text>
                        </View>
                        <ProgressBar value={guestRemaining > 0 ? 0.35 : 1} />
                        <Pressable onPress={goToSignIn}><Text style={styles.accountLink}>Sign in for account access</Text></Pressable>
                      </>
                    ) : (
                      <>
                        <View style={styles.metricRow}>
                          <Text style={styles.metricLabel}>Recordings</Text>
                          <Text style={styles.metricValue}>
                            {planLoading ? '—' : `${recordingsUsed} / ${recordingsLimit || '—'}`}
                          </Text>
                        </View>
                        <ProgressBar value={usageProgress} />
                        <View style={styles.metricRow}>
                          <Text style={styles.metricLabel}>Max length</Text>
                          <Text style={styles.metricValue}>{planStatus?.maxRecordingMinutes ?? '—'} min</Text>
                        </View>
                      </>
                    )}
                  </GlassCard>

                  <GlassCard padding={20} style={styles.recentCard}>
                    <View style={styles.recentHeader}>
                      <SectionLabel>Recent lectures</SectionLabel>
                      <Pressable onPress={() => router.push('/courses')}><Text style={styles.viewAll}>View all</Text></Pressable>
                    </View>
                    {recentLectures.length ? recentLectures.map((lecture, index) => {
                      const course = getCourse(lecture.courseId);
                      return (
                        <Pressable
                          key={lecture.id}
                          onPress={() => router.push({ pathname: '/lecture/[id]', params: { id: lecture.id } })}
                          style={({ pressed }) => [styles.lectureRow, index < recentLectures.length - 1 && styles.lectureDivider, pressed && styles.pressed]}
                        >
                          <IconTile icon="document-text-outline" size={32} />
                          <View style={styles.lectureText}>
                            <Text numberOfLines={1} style={styles.lectureTitle}>{lecture.title}</Text>
                            <Text numberOfLines={1} style={styles.lectureMeta}>{course?.name ?? 'Lecture'} · {formatShortDate(lecture.date)}</Text>
                          </View>
                          <Text style={styles.duration}>{formatDuration(lecture.durationMillis)}</Text>
                        </Pressable>
                      );
                    }) : (
                      <Text style={styles.emptyRecent}>Recorded lectures will appear here.</Text>
                    )}
                  </GlassCard>
                </View>
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  scroll: { paddingHorizontal: layout.workspacePadding, paddingTop: 28, paddingBottom: 40 },
  content: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 22 },
  loading: { minHeight: 420, alignItems: 'center', justifyContent: 'center' },
  homeGrid: { flexDirection: 'row', gap: 16, alignItems: 'stretch' },
  recordCard: { flex: 1.55 },
  sideStack: { flex: 1, gap: 14 },
  selectorRow: { flexDirection: 'row', gap: 10, marginTop: 15 },
  courseSelector: {
    flex: 1, minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 11,
    borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    paddingHorizontal: 12, backgroundColor: colors.glassElevated,
  },
  selectorText: { flex: 1 },
  selectorLabel: { color: colors.textTertiary, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  selectorValue: { color: colors.ink, fontSize: 14, fontWeight: '700', marginTop: 2 },
  addCourse: {
    width: 54, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.borderStrong,
    borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glass,
  },
  input: {
    height: 46, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    paddingHorizontal: 14, marginVertical: 10, color: colors.ink, fontSize: 14.5,
    fontWeight: '500', backgroundColor: colors.glassElevated,
  },
  featureRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  metricRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 11, marginBottom: 6 },
  metricLabel: { color: colors.textSecondary, fontSize: 13 },
  metricValue: { color: colors.ink, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  accountLink: { color: colors.accent, fontSize: 12, fontWeight: '700', marginTop: 13 },
  recentCard: { flex: 1 },
  recentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  viewAll: { color: colors.accent, fontSize: 11.5, fontWeight: '700' },
  lectureRow: { minHeight: 55, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10 },
  lectureDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  lectureText: { flex: 1 },
  lectureTitle: { color: colors.ink, fontSize: 13.5, fontWeight: '700' },
  lectureMeta: { color: colors.textTertiary, fontSize: 11.5, marginTop: 2 },
  duration: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  emptyRecent: { color: colors.textTertiary, fontSize: 12.5, marginTop: 18 },
  emptyGrid: { flexDirection: 'row', gap: 16, minHeight: 440 },
  emptyHero: { flex: 1, justifyContent: 'center', overflow: 'hidden' },
  emptyTitle: { marginTop: 14, color: colors.ink, fontSize: 22, fontWeight: '800' },
  emptyBody: { marginTop: 8, maxWidth: 340, color: colors.textSecondary, fontSize: 13.5, lineHeight: 21 },
  emptyActions: { flexDirection: 'row', gap: 10, marginTop: 22 },
  stepsCard: { flex: 1, justifyContent: 'center', gap: 24 },
  step: { flexDirection: 'row', gap: 14 },
  stepNumber: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  stepNumberText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  stepText: { flex: 1 },
  stepTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  stepBody: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  pressed: { opacity: 0.76, transform: [{ scale: 0.99 }] },
});
