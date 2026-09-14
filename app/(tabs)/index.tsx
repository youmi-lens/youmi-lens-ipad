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

import { ContentReveal } from '@/components/ContentReveal';
import { GlassCard } from '@/components/GlassCard';
import { LogoMark } from '@/components/BrandHeader';
import { PageShellTransition } from '@/components/PageShellTransition';
import { PressableScale } from '@/components/PressableScale';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { IconTile, PageHeading, Pill, ProgressBar, SectionLabel } from '@/components/WorkspaceUI';
import { isPad } from '@/constants/deviceClass';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors, layout } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { formatDuration, formatShortDate } from '@/lib/format';
import { useGuestRecordingUsage } from '@/lib/guest';
import { useI18n, localizeSystemDefaultTitle } from '@/lib/i18n';
import { COURSE_PRESETS } from '@/lib/models';
import { fetchPlanStatus, PlanStatus } from '@/lib/planStatus';
import { isLectureComplete } from '@/lib/processingResume.mjs';
import { useData } from '@/lib/store';

type IconName = ComponentProps<typeof Ionicons>['name'];

export default function RecordHomeScreen() {
  const isCompact = useIsCompactWidth();
  // Portrait iPad intentionally remains in the compact navigation branch, but
  // its canvas should not inherit phone-sized margins and top-packed empty
  // states. This is composition only; the responsive shell stays width-based.
  const isTabletCompact = isPad && isCompact;
  const { t, language } = useI18n();
  const hour = new Date().getHours();
  const greeting = t(hour < 12 ? 'home.greetingMorning' : hour < 18 ? 'home.greetingAfternoon' : 'home.greetingEvening');
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
  const { session, isGuest, exitGuest, username } = useAuth();
  // The signed-in greeting must use the real account, not a fixture. Mirrors the
  // sidebar's name derivation (username, else the email local-part).
  const displayName = username ?? session?.user?.email?.split('@')[0] ?? '';
  const { remaining: guestRemaining } = useGuestRecordingUsage();
  const [lectureTitle, setLectureTitle] = useState('');
  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  // Bumped once per tab focus, never by course/lecture/plan data — the page
  // heading's entrance below keys on this alone, so a recording finishing,
  // a course mutation, or a plan refresh can never restart it.
  const [focusKey, setFocusKey] = useState(0);

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

  useFocusEffect(useCallback(() => {
    setFocusKey((key) => key + 1);
    void loadPlan();
  }, [loadPlan]));

  const selectedCourse = getCourse(selectedCourseId) ?? courses[0];
  const recentLectures = [...lectures].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  const recordingsUsed = planStatus?.recordingsUsedToday ?? 0;
  const recordingsLimit = planStatus?.maxRecordingsPerDay ?? 0;
  const usageProgress = recordingsLimit > 0 ? recordingsUsed / recordingsLimit : 0;
  const guestAllowanceUsedUp = isGuest && guestRemaining <= 0;

  const openCreateCourse = () => router.push('/create-course');
  const goToSignIn = () => { void exitGuest().then(() => router.replace('/auth')); };
  const promptGuestSignIn = () => {
    Alert.alert(t('home.signInTitle'), t('home.signInBody'), [
      { text: t('common.notNow'), style: 'cancel' },
      { text: t('common.signIn'), onPress: goToSignIn },
    ]);
  };
  const startQuickRecording = () => {
    if (guestAllowanceUsedUp) return promptGuestSignIn();
    const preset = COURSE_PRESETS[0];
    const result = createCourse({
      name: 'General Lectures',
      icon: preset.icon,
      tint: preset.tint,
      accent: preset.accent,
    });
    if (!result.ok) return;
    router.push({ pathname: '/recording', params: { courseId: result.course.id, lectureTitle: '' } });
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
      <ScrollView contentContainerStyle={[styles.scroll, isCompact && styles.scrollCompact, isTabletCompact && styles.scrollTabletCompact]} showsVerticalScrollIndicator={false}>
        {/* Whole shell — heading AND the dynamic body below it (recent
            lectures included) — settles together as one translate-only
            movement keyed to tab focus. See PageShellTransition: it never
            touches opacity, so the recent-lectures list can live inside it
            without any risk of the Courses-grid class of white-screen bug. */}
        <PageShellTransition style={[styles.content, isTabletCompact && styles.contentTabletCompact]} revealKey={focusKey}>
          {!loaded ? (
            <View style={styles.loading}><ActivityIndicator color={colors.accent} /></View>
      ) : courses.length === 0 ? (
            <>
              <ContentReveal revealKey={focusKey}>
                <PageHeading eyebrow={t('home.welcome')} title={t('home.title')} preserveEyebrowCase />
              </ContentReveal>
              <View style={[styles.emptyGrid, isCompact && styles.emptyGridCompact, isTabletCompact && styles.emptyGridTabletCompact]}>
                <GlassCard elevated style={[styles.emptyHero, isCompact && styles.emptyHeroCompact]}>
                  <View style={[styles.emptyHeroContent, isTabletCompact && styles.emptyHeroContentTabletCompact]}>
                    <LogoMark size={36} />
                    <Text style={styles.emptyTitle}>{t('home.createFirstCourse')}</Text>
                    <Text style={[styles.emptyBody, isTabletCompact && styles.emptyBodyTabletCompact]}>{t('home.emptyBody')}</Text>
                    <View style={styles.emptyActions}>
                      <PrimaryButton label={t('home.createCourse')} icon="add" onPress={openCreateCourse} />
                      <SecondaryButton label={t('home.quickRecording')} icon="mic-outline" onPress={startQuickRecording} />
                    </View>
                  </View>
                </GlassCard>
                <GlassCard style={[styles.stepsCard, isCompact && styles.stepsCardCompact]}>
                  {[
                    ['home.onboarding.recordTitle', 'home.onboarding.recordBody'],
                    ['home.onboarding.reviewTitle', 'home.onboarding.reviewBody'],
                    ['home.onboarding.notesTitle', 'home.onboarding.notesBody'],
                  ].map(([titleKey, bodyKey], index) => (
                    <View key={titleKey} style={styles.step}>
                      <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{index + 1}</Text></View>
                      <View style={styles.stepText}>
                        <Text style={styles.stepTitle}>{t(titleKey)}</Text>
                        <Text style={styles.stepBody}>{t(bodyKey)}</Text>
                      </View>
                    </View>
                  ))}
                </GlassCard>
              </View>
            </>
          ) : (
            <>
              <ContentReveal revealKey={focusKey}>
                <PageHeading
                  eyebrow={displayName ? `${greeting}, ${displayName}` : greeting}
                  title={t('home.nextLecture')}
                />
              </ContentReveal>
              <View style={[styles.homeGrid, isCompact && styles.homeGridCompact, isTabletCompact && styles.homeGridTabletCompact]}>
                <GlassCard elevated style={[styles.recordCard, isCompact && styles.recordCardCompact]}>
                  <SectionLabel>{t('home.recordLecture')}</SectionLabel>
                  <View style={styles.selectorRow}>
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel={t('home.course')}
                      onPress={cycleCourse}
                      style={styles.courseSelector}
                    >
                      <IconTile
                        icon={(selectedCourse?.icon ?? 'people-outline') as IconName}
                        color={colors.textSecondary}
                        backgroundColor={colors.surfaceMuted}
                      />
                      <View style={styles.selectorText}>
                        <Text style={styles.selectorLabel}>{t('home.course')}</Text>
                        <Text style={styles.selectorValue} numberOfLines={1}>{localizeSystemDefaultTitle(t, selectedCourse?.name)}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={17} color={colors.textTertiary} />
                    </PressableScale>
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel={t('home.createCourse')}
                      onPress={openCreateCourse}
                      style={styles.addCourse}
                    >
                      <Ionicons name="add" size={22} color={colors.textTertiary} />
                    </PressableScale>
                  </View>
                  <TextInput
                    value={lectureTitle}
                    onChangeText={setLectureTitle}
                    placeholder={t('home.lecturePlaceholder')}
                    placeholderTextColor={colors.textTertiary}
                    style={styles.input}
                    maxLength={60}
                  />
                  <PrimaryButton label={t('home.startRecording')} icon="radio-button-on" size="lg" onPress={startRecording} />
                  <View style={styles.featureRow}>
                    <Pill>{t('home.liveCaptions')}</Pill>
                    <Pill>{t('home.bilingual')}</Pill>
                    <Pill>{t('home.smartNotes')}</Pill>
                  </View>
                </GlassCard>

                <View style={[styles.sideStack, isCompact && styles.sideStackCompact]}>
                  <GlassCard padding={20}>
                    <SectionLabel>{t('home.today')}</SectionLabel>
                    {isGuest ? (
                      <>
                        <View style={styles.metricRow}>
                          <Text style={styles.metricLabel}>{t('home.guestLeft')}</Text>
                          <Text style={styles.metricValue}>{guestRemaining}</Text>
                        </View>
                        <ProgressBar value={guestRemaining > 0 ? 0.35 : 1} />
                        <Pressable onPress={goToSignIn}><Text style={styles.accountLink}>{t('home.signInAccess')}</Text></Pressable>
                      </>
                    ) : (
                      <>
                        <View style={styles.metricRow}>
                          <Text style={styles.metricLabel}>{t('home.recordings')}</Text>
                          <Text style={styles.metricValue}>
                            {planLoading ? '—' : `${recordingsUsed} / ${recordingsLimit || '—'}`}
                          </Text>
                        </View>
                        <ProgressBar value={usageProgress} />
                        <View style={styles.metricRow}>
                          <Text style={styles.metricLabel}>{t('home.maxLength')}</Text>
                          <Text style={styles.metricValue}>{t('home.minutesValue', { minutes: planStatus?.maxRecordingMinutes ?? '—' })}</Text>
                        </View>
                      </>
                    )}
                  </GlassCard>

                  <GlassCard padding={20} style={styles.recentCard}>
                    <View style={styles.recentHeader}>
                      <SectionLabel>{t('home.recentLectures')}</SectionLabel>
                      <Pressable onPress={() => router.push('/courses')}><Text style={styles.viewAll}>{t('home.viewAll')}</Text></Pressable>
                    </View>
                    {recentLectures.length ? recentLectures.map((lecture, index) => {
                      const course = getCourse(lecture.courseId);
                      const inProgress = lecture.status === 'in_progress';
                      return (
                        <PressableScale
                          key={lecture.id}
                          accessibilityRole="button"
                          accessibilityLabel={localizeSystemDefaultTitle(t, lecture.title)}
                          onPress={() =>
                            inProgress
                              ? router.push({ pathname: '/recording', params: { lectureId: lecture.id } })
                              : isLectureComplete(lecture)
                                ? router.push({ pathname: '/lecture/[id]', params: { id: lecture.id } })
                                : router.push({ pathname: '/processing', params: { lectureId: lecture.id } })
                          }
                          scaleTo={0.995}
                          pressedStyle={styles.lectureRowPressed}
                          style={[styles.lectureRow, index < recentLectures.length - 1 && styles.lectureDivider]}
                        >
                          <IconTile icon={inProgress ? 'mic-outline' : 'document-text-outline'} size={32} />
                          <View style={styles.lectureText}>
                            <View style={styles.lectureTitleRow}>
                              <Text numberOfLines={1} style={styles.lectureTitle}>{localizeSystemDefaultTitle(t, lecture.title)}</Text>
                              {inProgress ? (
                                <View style={styles.inProgressBadge}>
                                  <Text style={styles.inProgressBadgeText}>{t('home.inProgress')}</Text>
                                </View>
                              ) : null}
                            </View>
                            <Text numberOfLines={1} style={styles.lectureMeta}>{course?.name ? localizeSystemDefaultTitle(t, course.name) : t('lecture.defaultCourse')} · {formatShortDate(lecture.date, language)}</Text>
                          </View>
                          <Text style={styles.duration}>{formatDuration(lecture.durationMillis)}</Text>
                        </PressableScale>
                      );
                    }) : (
                      <Text style={styles.emptyRecent}>{t('home.emptyRecent')}</Text>
                    )}
                  </GlassCard>
                </View>
              </View>
            </>
          )}
        </PageShellTransition>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  scroll: { paddingHorizontal: layout.workspacePadding, paddingTop: 28, paddingBottom: 40 },
  // Extra bottom clearance for the collapsed bottom tab bar on phone.
  scrollCompact: { paddingHorizontal: 18, paddingBottom: 100 },
  // Wider tablet margins keep the compact branch calm without changing the
  // accepted phone layout or moving iPad portrait into the sidebar branch.
  scrollTabletCompact: { paddingHorizontal: 32 },
  content: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 22 },
  contentTabletCompact: { maxWidth: 780 },
  loading: { minHeight: 420, alignItems: 'center', justifyContent: 'center' },
  homeGrid: { flexDirection: 'row', gap: 16, alignItems: 'stretch' },
  // Phone: stack instead of a fixed 1.55/1 split — that split assumes iPad
  // width; on a phone it leaves both columns too narrow to read comfortably
  // (this is what clipped "View all" and wrapped "Guest recordings left").
  homeGridCompact: { flexDirection: 'column' },
  homeGridTabletCompact: { gap: 20 },
  recordCard: { flex: 1.55 },
  recordCardCompact: { flex: 0 },
  sideStack: { flex: 1, gap: 14 },
  sideStackCompact: { flex: 0 },
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
  // A full-width row scales only slightly (0.995) and adds a background tint on
  // press — the same native affordance LectureListItem uses in Courses, so a
  // recent-lecture tap here feels identical to opening a lecture there.
  lectureRowPressed: { backgroundColor: colors.surfaceMuted },
  lectureDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  lectureText: { flex: 1 },
  lectureTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  lectureTitle: { color: colors.ink, fontSize: 13.5, fontWeight: '700', flexShrink: 1 },
  lectureMeta: { color: colors.textTertiary, fontSize: 11.5, marginTop: 2 },
  inProgressBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(11, 31, 58, 0.08)',
  },
  inProgressBadgeText: {
    color: colors.accentBright,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  duration: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  emptyRecent: { color: colors.textTertiary, fontSize: 12.5, marginTop: 18 },
  emptyGrid: { flexDirection: 'row', gap: 16, minHeight: 410, alignItems: 'stretch' },
  emptyGridCompact: { flexDirection: 'column', minHeight: 0 },
  // Portrait iPad: stack the empty-state cards naturally, top-aligned, at their
  // intrinsic height. A previous attempt forced `minHeight: 650` +
  // `space-between` to "distribute" them down the taller canvas, but on a real
  // 11" portrait viewport that reads as an accidental hole between two cramped
  // cards rather than deliberate negative space. Any leftover room now simply
  // falls below the content, which is what a scroll view should do.
  emptyGridTabletCompact: { gap: 24, paddingBottom: 12 },
  emptyHero: { flex: 1, justifyContent: 'center', overflow: 'hidden' },
  emptyHeroCompact: { flex: 0 },
  emptyHeroContent: { width: '100%', maxWidth: 430, alignSelf: 'center' },
  // The 430/340 caps above are sized for the WIDE two-column layout, where the
  // hero is a narrow column beside the steps card. On portrait iPad the hero is
  // full-width, so those caps leave the copy stranded in a thin centred ribbon
  // with large dead margins. These widen it to suit the single-column canvas.
  emptyHeroContentTabletCompact: { maxWidth: 560 },
  emptyBodyTabletCompact: { maxWidth: 520 },
  emptyTitle: { marginTop: 14, color: colors.ink, fontSize: 22, fontWeight: '800' },
  emptyBody: { marginTop: 8, maxWidth: 340, color: colors.textSecondary, fontSize: 13.5, lineHeight: 21 },
  emptyActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 22 },
  stepsCard: { flex: 1, justifyContent: 'center', gap: 22 },
  stepsCardCompact: { flex: 0 },
  step: { flexDirection: 'row', gap: 14 },
  stepNumber: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  stepNumberText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  stepText: { flex: 1 },
  stepTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  stepBody: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 3 },
});
