import { ReactNode } from 'react';
import { Pressable, StyleSheet, View, ViewStyle } from 'react-native';

import { colors, radius, shadows, spacing } from '@/constants/theme';

type GlassCardProps = {
  children: ReactNode;
  /** Inner padding. Defaults to `spacing.xl`. */
  padding?: number;
  /** Navy frosted variant — used for the floating mini-caption panel. */
  navy?: boolean;
  /** Makes the whole card a touch target. */
  onPress?: () => void;
  style?: ViewStyle;
};

/**
 * Frosted-glass card: translucent surface, thin border, soft shadow and
 * rounded corners. A real blur can later be layered in with `expo-blur`;
 * this skeleton uses a translucent fill to keep dependencies minimal.
 */
export function GlassCard({ children, padding = spacing.xl, navy = false, onPress, style }: GlassCardProps) {
  const cardStyle: ViewStyle = {
    backgroundColor: navy ? colors.navySurface : colors.glass,
    borderColor: navy ? colors.navyBorder : colors.glassEdge,
    padding,
  };

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.card,
          cardStyle,
          pressed && styles.pressed,
          style,
        ]}
      >
        {children}
      </Pressable>
    );
  }

  return <View style={[styles.card, cardStyle, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    ...shadows.card,
  },
  pressed: {
    opacity: 0.94,
    transform: [{ scale: 0.992 }],
  },
});

export default GlassCard;
