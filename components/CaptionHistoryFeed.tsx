import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { colors } from '@/constants/theme';
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
 * CaptionHistoryFeed — the main recording screen's live caption area, enriched
 * with scrollable history rather than only the newest sentence.
 *
 * The current sentence stays the focus at the bottom: English on top (large and
 * bright), its Chinese translation just below. Earlier captions stack in the
 * space above in the same English-then-Chinese order but smaller and fainter, so
 * the screen still reads as one live caption area — not a separate transcript
 * page. The user can scroll up to review earlier content; new captions keep
 * flowing while they are at/near the bottom and stop tugging once they scroll up
 * (no jump-to-latest button). Caption text is selectable, enabling the iOS Copy /
 * Look Up / Translate menu for unfamiliar words.
 *
 * It renders the existing in-memory caption window (bounded upstream), so a long
 * lecture stays performant via FlatList virtualization.
 */
export function CaptionHistoryFeed({
  lines,
  partialEnglish,
  partialTranslationZh,
  translatingPending,
}: CaptionHistoryFeedProps) {
  const listRef = useRef<FlatList<LiveCaptionLine>>(null);
  const [autoFollow, setAutoFollow] = useState(true);

  const hasLive = partialEnglish.trim().length > 0;

  const scrollToLatest = useCallback((animated: boolean) => {
    listRef.current?.scrollToEnd({ animated });
  }, []);

  // Keep the newest caption in view as content arrives — but only while the user
  // is following along at the bottom. If they've scrolled up to read, leave them.
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
      // The newest finalized line is the current caption only when nothing is
      // actively being spoken (otherwise the live footer is the current one).
      const isCurrent = index === lines.length - 1 && !hasLive;
      return (
        <View style={styles.block}>
          <Text selectable style={[styles.en, isCurrent && styles.enCurrent]}>
            {item.text}
          </Text>
          {item.translationZh ? (
            <Text selectable style={[styles.zh, isCurrent && styles.zhCurrent]}>
              {item.translationZh}
            </Text>
          ) : null}
        </View>
      );
    },
    [lines.length, hasLive],
  );

  // The sentence currently being spoken — always the primary focus at the bottom.
  const liveFooter = hasLive ? (
    <View style={styles.block}>
      <Text selectable style={[styles.en, styles.enCurrent]}>
        {partialEnglish}
        <Text style={styles.caret}>│</Text>
      </Text>
      {partialTranslationZh ? (
        <Text selectable style={[styles.zh, styles.zhCurrent]}>
          {partialTranslationZh}
        </Text>
      ) : translatingPending ? (
        <Text style={styles.translating}>Translating…</Text>
      ) : null}
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
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={handleScroll}
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
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    // Anchor to the bottom so the current caption sits low (near the controls)
    // with earlier history filling the space above — the original caption feel.
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 72,
    paddingTop: 24,
    paddingBottom: 20,
    gap: 16,
  },
  block: {
    maxWidth: 900,
    gap: 3,
  },
  // ---- Previous captions: English first, small & faint; Chinese below, fainter.
  en: {
    fontSize: 16,
    lineHeight: 24,
    color: 'rgba(71, 85, 105, 0.55)',
    fontWeight: '500',
  },
  zh: {
    fontSize: 15,
    lineHeight: 23,
    color: 'rgba(71, 85, 105, 0.40)',
    fontWeight: '500',
  },
  // ---- Current caption: English primary (large, bright); Chinese in accent below.
  enCurrent: {
    fontSize: 29,
    lineHeight: 40,
    color: colors.textPrimary,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  zhCurrent: {
    fontSize: 19,
    lineHeight: 29,
    color: colors.accent,
    fontWeight: '600',
  },
  caret: { color: colors.accent, fontWeight: '400' },
  translating: {
    fontSize: 14,
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
});
