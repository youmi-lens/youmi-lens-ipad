import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PressableScale } from '@/components/PressableScale';
import { RESPONSIVE_MODAL_ORIENTATIONS } from '@/constants/modal';
import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { useT, localizeSystemDefaultTitle } from '@/lib/i18n';
import type { Course, Lecture } from '@/lib/models';
import { moveTargets } from '@/lib/lectureMove.mjs';

type Props = {
  visible: boolean;
  lecture: Lecture;
  courses: Course[];
  onClose: () => void;
  onSelect: (courseId: string) => void;
};

/** Shared responsive target-course picker; identity always stays a Course UUID. */
export function MoveLectureToCourseModal({ visible, lecture, courses, onClose, onSelect }: Props) {
  const t = useT();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const targets = moveTargets(courses, lecture) as Course[];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      presentationStyle="overFullScreen"
      supportedOrientations={RESPONSIVE_MODAL_ORIENTATIONS}
      onRequestClose={onClose}
    >
      <SafeAreaView style={[styles.root, isLandscape && styles.rootLandscape]} edges={['top', 'right', 'bottom', 'left']}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, isLandscape && styles.sheetLandscape]}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>{t('lecture.moveToCourse')}</Text>
              <Text style={styles.subtitle}>{t('lecture.moveToCourseDetail')}</Text>
            </View>
            <PressableScale accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={20} color={colors.textPrimary} />
            </PressableScale>
          </View>
          {targets.length === 0 ? (
            <Text style={styles.empty}>{t('lecture.noOtherCourses')}</Text>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
              {targets.map((course) => (
                <PressableScale
                  key={course.id}
                  accessibilityRole="button"
                  accessibilityLabel={t('lecture.moveToCourseA11y', { course: localizeSystemDefaultTitle(t, course.name) })}
                  onPress={() => onSelect(course.id)}
                  pressedStyle={styles.rowPressed}
                  style={styles.row}
                >
                  <View style={[styles.courseIcon, { backgroundColor: course.tint }]}>
                    <Ionicons name={course.icon as never} size={18} color={course.accent} />
                  </View>
                  <Text style={styles.courseName} numberOfLines={2}>{localizeSystemDefaultTitle(t, course.name)}</Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                </PressableScale>
              ))}
            </ScrollView>
          )}
          <PressableScale accessibilityRole="button" onPress={onClose} style={styles.cancelButton}>
            <Text style={styles.cancelLabel}>{t('common.cancel')}</Text>
          </PressableScale>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  rootLandscape: { justifyContent: 'center', paddingHorizontal: spacing.lg },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6, 27, 52, 0.38)' },
  sheet: { alignSelf: 'center', width: '100%', maxWidth: 620, maxHeight: '78%', backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.xl, gap: spacing.md, ...shadows.card },
  sheetLandscape: { width: '88%', maxHeight: '94%', borderRadius: radius.xl, padding: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: fontSize.xl, fontWeight: '800' },
  subtitle: { marginTop: 4, color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 19 },
  closeButton: { width: 40, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  list: { flexGrow: 0 },
  listContent: { gap: 8 },
  row: { minHeight: 56, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  courseIcon: { width: 36, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  courseName: { flex: 1, color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700', lineHeight: 21 },
  empty: { paddingVertical: spacing.xl, color: colors.textSecondary, fontSize: fontSize.md, textAlign: 'center' },
  cancelButton: { minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  cancelLabel: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700' },
});
