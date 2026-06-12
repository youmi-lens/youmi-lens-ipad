import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CourseCard } from '@/components/CourseCard';
import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SwipeDeleteRow } from '@/components/SwipeDeleteRow';
import { colors, fontSize, layout, radius, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/format';
import { useData } from '@/lib/store';

export default function CoursesScreen() {
  const router = useRouter();
  const { loaded, courses, lectures, lecturesForCourse, setSelectedCourseId, deleteCourse } =
    useData();

  // Only one swipe-delete row may be open at a time.
  const [openCourseId, setOpenCourseId] = useState<string | null>(null);

  const openCreateCourse = () => router.push('/create-course');

  const openCourse = (courseId: string) => {
    setOpenCourseId(null);
    setSelectedCourseId(courseId);
    router.push({ pathname: '/course/[id]', params: { id: courseId } });
  };

  const showCourseNotEmptyAlert = () => {
    Alert.alert(
      'Course is not empty',
      'This course contains lectures. Delete or move them first.',
      [{ text: 'OK', onPress: () => setOpenCourseId(null) }],
    );
  };

  const confirmDeleteCourse = (courseId: string, activeLectureCount: number) => {
    // Only an empty course can be deleted — a course with lectures keeps its
    // lectures, so the user must remove them first.
    if (activeLectureCount > 0) {
      showCourseNotEmptyAlert();
      return;
    }
    Alert.alert(
      'Delete course',
      'This empty course will move to Recently Deleted. You can restore it anytime.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => setOpenCourseId(null) },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            const result = deleteCourse(courseId);
            setOpenCourseId(null);
            // Defensive: a lecture could have been added between render and tap.
            if (!result.ok) showCourseNotEmptyAlert();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => setOpenCourseId(null)}
      >
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>Courses</Text>
              <Text style={styles.subtitle}>
                {courses.length} {courses.length === 1 ? 'course' : 'courses'} ·{' '}
                {lectures.length} {lectures.length === 1 ? 'lecture' : 'lectures'}
              </Text>
            </View>
            {loaded && courses.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="New course"
                onPress={openCreateCourse}
                style={({ pressed }) => [styles.newBtn, pressed && styles.pressed]}
              >
                <Ionicons name="add" size={18} color={colors.deepNavy} />
                <Text style={styles.newBtnText}>New</Text>
              </Pressable>
            ) : null}
          </View>

          {!loaded ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.deepNavy} />
            </View>
          ) : courses.length === 0 ? (
            /* ---- Empty state ---- */
            <GlassCard style={styles.emptyCard}>
              <View style={styles.emptyIcon}>
                <Ionicons name="library-outline" size={32} color={colors.deepNavy} />
              </View>
              <Text style={styles.emptyTitle}>No courses yet</Text>
              <Text style={styles.emptyBody}>
                Create a course to organize your lectures.
              </Text>
              <PrimaryButton
                label="Create Course"
                icon="add"
                onPress={openCreateCourse}
                style={styles.emptyButton}
              />
            </GlassCard>
          ) : (
            <View style={styles.list}>
              {courses.map((course) => {
                const courseLectures = lecturesForCourse(course.id);
                const latest = [...courseLectures].sort((a, b) =>
                  b.date.localeCompare(a.date),
                )[0];
                const lastActivity = latest
                  ? `Last ${formatShortDate(latest.date)}`
                  : undefined;

                // Any course can be swipe-deleted — delete is now a safe,
                // recoverable move to Recently Deleted (see store.deleteCourse).
                return (
                  <SwipeDeleteRow
                    key={course.id}
                    open={openCourseId === course.id}
                    onOpen={() => setOpenCourseId(course.id)}
                    onClose={() => setOpenCourseId(null)}
                    onDelete={() => confirmDeleteCourse(course.id, courseLectures.length)}
                  >
                    <CourseCard
                      course={course}
                      lectureCount={courseLectures.length}
                      lastActivity={lastActivity}
                      onPress={() => openCourse(course.id)}
                    />
                  </SwipeDeleteRow>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: 'transparent',
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
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  headerText: {
    flex: 1,
    gap: spacing.xs,
  },
  title: {
    fontSize: fontSize.display,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 42,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    marginTop: spacing.xs,
  },
  newBtnText: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.deepNavy,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.97 }],
  },
  loading: {
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
  },
  list: {
    gap: spacing.md,
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
    marginTop: spacing.sm,
    maxWidth: 340,
  },
  emptyButton: {
    marginTop: spacing.xl,
    alignSelf: 'stretch',
  },
});
