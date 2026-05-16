import { Ionicons } from '@expo/vector-icons';
import { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import type { Course } from '@/lib/models';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type CourseCardProps = {
  course: Course;
  /** Number of local lectures recorded for this course. */
  lectureCount: number;
  /** Optional "last activity" label, e.g. the most recent lecture date. */
  lastActivity?: string;
  onPress?: () => void;
};

/**
 * A course tile: a soft course-coloured icon tile, the course name, and a
 * meta line driven by the user's real local lectures.
 */
export function CourseCard({ course, lectureCount, lastActivity, onPress }: CourseCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={[styles.stripe, { backgroundColor: course.accent }]} />

      <View style={styles.body}>
        <View style={[styles.tile, { backgroundColor: course.tint }]}>
          <Ionicons name={course.icon as IoniconName} size={24} color={course.accent} />
        </View>

        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>
            {course.name}
          </Text>
          <View style={styles.metaRow}>
            <Ionicons name="albums-outline" size={13} color={colors.textTertiary} />
            <Text style={styles.meta}>
              {lectureCount} {lectureCount === 1 ? 'lecture' : 'lectures'}
            </Text>
            {lastActivity ? (
              <>
                <View style={styles.metaDot} />
                <Text style={styles.meta}>{lastActivity}</Text>
              </>
            ) : null}
          </View>
        </View>

        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadows.soft,
  },
  pressed: {
    opacity: 0.94,
    transform: [{ scale: 0.99 }],
  },
  stripe: {
    width: 4,
  },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  tile: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: 5,
  },
  name: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  meta: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.textTertiary,
  },
});

export default CourseCard;
