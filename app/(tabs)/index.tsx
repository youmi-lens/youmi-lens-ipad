import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ComponentProps, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandHeader } from '@/components/BrandHeader';
import { GlassCard } from '@/components/GlassCard';
import { LectureListItem } from '@/components/LectureListItem';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { colors, fontSize, layout, radius, shadows, spacing } from '@/constants/theme';
import { plan, user } from '@/data/mockData';
import { greetingForNow } from '@/lib/format';
import { COURSE_PRESETS } from '@/lib/models';
import { useData } from '@/lib/store';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const VALUE_POINTS: { icon: IoniconName; label: string }[] = [
  { icon: 'mic-outline', label: 'Live captions' },
  { icon: 'language-outline', label: 'Bilingual summary' },
  { icon: 'document-text-outline', label: 'Smart notes' },
];

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

  const [lectureTitle, setLectureTitle] = useState('');

  const selectedCourse = getCourse(selectedCourseId) ?? courses[0];
  const recentLectures = [...lectures]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  const openCreateCourse = () => router.push('/create-course');

  const startQuickRecording = () => {
    const preset = COURSE_PRESETS[0];
    const course = createCourse({
      name: 'General Lectures',
      icon: preset.icon,
      tint: preset.tint,
      accent: preset.accent,
    });
    router.push({
      pathname: '/recording',
      params: { courseId: course.id, lectureTitle: '' },
    });
  };

  const startRecording = () => {
    if (!selectedCourse) return;
    router.push({
      pathname: '/recording',
      params: { courseId: selectedCourse.id, lectureTitle: lectureTitle.trim() },
    });
  };

  const cycleCourse = () => {
    if (courses.length < 2 || !selectedCourse) return;
    const idx = courses.findIndex((c) => c.id === selectedCourse.id);
    setSelectedCourseId(courses[(idx + 1) % courses.length].id);
  };

  const openLecture = (id: string) =>
    router.push({ pathname: '/lecture/[id]', params: { id } });

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <BrandHeader
            subtitle="for iPad"
            right={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Account"
                onPress={() => router.push('/settings')}
                style={({ pressed }) => [styles.accountBtn, pressed && styles.pressedSoft]}
              >
                <Ionicons name="person-outline" size={22} color={colors.deepNavy} />
              </Pressable>
            }
          />

          {!loaded ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.deepNavy} />
            </View>
          ) : courses.length === 0 ? (
            /* ---- Empty state — no courses yet ---- */
            <GlassCard style={styles.emptyCard}>
              <View style={styles.emptyIcon}>
                <Ionicons name="school-outline" size={34} color={colors.deepNavy} />
              </View>
              <Text style={styles.emptyTitle}>Create your first course</Text>
              <Text style={styles.emptyBody}>
                Start by adding a course, then record your first lecture.
              </Text>
              <PrimaryButton
                label="Create Course"
                icon="add"
                onPress={openCreateCourse}
                style={styles.emptyPrimary}
              />
              <SecondaryButton
                label="Start Quick Recording"
                icon="mic"
                tone="ice"
                onPress={startQuickRecording}
                style={styles.emptySecondary}
              />
            </GlassCard>
          ) : (
            <>
              {/* ---- Hero ---- */}
              <View style={styles.heroOuter}>
                <View style={styles.heroInner}>
                  <Text style={styles.heroWatermark} allowFontScaling={false}>
                    Y
                  </Text>

                  <Text style={styles.heroEyebrow}>
                    {`${greetingForNow()}, ${user.firstName}`.toUpperCase()}
                  </Text>
                  <Text style={styles.heroTitle}>Ready for your next lecture?</Text>

                  <View style={styles.valueRow}>
                    {VALUE_POINTS.map((point) => (
                      <View key={point.label} style={styles.valueChip}>
                        <Ionicons name={point.icon} size={13} color={colors.mutedBlueGray} />
                        <Text style={styles.valueChipText}>{point.label}</Text>
                      </View>
                    ))}
                  </View>

                  {/* Course selector + add */}
                  <View style={styles.selectorRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Course ${selectedCourse?.name}. Tap to switch.`}
                      onPress={cycleCourse}
                      style={({ pressed }) => [
                        styles.courseSelector,
                        pressed && styles.pressedSoft,
                      ]}
                    >
                      <View
                        style={[
                          styles.courseTile,
                          { backgroundColor: selectedCourse?.tint ?? colors.iceTint },
                        ]}
                      >
                        <Ionicons
                          name={(selectedCourse?.icon ?? 'book-outline') as IoniconName}
                          size={22}
                          color={selectedCourse?.accent ?? colors.deepNavy}
                        />
                      </View>
                      <View style={styles.courseSelectorText}>
                        <Text style={styles.courseSelectorLabel}>COURSE</Text>
                        <Text style={styles.courseSelectorValue} numberOfLines={1}>
                          {selectedCourse?.name}
                        </Text>
                      </View>
                      {courses.length > 1 ? (
                        <Ionicons name="swap-vertical" size={18} color={colors.textTertiary} />
                      ) : null}
                    </Pressable>

                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="New course"
                      onPress={openCreateCourse}
                      style={({ pressed }) => [styles.addCourseBtn, pressed && styles.pressedSoft]}
                    >
                      <Ionicons name="add" size={24} color={colors.deepNavy} />
                    </Pressable>
                  </View>

                  {/* Optional lecture title */}
                  <TextInput
                    style={styles.titleInput}
                    value={lectureTitle}
                    onChangeText={setLectureTitle}
                    placeholder="Lecture title (optional)"
                    placeholderTextColor={colors.textTertiary}
                    returnKeyType="done"
                    maxLength={60}
                  />

                  <PrimaryButton
                    label="Start Recording"
                    icon="mic"
                    size="lg"
                    onPress={startRecording}
                    style={styles.startButton}
                  />
                </View>
              </View>

              {/* ---- Recent Lectures ---- */}
              <View style={styles.sectionHeader}>
                <View style={styles.sectionTitleRow}>
                  <Text style={styles.sectionTitle}>Recent Lectures</Text>
                  {recentLectures.length > 0 ? (
                    <View style={styles.countBadge}>
                      <Text style={styles.countBadgeText}>{lectures.length}</Text>
                    </View>
                  ) : null}
                </View>
                {lectures.length > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => router.push('/courses')}
                    hitSlop={8}
                  >
                    <Text style={styles.viewAll}>View all</Text>
                  </Pressable>
                ) : null}
              </View>

              {recentLectures.length > 0 ? (
                <GlassCard padding={spacing.xs}>
                  {recentLectures.map((lecture, i) => (
                    <LectureListItem
                      key={lecture.id}
                      lecture={lecture}
                      course={getCourse(lecture.courseId)}
                      variant="row"
                      last={i === recentLectures.length - 1}
                      onPress={() => openLecture(lecture.id)}
                    />
                  ))}
                </GlassCard>
              ) : (
                <GlassCard style={styles.lecturesEmpty}>
                  <Ionicons name="mic-outline" size={22} color={colors.mutedBlueGray} />
                  <Text style={styles.lecturesEmptyText}>
                    Your recorded lectures will appear here.
                  </Text>
                </GlassCard>
              )}

              {/* ---- Current Plan ---- */}
              <GlassCard>
                <View style={styles.planHeader}>
                  <View style={styles.planLabelRow}>
                    <Ionicons name="diamond-outline" size={15} color={colors.mutedBlueGray} />
                    <Text style={styles.cardLabel}>CURRENT PLAN</Text>
                  </View>
                  <Text style={styles.planName}>{plan.name}</Text>
                </View>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${plan.progress * 100}%` }]} />
                </View>
                <View style={styles.planMetaRow}>
                  <Text style={styles.planUsage}>
                    {plan.usedMinutes.toLocaleString()} mins used · {plan.totalLabel}
                  </Text>
                  <Text style={styles.planRenew}>{plan.renewLabel}</Text>
                </View>
              </GlassCard>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  content: {
    width: '100%',
    maxWidth: layout.content,
    alignSelf: 'center',
    gap: spacing.xl,
  },
  accountBtn: {
    width: 46,
    height: 46,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressedSoft: {
    opacity: 0.85,
  },
  loading: {
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
  },

  // ---- Empty state ----
  emptyCard: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: radius.xl,
    backgroundColor: colors.iceTint,
    borderWidth: 1,
    borderColor: colors.iceBlue,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: fontSize.md * 1.5,
    marginTop: spacing.sm,
    maxWidth: 360,
  },
  emptyPrimary: {
    marginTop: spacing.xl,
    alignSelf: 'stretch',
  },
  emptySecondary: {
    marginTop: spacing.md,
    alignSelf: 'stretch',
  },

  // ---- Hero ----
  heroOuter: {
    borderRadius: radius.xxl,
    backgroundColor: colors.surface,
    ...shadows.card,
  },
  heroInner: {
    borderRadius: radius.xxl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.glassEdge,
    backgroundColor: colors.surface,
    padding: spacing.xxl,
  },
  heroWatermark: {
    position: 'absolute',
    right: -34,
    bottom: -76,
    fontSize: 230,
    fontWeight: '900',
    color: colors.watermark,
  },
  heroEyebrow: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.4,
    color: colors.mutedBlueGray,
  },
  heroTitle: {
    fontSize: fontSize.hero,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.4,
    marginTop: spacing.sm,
    maxWidth: 360,
  },
  valueRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  valueChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.iceTint,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  valueChipText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  selectorRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  courseSelector: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.softIceWhite,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  courseTile: {
    width: 42,
    height: 42,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  courseSelectorText: {
    flex: 1,
    gap: 1,
  },
  courseSelectorLabel: {
    fontSize: 10,
    color: colors.textTertiary,
    fontWeight: '700',
    letterSpacing: 1,
  },
  courseSelectorValue: {
    fontSize: fontSize.lg,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  addCourseBtn: {
    width: 56,
    borderRadius: radius.md,
    backgroundColor: colors.softIceWhite,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleInput: {
    minHeight: 50,
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textPrimary,
    backgroundColor: colors.softIceWhite,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  startButton: {
    marginTop: spacing.lg,
  },

  // ---- Recent Lectures ----
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: -spacing.sm,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sectionTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  countBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: colors.iceTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.deepNavy,
  },
  viewAll: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.mutedBlueGray,
  },
  lecturesEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  lecturesEmptyText: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textTertiary,
    fontWeight: '500',
  },

  // ---- Plan ----
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  planLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  cardLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: colors.textTertiary,
  },
  planName: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  progressTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.deepNavy,
  },
  planMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  planUsage: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  planRenew: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
  },
});
