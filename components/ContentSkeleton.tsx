import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius } from '@/constants/theme';

/**
 * Content-shaped placeholders.
 *
 * The rule this replaces: a screen that is still loading used to show a
 * centred ActivityIndicator, which reads as "the app has stopped" and forces a
 * jarring layout swap once real content lands. A skeleton the same shape as the
 * incoming content keeps the page structurally stable, so arrival is a fill-in
 * rather than a jump.
 *
 * Deliberately static — no shimmer. A pulsing placeholder on a list of cards is
 * a lot of animated views for no information, and it competes with the content
 * that is about to appear. Stillness reads calmer and costs nothing.
 *
 * These are decorative: they carry no accessibility label and are hidden from
 * VoiceOver, which announces the real content when it arrives.
 */

type BlockProps = {
  width?: number | `${number}%`;
  height?: number;
  style?: StyleProp<ViewStyle>;
};

/** A single neutral block. Compose these into a content-shaped placeholder. */
export function SkeletonBlock({ width = '100%', height = 12, style }: BlockProps) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.block, { width, height }, style]}
    />
  );
}

/**
 * A placeholder shaped like a CourseCard, so the Courses grid keeps its
 * geometry while the store hydrates.
 */
export function CourseCardSkeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.card, style]}
    >
      <SkeletonBlock width={44} height={44} style={styles.avatar} />
      <SkeletonBlock width="72%" height={16} style={styles.gapLg} />
      <SkeletonBlock width="46%" height={12} style={styles.gapSm} />
      <View style={styles.footer}>
        <SkeletonBlock width="34%" height={10} />
        <SkeletonBlock width="24%" height={10} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.sm,
  },
  card: {
    minHeight: 196,
    padding: 18,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.glass,
  },
  avatar: { borderRadius: 14 },
  gapLg: { marginTop: 18 },
  gapSm: { marginTop: 10 },
  footer: {
    marginTop: 'auto',
    paddingTop: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
