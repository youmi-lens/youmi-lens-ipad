import { Ionicons } from '@expo/vector-icons';
import { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { colors, fontSize, spacing } from '@/constants/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type SecondaryButtonProps = {
  label: string;
  onPress?: () => void;
  icon?: IoniconName;
  /** `plain` = pearl white, `ice` = soft ice-blue fill. */
  tone?: 'plain' | 'ice';
  /** Tint the label/icon/border red — used for destructive-ish actions. */
  danger?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
};

/**
 * A quieter companion to PrimaryButton: bordered, light-filled, navy text.
 * Used for secondary actions like "Retry" or "Mark Important".
 */
export function SecondaryButton({
  label,
  onPress,
  icon,
  tone = 'plain',
  danger = false,
  disabled = false,
  style,
}: SecondaryButtonProps) {
  const fg = danger ? colors.recordingRed : colors.textPrimary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        tone === 'ice' ? styles.ice : styles.plain,
        danger && styles.danger,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      <View style={styles.content}>
        {icon ? <Ionicons name={icon} size={19} color={fg} /> : null}
        <Text style={[styles.label, { color: fg }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 46,
    paddingHorizontal: spacing.xl,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plain: {
    backgroundColor: 'rgba(255, 255, 255, 0.82)',
    borderColor: colors.border,
  },
  ice: {
    backgroundColor: colors.iceTint,
    borderColor: colors.iceBlue,
  },
  danger: {
    borderColor: 'rgba(194, 65, 75, 0.32)',
    backgroundColor: colors.glassElevated,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  label: {
    fontSize: fontSize.md,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.985 }],
  },
  disabled: {
    opacity: 0.4,
  },
});

export default SecondaryButton;
