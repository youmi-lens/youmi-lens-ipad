import { ReactNode } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { colors, radius, shadows, spacing } from '@/constants/theme';
import { PressableScale } from '@/components/PressableScale';

type GlassCardProps = {
  children: ReactNode;
  /** Inner padding. Defaults to `spacing.xl`. */
  padding?: number;
  /** Navy frosted variant — used for the floating mini-caption panel. */
  navy?: boolean;
  /** Slightly more opaque treatment for hero and featured cards. */
  elevated?: boolean;
  /** Makes the whole card a touch target. */
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * Frosted-glass card built from portable React Native surfaces so it works in
 * development clients without requiring a native blur view implementation.
 */
export function GlassCard({
  children,
  padding = spacing.xl,
  navy = false,
  elevated = false,
  onPress,
  style,
}: GlassCardProps) {
  const cardStyle: ViewStyle = {
    backgroundColor: navy
      ? colors.navySurface
      : elevated
        ? colors.glassElevated
        : colors.glass,
    borderColor: navy ? colors.navyBorder : colors.glassEdge,
  };
  const content = <View style={[styles.inner, { padding }]}>{children}</View>;

  if (onPress) {
    return (
      <PressableScale
        onPress={onPress}
        scaleTo={0.985}
        opacityTo={0.96}
        style={[styles.card, cardStyle, style]}
      >
        {content}
      </PressableScale>
    );
  }

  return <View style={[styles.card, cardStyle, style]}>{content}</View>;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    ...shadows.card,
  },
  inner: {
    borderRadius: radius.xl,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.94,
    transform: [{ scale: 0.992 }],
  },
});

export default GlassCard;
