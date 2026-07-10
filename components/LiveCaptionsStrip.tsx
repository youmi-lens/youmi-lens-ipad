/**
 * LiveCaptionsStrip — a small floating caption surface that piggybacks on
 * the existing LiveCaptionsProvider (lib/liveCaptions.tsx). Designed for
 * screens like the Material reader where the student is doing something
 * else and just wants to see the latest captions without leaving the page.
 *
 * Returns null when no live caption session is active, so the screen using
 * it doesn't need to gate on status itself.
 *
 * V1.1 keeps this minimal: a bottom-anchored strip with a REC dot, a single
 * caption line, and a chevron to collapse to a small pill. No Pencil
 * gestures (those are reserved for drawing) — only single-finger taps.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { useLiveCaptions } from '@/lib/liveCaptions';

export function LiveCaptionsStrip() {
  const {
    status,
    latestCaption,
    partialCaption,
    latestFinalLine,
    error,
  } = useLiveCaptions();

  const [collapsed, setCollapsed] = useState(false);
  const active = status === 'active' || status === 'listening';
  const connecting = status === 'connecting';
  const showStrip = active || connecting || status === 'error';

  // Auto-expand when a new caption arrives — students wouldn't expect a
  // collapsed pill to silently miss live content. Tracks the last seen line.
  const [lastSeenLineId, setLastSeenLineId] = useState<string | null>(null);
  useEffect(() => {
    if (latestFinalLine && latestFinalLine.id !== lastSeenLineId) {
      setLastSeenLineId(latestFinalLine.id);
      setCollapsed(false);
    }
  }, [latestFinalLine, lastSeenLineId]);

  if (!showStrip) return null;

  // Caption-line resolution order: final → partial → fallback hint.
  const captionText = (latestCaption || partialCaption || '').trim();
  const fallback =
    status === 'connecting'
      ? 'Connecting live captions…'
      : status === 'error'
        ? error ?? 'Live captions unavailable.'
        : active && !captionText
          ? 'Listening…'
          : '';
  const displayText = captionText || fallback;

  if (collapsed) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Expand live captions"
        onPress={() => setCollapsed(false)}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
      >
        <View style={[styles.dot, status === 'error' && styles.dotError]} />
        <Text style={styles.pillLabel}>LIVE</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.strip} accessibilityRole="summary">
      <View style={styles.statusBlock}>
        <View style={[styles.dot, status === 'error' && styles.dotError]} />
        <Text style={styles.statusLabel}>
          {status === 'error' ? 'CAPTIONS ERROR' : connecting ? 'CONNECTING' : 'LIVE'}
        </Text>
      </View>
      <Text selectable style={styles.captionText} numberOfLines={2}>
        {displayText}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Collapse live captions"
        hitSlop={10}
        onPress={() => setCollapsed(true)}
        style={({ pressed }) => [styles.collapseButton, pressed && styles.pressed]}
      >
        <Ionicons name="chevron-down" size={18} color={colors.deepNavy} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.soft,
  },
  statusBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.recordingRed,
  },
  dotError: {
    backgroundColor: colors.textTertiary,
  },
  statusLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    color: colors.deepNavy,
  },
  captionText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.45,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  collapseButton: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'flex-end',
    ...shadows.soft,
  },
  pillLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    color: colors.deepNavy,
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
});
