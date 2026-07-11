import { Ionicons } from '@expo/vector-icons';
import { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { formatDuration, formatShortDate } from '@/lib/format';
import { useT, localizeSystemDefaultTitle } from '@/lib/i18n';
import type { Course, Lecture } from '@/lib/models';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type LectureListItemProps = {
  lecture: Lecture;
  /** The course this lecture belongs to, resolved by the parent. */
  course?: Course;
  onPress?: () => void;
  /**
   * `card` — a standalone elevated card.
   * `row` — a flat row meant to sit inside a GlassCard list, with a divider.
   */
  variant?: 'card' | 'row';
  /** For the `row` variant: suppress the bottom divider on the last item. */
  last?: boolean;
};

/**
 * A lecture entry: a soft course-coloured icon tile, the lecture title, its
 * course, and date · duration meta — all driven by real local data.
 */
export function LectureListItem({
  lecture,
  course,
  onPress,
  variant = 'card',
  last = false,
}: LectureListItemProps) {
  const t = useT();
  const isRow = variant === 'row';
  const tint = course?.tint ?? colors.iceTint;
  const accent = course?.accent ?? colors.deepNavy;
  const icon = (course?.icon ?? 'document-text-outline') as IoniconName;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        isRow ? styles.rowFlat : styles.rowCard,
        isRow && !last && styles.divider,
        pressed && (isRow ? styles.rowPressed : styles.cardPressed),
      ]}
    >
      <View style={[styles.iconBox, { backgroundColor: tint }]}>
        <Ionicons name={icon} size={21} color={accent} />
      </View>

      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {localizeSystemDefaultTitle(t, lecture.title)}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {course?.name ? localizeSystemDefaultTitle(t, course.name) : t('lecture.defaultCourse')}
        </Text>
      </View>

      <View style={styles.trailing}>
        <Text style={styles.date}>{formatShortDate(lecture.date)}</Text>
        <View style={styles.durationRow}>
          <Ionicons name="time-outline" size={12} color={colors.textTertiary} />
          <Text style={styles.duration}>{formatDuration(lecture.durationMillis)}</Text>
        </View>
      </View>

      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 68,
  },
  rowCard: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.soft,
  },
  rowFlat: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cardPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.99 }],
  },
  rowPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  meta: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  trailing: {
    alignItems: 'flex-end',
    gap: 3,
  },
  date: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  durationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  duration: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
});

export default LectureListItem;
