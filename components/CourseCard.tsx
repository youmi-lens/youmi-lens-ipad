import { Ionicons } from '@expo/vector-icons';
import { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { GlassCard } from '@/components/GlassCard';
import { IconTile } from '@/components/WorkspaceUI';
import { colors, fontSize, spacing } from '@/constants/theme';
import type { Course } from '@/lib/models';

type IconName = ComponentProps<typeof Ionicons>['name'];

export function CourseCard({
  course,
  lectureCount,
  lastActivity,
  readyCount = 0,
  durationLabel,
  onPress,
}: {
  course: Course;
  lectureCount: number;
  lastActivity?: string;
  readyCount?: number;
  durationLabel?: string;
  onPress?: () => void;
}) {
  return (
    <GlassCard elevated padding={0} onPress={onPress} style={styles.card}>
      <View style={styles.body}>
        <View style={styles.top}>
          <IconTile icon={course.icon as IconName} color={colors.textSecondary} backgroundColor={colors.surfaceMuted} size={44} />
          <Ionicons name="chevron-forward" size={19} color={colors.textTertiary} />
        </View>
        <Text numberOfLines={2} style={styles.name}>{course.name}</Text>
        <Text style={styles.stats}>
          {lectureCount} {lectureCount === 1 ? 'lecture' : 'lectures'}
          {durationLabel ? ` · ${durationLabel}` : ''}
        </Text>
        <View style={styles.divider} />
        <View style={styles.footer}>
          <Text style={styles.last}>{lastActivity ?? 'No lectures yet'}</Text>
          <Text style={styles.ready}>{readyCount} {readyCount === 1 ? 'summary' : 'summaries'} ready</Text>
        </View>
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  card: { minHeight: 210 },
  body: { flex: 1, padding: 20 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { marginTop: spacing.lg, color: colors.ink, fontSize: fontSize.lg, lineHeight: 21, fontWeight: '800' },
  stats: { marginTop: 5, color: colors.textSecondary, fontSize: 12.5 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginTop: 'auto', marginBottom: spacing.md },
  footer: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  last: { flex: 1, color: colors.textTertiary, fontSize: 11.5 },
  ready: { color: colors.accentBright, fontSize: 11.5, fontWeight: '700' },
});

export default CourseCard;
