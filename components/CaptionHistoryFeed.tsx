import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { colors, spacing } from '@/constants/theme';
import { isNearBottom } from '@/lib/captionFeed.mjs';
import type { LiveCaptionLine } from '@/lib/liveCaptions';

export type CaptionHistoryFeedProps = {
  /** Finalized caption segments (oldest → newest), each optionally translated. */
  lines: LiveCaptionLine[];
  /** The in-progress English caption for the sentence currently being spoken. */
  partialEnglish: string;
  /** The in-progress Chinese translation for the current sentence, if any. */
  partialTranslationZh: string;
  /** True when the newest finalized line is still awaiting its translation. */
  translatingPending: boolean;
};

/**
 * CaptionHistoryFeed — the main recording screen's scrollable live transcript.
 *
 * Each finalized block shows the Chinese translation (prominent) above the
 * original English (lighter), so the student can review the flow of the lecture,
 * not just the newest sentence. The current sentence renders as a brighter live
 * block pinned at the end. The feed auto-follows new captions while the user is
 * at the bottom; once they scroll up to read earlier content, auto-follow pauses
 * and a "Back to live" control appears. Caption text is selectable, enabling the
 * iOS Copy / Look Up / Translate menu for unfamiliar words (Phase 1 of the
 * vocabulary feature — no storage yet).
 *
 * It only renders the existing in-memory caption window (bounded upstream), so a
 * long lecture stays performant via FlatList virtualization.
 */
export function CaptionHistoryFeed({
  lines,
  partialEnglish,
  partialTranslationZh,
  translatingPending,
}: CaptionHistoryFeedProps) {
  const listRef = useRef<FlatList<LiveCaptionLine>>(null);
  const layoutHeightRef = useRef(0);
  const [autoFollow, setAutoFollow] = useState(true);

  const hasLive = partialEnglish.trim().length > 0;

  const scrollToLatest = useCallback((animated: boolean) => {
    listRef.current?.scrollToEnd({ animated });
  }, []);

  // Stick to the live edge as new captions arrive — but only while following.
  useEffect(() => {
    if (!autoFollow) return;
    const id = requestAnimationFrame(() => scrollToLatest(true));
    return () => cancelAnimationFrame(id);
  }, [autoFollow, lines, partialEnglish, partialTranslationZh, scrollToLatest]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setAutoFollow(isNearBottom(distanceFromBottom));
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: LiveCaptionLine; index: number }) => {
      const isNewestFinal = index === lines.length - 1 && !hasLive;
      return (
        <View style={styles.block}>
          {item.translationZh ? (
            <Text selectable style={[styles.zh, isNewestFinal && styles.zhLatest]}>
              {item.translationZh}
            </Text>
          ) : null}
          <Text
            selectable
            style={[
              styles.en,
              item.translationZh ? styles.enUnderZh : styles.enSolo,
              isNewestFinal && styles.enLatest,
            ]}
          >
            {item.text}
          </Text>
        </View>
      );
    },
    [lines.length, hasLive],
  );

  const liveFooter = hasLive ? (
    <View style={[styles.block, styles.liveBlock]}>
      {partialTranslationZh ? (
        <Text selectable style={[styles.zh, styles.zhLatest]}>
          {partialTranslationZh}
        </Text>
      ) : translatingPending ? (
        <Text style={styles.translating}>Translating…</Text>
      ) : null}
      <Text selectable style={[styles.en, styles.enLatest]}>
        {partialEnglish}
        <Text style={styles.caret}>│</Text>
      </Text>
    </View>
  ) : null;

  return (
    <View style={styles.wrap}>
      <FlatList
        ref={listRef}
        data={lines}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onLayout={(event) => {
          layoutHeightRef.current = event.nativeEvent.layout.height;
        }}
        onContentSizeChange={() => {
          if (autoFollow) scrollToLatest(false);
        }}
        ListFooterComponent={liveFooter}
        ListEmptyComponent={
          hasLive ? null : <Text style={styles.listening}>Listening for speech…</Text>
        }
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={11}
      />
      {!autoFollow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to live"
          onPress={() => {
            setAutoFollow(true);
            scrollToLatest(true);
          }}
          style={({ pressed }) => [styles.backToLive, pressed && styles.backToLivePressed]}
        >
          <Ionicons name="arrow-down" size={15} color={colors.pearlWhite} />
          <Text style={styles.backToLiveText}>Back to live</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 72,
    paddingTop: 24,
    paddingBottom: 20,
    gap: 18,
  },
  block: {
    maxWidth: 900,
    gap: 3,
  },
  liveBlock: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    paddingLeft: 14,
    marginLeft: -17,
  },
  // Chinese translation — prominent and readable (the review-friendly line).
  zh: {
    fontSize: 22,
    lineHeight: 32,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  zhLatest: {
    fontSize: 26,
    lineHeight: 37,
    fontWeight: '700',
  },
  // Original English — lighter and smaller, sitting under the translation.
  en: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  enUnderZh: {
    marginTop: 1,
  },
  enSolo: {
    // A finalized line still awaiting translation: keep English readable on its own.
    fontSize: 18,
    lineHeight: 27,
    color: colors.textSecondary,
  },
  enLatest: {
    fontSize: 18,
    lineHeight: 27,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  caret: { color: colors.accent, fontWeight: '400' },
  translating: {
    fontSize: 13,
    color: colors.textTertiary,
    fontWeight: '600',
  },
  listening: {
    fontSize: 18,
    lineHeight: 27,
    color: colors.textTertiary,
    fontWeight: '500',
    paddingHorizontal: 72,
  },
  backToLive: {
    position: 'absolute',
    bottom: spacing.md,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: colors.accentBright,
  },
  backToLivePressed: { opacity: 0.85 },
  backToLiveText: {
    color: colors.pearlWhite,
    fontSize: 13,
    fontWeight: '700',
  },
});
