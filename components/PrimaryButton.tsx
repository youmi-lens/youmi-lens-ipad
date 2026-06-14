import { Ionicons } from '@expo/vector-icons';
import { ComponentProps } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';

import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type PrimaryButtonProps = {
  label: string;
  onPress?: () => void;
  /** Leading icon. */
  icon?: IoniconName;
  /** `lg` is used for the hero "Start Recording" action. */
  size?: 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
};

/**
 * The primary call to action — a solid deep-navy button with a soft lift.
 * Generous height keeps it an easy touch target on iPad.
 */
export function PrimaryButton({
  label,
  onPress,
  icon,
  size = 'md',
  disabled = false,
  loading = false,
  style,
}: PrimaryButtonProps) {
  const isLarge = size === 'lg';
  const isInactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isInactive }}
      onPress={onPress}
      disabled={isInactive}
      style={({ pressed }) => [
        styles.base,
        isLarge ? styles.large : styles.medium,
        isInactive && styles.inactive,
        pressed && !isInactive && styles.pressed,
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator color={colors.textOnNavy} />
        ) : (
          <>
            {icon ? (
              <Ionicons name={icon} size={isLarge ? 24 : 20} color={colors.textOnNavy} />
            ) : null}
            <Text style={[styles.label, isLarge && styles.labelLarge]}>{label}</Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.navy,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.button,
  },
  medium: {
    minHeight: 48,
    paddingHorizontal: spacing.xl,
  },
  large: {
    minHeight: 52,
    paddingHorizontal: spacing.xl,
    borderRadius: 14,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  label: {
    color: colors.textOnNavy,
    fontSize: fontSize.lg,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  labelLarge: {
    fontSize: 15.5,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.9,
    transform: [{ scale: 0.985 }],
  },
  inactive: {
    opacity: 0.45,
  },
});

export default PrimaryButton;
