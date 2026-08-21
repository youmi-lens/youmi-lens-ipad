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

import { NativeLookupText } from '@/components/NativeLookupText';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors } from '@/constants/theme';
import {
  CAPTION_FOLLOW_MODE,
  CAPTION_SCROLL_ORIGIN,
  followModeAfterScroll,
  historyLineCount,
  shouldRequestCaptionAutoScroll,
} from '@/lib/captionFeed.mjs';
import type { LiveCaptionLine } from '@/lib/liveCaptions';
import { useT } from '@/lib/i18n';

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
 * CaptionHistoryFeed — the main recording screen's live caption area, split into
 * two independent regions:
 *
 *   • a SCROLLABLE history list (top) of earlier finalized captions — English on
 *     top, Chinese below, small and faint; the student can scroll it to review
 *     earlier content, and scrolling it never moves the current caption;
 *   • a FIXED current caption (bottom) — the sentence being spoken now (or the
 *     newest finalized line between sentences) — English on top, Chinese below,
 *     large and dark. It lives OUTSIDE the scroll list, so it stays put and keeps
 *     updating live even while the student scrolls the history above.
 *
 * History auto-follows new lines only while the user is at/near the bottom; once
 * they scroll up it stays where they left it and offers Jump to Latest. English
 * text stays selectable for Copy and supports direct native dictionary lookup.
 */
export function CaptionHistoryFeed({
  lines,
  partialEnglish,
  partialTranslationZh,
  translatingPending,
}: CaptionHistoryFeedProps) {
  const t = useT();
  const isCompact = useIsCompactWidth();
  const listRef = useRef<FlatList<LiveCaptionLine>>(null);
  const [followMode, setFollowMode] = useState<string>(CAPTION_FOLLOW_MODE.FOLLOWING);
  const followModeRef = useRef<string>(followMode);
  const scrollOriginRef = useRef<string>(CAPTION_SCROLL_ORIGIN.NONE);
  const pendingAutoScrollRef = useRef(false);
  const previousUpdateRef = useRef({ lineCount: lines.length, partialEnglish });

  const updateFollowMode = useCallback((next: string) => {
    followModeRef.current = next;
    setFollowMode(next);
  }, []);

  const hasLive = partialEnglish.trim().length > 0;

  // The current caption is rendered as a fixed block, so keep it out of history.
  const historyLines = lines.slice(0, historyLineCount(lines.length, hasLive));
  const currentFinal = !hasLive && lines.length > 0 ? lines[lines.length - 1] : null;

  const currentEnglish = hasLive ? partialEnglish : (currentFinal?.text ?? '');
  const currentZh = hasLive ? partialTranslationZh : (currentFinal?.translatedText ?? currentFinal?.translationZh ?? '');
  const hasCurrent = currentEnglish.trim().length > 0;

  const scrollHistoryToEnd = useCallback((animated: boolean) => {
    scrollOriginRef.current = CAPTION_SCROLL_ORIGIN.PROGRAMMATIC;
    listRef.current?.scrollToEnd({ animated });
  }, []);

  // A caption mutation creates at most one logical request. onContentSizeChange
  // may complete that request after FlatList measures the new row, but never
  // initiates a request of its own.
  useEffect(() => {
    const previous = previousUpdateRef.current;
    const reason = lines.length !== previous.lineCount ? 'final-caption'
      : partialEnglish !== previous.partialEnglish ? 'interim-caption'
      : null;
    previousUpdateRef.current = { lineCount: lines.length, partialEnglish };
    if (!reason || !shouldRequestCaptionAutoScroll({ mode: followModeRef.current, reason })) return;
    pendingAutoScrollRef.current = true;
    const id = requestAnimationFrame(() => {
      scrollHistoryToEnd(true);
      pendingAutoScrollRef.current = false;
    });
    return () => cancelAnimationFrame(id);
  }, [lines.length, partialEnglish, scrollHistoryToEnd]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (scrollOriginRef.current !== CAPTION_SCROLL_ORIGIN.USER) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    updateFollowMode(followModeAfterScroll({
      mode: followModeRef.current,
      origin: scrollOriginRef.current,
      distanceFromBottomPx: distanceFromBottom,
    }));
  }, [updateFollowMode]);

  const beginUserScroll = useCallback(() => {
    scrollOriginRef.current = CAPTION_SCROLL_ORIGIN.USER;
  }, []);

  const endUserScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    handleScroll(event);
    scrollOriginRef.current = CAPTION_SCROLL_ORIGIN.NONE;
  }, [handleScroll]);

  const jumpToLatest = useCallback(() => {
    updateFollowMode(CAPTION_FOLLOW_MODE.FOLLOWING);
    pendingAutoScrollRef.current = true;
    scrollHistoryToEnd(true);
    pendingAutoScrollRef.current = false;
  }, [scrollHistoryToEnd, updateFollowMode]);

  const renderItem = useCallback(({ item }: { item: LiveCaptionLine }) => (
    <View style={styles.historyBlock}>
      <NativeLookupText style={styles.enHistory}>
        {item.text}
      </NativeLookupText>
      {(item.translatedText ?? item.translationZh) ? (
        <Text selectable style={styles.zhHistory}>
          {item.translatedText ?? item.translationZh}
        </Text>
      ) : null}
    </View>
  ), []);

  return (
    <View style={styles.wrap}>
      {/* Scrollable history — previous captions only, never the current one. */}
      <FlatList
        ref={listRef}
        style={styles.historyList}
        data={historyLines}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.historyContent, isCompact && styles.historyContentCompact]}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onScrollBeginDrag={beginUserScroll}
        onScrollEndDrag={endUserScroll}
        onMomentumScrollBegin={beginUserScroll}
        onMomentumScrollEnd={endUserScroll}
        onContentSizeChange={() => {
          if (pendingAutoScrollRef.current) scrollHistoryToEnd(false);
        }}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={11}
      />

      {followMode === CAPTION_FOLLOW_MODE.BROWSING_HISTORY ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Jump to latest caption"
          onPress={jumpToLatest}
          style={({ pressed }) => [styles.jumpToLatest, pressed && styles.jumpToLatestPressed]}
        >
          <Text style={styles.jumpToLatestText}>Jump to Latest</Text>
        </Pressable>
      ) : null}

      {/* Fixed current caption — stays put and updates live while history scrolls. */}
      <View style={[styles.currentBlock, isCompact && styles.currentBlockCompact]}>
        {hasCurrent ? (
          <>
            <NativeLookupText
              style={styles.enCurrent}
              suffix={hasLive ? <Text style={styles.caret}>│</Text> : null}
            >
              {currentEnglish}
            </NativeLookupText>
            {currentZh ? (
              <Text selectable style={styles.zhCurrent}>
                {currentZh}
              </Text>
            ) : translatingPending ? (
              <Text style={styles.translating}>{t('captions.translating')}</Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.listening}>{t('captions.listening')}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minHeight: 0,
  },
  // History fills the space above the fixed current caption and scrolls on its own.
  historyList: {
    flex: 1,
    minHeight: 0,
  },
  historyContent: {
    // Bottom-anchored so the most recent history sits just above the current
    // caption, with older lines and empty space filling upward.
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 72,
    paddingTop: 24,
    paddingBottom: 8,
    gap: 14,
  },
  historyContentCompact: {
    paddingHorizontal: 20,
  },
  historyBlock: {
    maxWidth: 900,
    gap: 2,
  },
  // Previous captions: English first, small & faint; Chinese below, fainter.
  enHistory: {
    fontSize: 16,
    lineHeight: 24,
    color: 'rgba(71, 85, 105, 0.55)',
    fontWeight: '500',
  },
  zhHistory: {
    fontSize: 15,
    lineHeight: 23,
    color: 'rgba(71, 85, 105, 0.40)',
    fontWeight: '500',
  },
  // Fixed current caption: English primary (large, dark); Chinese in accent below.
  currentBlock: {
    maxWidth: 900,
    paddingHorizontal: 72,
    paddingTop: 12,
    paddingBottom: 20,
    gap: 3,
  },
  currentBlockCompact: {
    paddingHorizontal: 20,
  },
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
  },
  jumpToLatest: {
    alignSelf: 'center',
    marginBottom: 4,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: colors.deepNavy,
  },
  jumpToLatestPressed: { opacity: 0.8 },
  jumpToLatestText: { color: colors.pearlWhite, fontSize: 13, fontWeight: '700' },
});
