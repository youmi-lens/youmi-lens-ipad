import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ContentReveal } from '@/components/ContentReveal';
import { CourseCardSkeleton } from '@/components/ContentSkeleton';
import { CourseCard } from '@/components/CourseCard';
import { GlassCard } from '@/components/GlassCard';
import { PageShellTransition } from '@/components/PageShellTransition';
import { PressableScale } from '@/components/PressableScale';
import { PrimaryButton } from '@/components/PrimaryButton';
import { StaggeredCardEntrance } from '@/components/StaggeredCardEntrance';
import { SwipeDeleteRow } from '@/components/SwipeDeleteRow';
import { PageHeading } from '@/components/WorkspaceUI';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors, layout } from '@/constants/theme';
import { buildCourseStats, totalLectureDuration } from '@/lib/courseStats.mjs';
import { formatDuration, formatShortDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/store';

export default function CoursesScreen() {
  const { t, language } = useI18n();
  const router = useRouter();
  const isCompact = useIsCompactWidth();
  const { loaded, courses, lectures, setSelectedCourseId, deleteCourse, refreshCloudLibrary } = useData();
  const [openCourseId, setOpenCourseId] = useState<string | null>(null);
  // Bumped once per tab focus, never by course/lecture data — this is what
  // the page-shell entrance below keys on, so a create/delete/rename/Realtime
  // update can never restart it. See ContentReveal for why the grid itself
  // must stay a plain, un-keyed View regardless.
  const [focusKey, setFocusKey] = useState(0);

  // Match Desktop's route-entry invalidation: Mac-originated changes are read
  // when this screen regains focus. The store coalesces it with foreground
  // refresh and preserves current state if the request fails.
  useFocusEffect(
    useCallback(() => {
      setFocusKey((key) => key + 1);
      void refreshCloudLibrary().catch(() => {});
    }, [refreshCloudLibrary]),
  );

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

  // Every per-course aggregate the grid needs, in one memoized pass over
  // `lectures` instead of a scan-plus-sort per card. See lib/courseStats.mjs
  // for why that mattered to Courses' first paint.
  const courseStats = useMemo(() => buildCourseStats(lectures), [lectures]);
  const totalDuration = useMemo(() => totalLectureDuration(lectures), [lectures]);
  const countsKey = courses.length === 1
    ? lectures.length === 1 ? 'courses.counts.oneOne' : 'courses.counts.oneOther'
    : lectures.length === 1 ? 'courses.counts.otherOne' : 'courses.counts';

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={[styles.scroll, isCompact && styles.scrollCompact]}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => setOpenCourseId(null)}
      >
        {/* The whole shell — heading AND the dynamic body below it — settles
            together as one translate-only movement (never opacity) keyed to
            tab focus, so the page reads as one coherent transition rather
            than "title animates, body pops in". The grid itself never goes
            through an opacity-driven state, however this container moves;
            see PageShellTransition. */}
        <PageShellTransition style={styles.content} revealKey={focusKey}>
          <ContentReveal revealKey={focusKey}>
            <PageHeading
              eyebrow={t('courses.library')}
              title={t('courses.title')}
              subtitle={`${t(countsKey, { courses: courses.length, lectures: lectures.length })}${lectures.length ? ` · ${formatDuration(totalDuration)}` : ''}`}
              action={loaded && courses.length ? (
                <View style={[styles.headerActions, isCompact && styles.headerActionsCompact]}>
                  <PrimaryButton label={t('courses.new')} icon="add" onPress={() => router.push('/create-course')} style={isCompact ? styles.newButtonCompact : styles.newButton} />
                </View>
              ) : undefined}
            />
          </ContentReveal>

          {!loaded ? (
            // Content-shaped placeholders, not a centred spinner: the grid keeps
            // its geometry so hydrated courses fill in rather than replacing a
            // blank panel. Three is enough to establish the shape without
            // implying a specific library size.
            <View style={styles.grid} accessibilityLabel={t('courses.title')}>
              {[0, 1, 2].map((i) => (
                <CourseCardSkeleton key={i} style={[styles.gridItem, isCompact && styles.gridItemCompact]} />
              ))}
            </View>
          ) : courses.length === 0 ? (
            <GlassCard padding={36} style={styles.empty}>
              <View style={styles.emptyGroup}>
                <View style={styles.emptyIcon}><Ionicons name="library-outline" size={30} color={colors.navy} /></View>
                <Text style={styles.emptyTitle}>{t('courses.emptyTitle')}</Text>
                <Text style={styles.emptyBody}>{t('courses.emptyBody')}</Text>
                <PrimaryButton label={t('home.createCourse')} icon="add" onPress={() => router.push('/create-course')} style={styles.emptyButton} />
              </View>
            </GlassCard>
          ) : (
            // This collection is mutation-driven and must stay continuously
            // visible. A full-grid opacity/layout animation can blank every
            // card when navigation or a native layout transaction reattaches
            // the subtree, so only stable layout participates here.
            <View style={styles.grid}>
              {courses.map((course, index) => {
                const stats = courseStats.get(course.id);
                const lectureCount = stats?.count ?? 0;
                return (
                  // Per-card entrance, independent Animated.Value per instance
                  // — NOT a shared wrapper around the whole grid. Keyed on
                  // focusKey (tab-focus only), so create/delete/rename/Realtime
                  // never replays an existing card's animation; a genuinely
                  // new course (new UUID, new instance) plays its own once on
                  // mount. See StaggeredCardEntrance for the full reasoning.
                  <StaggeredCardEntrance
                    key={course.id}
                    revealKey={focusKey}
                    index={index}
                    style={[styles.gridItem, isCompact && styles.gridItemCompact]}
                  >
                    <SwipeDeleteRow
                      open={openCourseId === course.id}
                      onOpen={() => setOpenCourseId(course.id)}
                      onClose={() => setOpenCourseId(null)}
                      onDelete={() => confirmDeleteCourse(course.id, lectureCount)}
                    >
                      <CourseCard
                        course={course}
                        lectureCount={lectureCount}
                        durationLabel={lectureCount ? formatDuration(stats!.duration) : undefined}
                        lastActivity={stats?.latestDate ? t('courses.last', { date: formatShortDate(stats.latestDate, language) }) : undefined}
                        readyCount={stats?.ready ?? 0}
                        onPress={() => openCourse(course.id)}
                      />
                    </SwipeDeleteRow>
                  </StaggeredCardEntrance>
                );
              })}
              <PressableScale
                onPress={() => router.push('/create-course')}
                accessibilityRole="button"
                accessibilityLabel={t('courses.new')}
                style={[styles.ghostCard, isCompact && styles.gridItemCompact]}
              >
                <View style={styles.plus}><Ionicons name="add" size={22} color={colors.navy} /></View>
                <Text style={styles.ghostLabel}>{t('courses.new')}</Text>
              </PressableScale>
            </View>
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
  content: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 24 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerActionsCompact: { width: '100%' },
  newButton: { minHeight: 42 },
  newButtonCompact: { minHeight: 46, width: '100%' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  gridItem: { width: '31.8%', minWidth: 250 },
  // The 31.8%/minWidth pair is an iPad 3-column rule; on any compact-width
  // device (including a wide-ish one like iPad mini portrait) it degrades to
  // one column but stays pinned at ~250-380pt, leaving a dead gap beside it.
  // Compact width should mean "one column that fills the row," not "a narrow
  // fixed-width column with empty space next to it."
  gridItemCompact: { width: '100%', minWidth: 0 },
  ghostCard: { width: '31.8%', minWidth: 250, minHeight: 196, alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.borderStrong, borderRadius: 20, backgroundColor: colors.glass },
  plus: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  ghostLabel: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
  empty: { alignItems: 'center', alignSelf: 'center', width: '100%', minHeight: 260, justifyContent: 'center' },
  emptyGroup: { width: '100%', maxWidth: 420, alignItems: 'center' },
  emptyIcon: { width: 62, height: 62, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  emptyTitle: { color: colors.ink, fontSize: 22, fontWeight: '800', marginTop: 16 },
  emptyBody: { color: colors.textSecondary, fontSize: 13.5, lineHeight: 20, textAlign: 'center', maxWidth: 380, marginTop: 8 },
  emptyButton: { marginTop: 20, minWidth: 190, maxWidth: 260, alignSelf: 'center' },
});
