import { ReactNode } from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';

import { colors, fontSize, spacing } from '@/constants/theme';

type LogoMarkProps = {
  size?: number;
  /** Render light-on-navy instead of navy-on-light. */
  onNavy?: boolean;
};

/**
 * The Youmi Lens mark — a rounded navy tile with the stylised "Y" lens glyph.
 * Used inside BrandHeader and anywhere the standalone mark is needed.
 */
export function LogoMark({ size = 44, onNavy = false }: LogoMarkProps) {
  return (
    <View
      style={[
        styles.mark,
        {
          width: size,
          height: size,
          borderRadius: size * 0.3,
          backgroundColor: onNavy ? colors.pearlWhite : colors.deepNavy,
        },
      ]}
    >
      <Text
        style={[
          styles.markGlyph,
          {
            fontSize: size * 0.56,
            color: onNavy ? colors.deepNavy : colors.pearlWhite,
          },
        ]}
      >
        Y
      </Text>
    </View>
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
          <Text
            style={[
              styles.wordmark,
              { fontSize: compact ? fontSize.lg : fontSize.xl, color: wordColor },
            ]}
          >
            Youmi Lens
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
  mark: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  markGlyph: {
    fontWeight: '800',
    letterSpacing: 0.5,
    includeFontPadding: false,
    marginTop: -2,
  },
  text: {
    justifyContent: 'center',
  },
  wordmark: {
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  subtitle: {
    fontSize: fontSize.xs,
    fontWeight: '500',
    marginTop: 1,
    letterSpacing: 0.3,
  },
});

export default BrandHeader;
