/**
 * PageIndicatorBadge — the small "current / total" page chip used by the
 * notebook editor and the Course Material PDF screen.
 *
 * Purely presentational: a compact, subtle grey-translucent rounded capsule
 * with white tabular-nums text. Positioning, animated opacity and any tap
 * behaviour are owned by the caller (wrap this in an Animated.View / Pressable).
 * The style is the accepted normal-Notebook page-indicator style, factored out
 * here so the Course Material indicator matches it exactly.
 */
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export function PageIndicatorBadge({
  current,
  total,
  style,
}: {
  current: number;
  total: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.badge, style]}>
      <Text style={styles.badgeText}>
        {current} / {total}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 52,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    // Subtle translucent grey capsule — matches the Notebook page indicator.
    backgroundColor: 'rgba(60,64,72,0.66)',
    shadowColor: 'rgba(8,16,34,0.25)',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.4,
    fontVariant: ['tabular-nums'],
  },
});
