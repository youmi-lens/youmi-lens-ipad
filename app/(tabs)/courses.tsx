import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CourseCard } from '@/components/CourseCard';
import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SwipeDeleteRow } from '@/components/SwipeDeleteRow';
import { PageHeading } from '@/components/WorkspaceUI';
import { colors, layout } from '@/constants/theme';
import { formatDuration, formatShortDate } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useData } from '@/lib/store';

export default function CoursesScreen() {
  const t = useT();
  const router = useRouter();
  const { loaded, courses, lectures, lecturesForCourse, setSelectedCourseId, deleteCourse } = useData();
  const [openCourseId, setOpenCourseId] = useState<string | null>(null);

  const openCourse = (courseId: string) => {
    setOpenCourseId(null);
    setSelectedCourseId(courseId);
    router.push({ pathname: '/course/[id]', params: { id: courseId } });
  };

  const showCourseNotEmptyAlert = () => {
    Alert.alert(
      t('courses.notEmptyTitle'),
      t('courses.notEmptyBody'),
      [{ text: t('common.ok'), onPress: () => setOpenCourseId(null) }],
    );
  };

  const confirmDeleteCourse = (courseId: string, activeLectureCount: number) => {
    if (activeLectureCount > 0) {
      showCourseNotEmptyAlert();
      return;
    }
    Alert.alert(
      t('courses.deleteTitle'),
      t('courses.deleteBody'),
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => setOpenCourseId(null) },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            const result = deleteCourse(courseId);
            setOpenCourseId(null);
            if (!result.ok) showCourseNotEmptyAlert();
          },
        },
      ],
    );
  };

  const totalDuration = lectures.reduce((total, lecture) => total + lecture.durationMillis, 0);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => setOpenCourseId(null)}
      >
        <View style={styles.content}>
          <PageHeading
            eyebrow={t('courses.library')}
            title={t('courses.title')}
            subtitle={`${t('courses.counts', { courses: courses.length, lectures: lectures.length })}${lectures.length ? ` · ${formatDuration(totalDuration)}` : ''}`}
            action={loaded && courses.length ? (
              <View style={styles.headerActions}>
                <PrimaryButton label={t('courses.new')} icon="add" onPress={() => router.push('/create-course')} style={styles.newButton} />
              </View>
            ) : undefined}
          />

          {!loaded ? (
            <View style={styles.loading}><ActivityIndicator color={colors.accent} /></View>
          ) : courses.length === 0 ? (
            <GlassCard padding={36} style={styles.empty}>
              <View style={styles.emptyIcon}><Ionicons name="library-outline" size={30} color={colors.navy} /></View>
              <Text style={styles.emptyTitle}>{t('courses.emptyTitle')}</Text>
              <Text style={styles.emptyBody}>{t('courses.emptyBody')}</Text>
              <PrimaryButton label={t('home.createCourse')} icon="add" onPress={() => router.push('/create-course')} style={styles.emptyButton} />
            </GlassCard>
          ) : (
            <View style={styles.grid}>
              {courses.map((course) => {
                const courseLectures = lecturesForCourse(course.id);
                const latest = [...courseLectures].sort((a, b) => b.date.localeCompare(a.date))[0];
                const duration = courseLectures.reduce((total, lecture) => total + lecture.durationMillis, 0);
                const ready = courseLectures.filter((lecture) => lecture.processingStatus === 'ready').length;
                return (
                  <SwipeDeleteRow
                    key={course.id}
                    open={openCourseId === course.id}
                    onOpen={() => setOpenCourseId(course.id)}
                    onClose={() => setOpenCourseId(null)}
                    onDelete={() => confirmDeleteCourse(course.id, courseLectures.length)}
                    style={styles.gridItem}
                  >
                    <CourseCard
                      course={course}
                      lectureCount={courseLectures.length}
                      durationLabel={courseLectures.length ? formatDuration(duration) : undefined}
                      lastActivity={latest ? t('courses.last', { date: formatShortDate(latest.date) }) : undefined}
                      readyCount={ready}
                      onPress={() => openCourse(course.id)}
                    />
                  </SwipeDeleteRow>
                );
              })}
              <Pressable onPress={() => router.push('/create-course')} style={({ pressed }) => [styles.ghostCard, pressed && styles.pressed]}>
                <View style={styles.plus}><Ionicons name="add" size={22} color={colors.navy} /></View>
                <Text style={styles.ghostLabel}>{t('courses.new')}</Text>
              </Pressable>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  scroll: { paddingHorizontal: layout.workspacePadding, paddingTop: 28, paddingBottom: 40 },
  content: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 24 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  newButton: { minHeight: 42 },
  loading: { minHeight: 380, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  gridItem: { width: '31.8%', minWidth: 250 },
  ghostCard: { width: '31.8%', minWidth: 250, minHeight: 196, alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.borderStrong, borderRadius: 20, backgroundColor: colors.glass },
  plus: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  ghostLabel: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
  empty: { alignItems: 'center', alignSelf: 'center', width: '100%', minHeight: 300, justifyContent: 'center' },
  emptyIcon: { width: 62, height: 62, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  emptyTitle: { color: colors.ink, fontSize: 22, fontWeight: '800', marginTop: 16 },
  emptyBody: { color: colors.textSecondary, fontSize: 13.5, lineHeight: 20, textAlign: 'center', maxWidth: 380, marginTop: 8 },
  emptyButton: { marginTop: 20, minWidth: 260 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
});
