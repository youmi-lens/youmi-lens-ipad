import { Ionicons } from '@expo/vector-icons';
import { ComponentProps, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { colors, fontSize, radius, spacing } from '@/constants/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

export function PageHeading({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.heading}>
      <View style={styles.headingText}>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.pageTitle}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

export function ProgressBar({ value, style }: { value: number; style?: ViewStyle }) {
  const width = `${Math.max(0, Math.min(1, value)) * 100}%` as `${number}%`;
  return (
    <View style={[styles.progressTrack, style]}>
      <View style={[styles.progressFill, { width }]} />
    </View>
  );
}

export function IconTile({
  icon,
  color = colors.accent,
  backgroundColor = colors.iceTint,
  size = 36,
}: {
  icon: IconName;
  color?: string;
  backgroundColor?: string;
  size?: number;
}) {
  return (
    <View
      style={[
        styles.iconTile,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.25),
          backgroundColor,
        },
      ]}
    >
      <Ionicons name={icon} size={Math.round(size * 0.46)} color={color} />
    </View>
  );
}

export function GlassIconButton({
  icon,
  label,
  onPress,
  style,
}: {
  icon?: IconName;
  label?: string;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, label && styles.iconButtonLabelled, pressed && styles.pressed, style]}
    >
      {icon ? <Ionicons name={icon} size={18} color={colors.ink} /> : null}
      {label ? <Text style={styles.iconButtonText}>{label}</Text> : null}
    </Pressable>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function Pill({
  children,
  accent = false,
}: {
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <View style={[styles.pill, accent && styles.pillAccent]}>
      <Text style={[styles.pillText, accent && styles.pillTextAccent]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.xl,
  },
  headingText: {
    flex: 1,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.54,
    textTransform: 'uppercase',
  },
  pageTitle: {
    marginTop: 5,
    color: colors.ink,
    fontSize: 27,
    lineHeight: 33,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  subtitle: {
    marginTop: 4,
    color: colors.textSecondary,
    fontSize: 13.5,
    lineHeight: 19,
  },
  progressTrack: {
    height: 4,
    borderRadius: 3,
    backgroundColor: 'rgba(15, 23, 42, 0.07)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.accentBright,
  },
  iconTile: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.82)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  iconButtonLabelled: {
    width: 'auto',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: spacing.md,
  },
  iconButtonText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  sectionLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.76)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillAccent: {
    backgroundColor: 'rgba(11, 31, 58, 0.10)',
    borderColor: colors.border,
  },
  pillText: {
    color: colors.textSecondary,
    fontSize: 11.5,
    fontWeight: '600',
  },
  pillTextAccent: {
    color: colors.accent,
  },
  pressed: {
    opacity: 0.78,
    transform: [{ scale: 0.97 }],
  },
});
