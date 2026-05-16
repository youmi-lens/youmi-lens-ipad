import { StyleSheet, Text, View, ViewStyle } from 'react-native';

import { colors, fontSize, spacing } from '@/constants/theme';

type CaptionCardProps = {
  /** Small label above the caption, e.g. "English Caption" / "中文理解". */
  label: string;
  /** The caption / understanding text itself. */
  text: string;
  /** `en` reads as the primary live caption; `zh` as the translation. */
  language?: 'en' | 'zh';
  /** Render light-on-navy for the mini-caption panel. */
  onNavy?: boolean;
  /** Smaller text — used inside the compact mini-caption panel. */
  compact?: boolean;
  style?: ViewStyle;
};

/**
 * A caption block — a quiet label and large, high-contrast text. Sized to stay
 * legible at classroom distance. This is a presentational block with no card
 * chrome of its own: wrap it in a GlassCard (Focus Recording) or the navy
 * panel (Mini Caption) to compose the surface.
 */
export function CaptionCard({
  label,
  text,
  language = 'en',
  onNavy = false,
  compact = false,
  style,
}: CaptionCardProps) {
  const labelColor = onNavy ? colors.textOnNavyMuted : colors.textTertiary;
  const tickColor =
    language === 'en'
      ? onNavy
        ? colors.iceBlue
        : colors.deepNavy
      : onNavy
        ? colors.textOnNavyMuted
        : colors.mutedBlueGray;
  const textColor = onNavy
    ? language === 'en'
      ? colors.textOnNavy
      : colors.iceBlue
    : language === 'en'
      ? colors.textPrimary
      : colors.secondaryNavy;

  const size = compact ? 18 : fontSize.caption;
  const lineHeight = size * (language === 'zh' ? 1.6 : 1.45);

  return (
    <View style={[styles.block, style]}>
      <View style={styles.labelRow}>
        <View style={[styles.tick, { backgroundColor: tickColor }]} />
        <Text style={[styles.label, { color: labelColor }]}>
          {label.toUpperCase()}
        </Text>
      </View>
      <Text
        style={[
          styles.text,
          { color: textColor, fontSize: size, lineHeight },
          language === 'en' ? styles.textEn : styles.textZh,
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: spacing.md,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  tick: {
    width: 16,
    height: 3,
    borderRadius: 2,
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  text: {
    fontWeight: '500',
  },
  textEn: {
    fontWeight: '600',
  },
  textZh: {
    fontWeight: '500',
  },
});

export default CaptionCard;
