import { ReactNode } from 'react';
import { Image, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { colors, fontSize, spacing } from '@/constants/theme';

type LogoMarkProps = {
  size?: number;
  /** Retained for call-site compatibility; the official asset is never recolored. */
  onNavy?: boolean;
};

/** Official Youmi Lens mark, rendered without recoloring or cropping. */
export function LogoMark({ size = 44 }: LogoMarkProps) {
  return (
    <Image
      accessibilityIgnoresInvertColors
      accessibilityLabel="Youmi Lens"
      resizeMode="contain"
      source={require('../assets/images/youmi-lens-mark-navy.png')}
      style={{ width: size * 0.8, height: size }}
    />
  );
}

type BrandHeaderProps = {
  /** Small label under the wordmark, e.g. "for iPad". */
  subtitle?: string;
  /** Optional content pinned to the right (account button, etc.). */
  right?: ReactNode;
  /** Compact variant — smaller mark and wordmark. */
  compact?: boolean;
  /** Render light text for use on a navy surface. */
  onNavy?: boolean;
  style?: ViewStyle;
};

/**
 * Brand lockup: Youmi Lens mark + wordmark, with an optional subtitle and
 * a right-aligned slot. Calm and minimal, in keeping with the brand.
 */
export function BrandHeader({
  subtitle,
  right,
  compact = false,
  onNavy = false,
  style,
}: BrandHeaderProps) {
  const markSize = compact ? 30 : 44;
  const wordColor = onNavy ? colors.textOnNavy : colors.textPrimary;
  const subColor = onNavy ? colors.textOnNavyMuted : colors.textTertiary;

  return (
    <View style={[styles.row, style]}>
      <View style={styles.lockup}>
        <LogoMark size={markSize} onNavy={onNavy} />
        <View style={styles.text}>
          <Text style={[styles.wordmark, { fontSize: compact ? fontSize.lg : fontSize.xl, color: wordColor }]}>
            Youmi <Text style={styles.wordmarkLight}>Lens</Text>
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: subColor }]}>{subtitle}</Text>
          ) : null}
        </View>
      </View>
      {right ? <View>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  lockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  text: {
    justifyContent: 'center',
  },
  wordmark: {
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  wordmarkLight: {
    fontWeight: '500',
    color: colors.textSecondary,
  },
  subtitle: {
    fontSize: fontSize.xs,
    fontWeight: '500',
    marginTop: 1,
    letterSpacing: 0.3,
  },
});

export default BrandHeader;
