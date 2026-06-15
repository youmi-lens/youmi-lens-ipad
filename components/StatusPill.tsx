import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { colors, fontSize, radius, spacing } from '@/constants/theme';

export type StatusVariant =
  | 'recording'
  | 'paused'
  | 'live'
  | 'processing'
  | 'done'
  | 'synced'
  | 'idle';

type VariantStyle = { dot: string; bg: string; fg: string };

const VARIANTS: Record<StatusVariant, VariantStyle> = {
  recording: { dot: colors.recordingRed, bg: colors.recordingTint, fg: '#C0392B' },
  paused: { dot: colors.mutedBlueGray, bg: colors.surfaceMuted, fg: colors.textSecondary },
  live: { dot: colors.success, bg: colors.successTint, fg: '#157A58' },
  processing: { dot: colors.navy, bg: colors.surfaceMuted, fg: colors.textPrimary },
  done: { dot: colors.success, bg: colors.successTint, fg: '#157A58' },
  synced: { dot: colors.success, bg: colors.successTint, fg: '#157A58' },
  idle: { dot: colors.mutedBlueGray, bg: colors.surfaceMuted, fg: colors.textSecondary },
};

type StatusPillProps = {
  label: string;
  variant?: StatusVariant;
  style?: ViewStyle;
};

/**
 * A small status chip: coloured dot + label. The `recording` variant gently
 * pulses its dot so the recording state reads clearly across the room.
 */
export function StatusPill({ label, variant = 'idle', style }: StatusPillProps) {
  const v = VARIANTS[variant];
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (variant !== 'recording') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [variant, pulse]);

  return (
    <View style={[styles.pill, { backgroundColor: v.bg }, style]}>
      <Animated.View
        style={[
          styles.dot,
          { backgroundColor: v.dot },
          variant === 'recording' && { opacity: pulse },
        ]}
      />
      <Text style={[styles.label, { color: v.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});

export default StatusPill;
