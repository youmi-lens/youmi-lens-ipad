import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NativeLookupText } from '@/components/NativeLookupText';
import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { formatClock } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useLiveCaptions } from '@/lib/liveCaptions';
import { useRecordingNotes } from '@/lib/recordingNotes';

const DEFAULT_PANEL_WIDTH = 340;
const DEFAULT_PANEL_HEIGHT = 240;
const MIN_PANEL_WIDTH = 190;
const MIN_PANEL_HEIGHT = 105;
const EDGE_MARGIN = 10;
const LISTENING_PILL_WIDTH = 176;
const LISTENING_PILL_HEIGHT = 42;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export type FloatingMiniCaptionProps = {
  /** Lifts the default panel position below screen chrome such as headers. */
  topOffset?: number;
  /** If false, the component renders nothing. */
  enabled?: boolean;
};

/**
 * FloatingMiniCaption — the shared Youmi Lens live-caption popup style.
 *
 * It consumes the existing LiveCaptionsProvider + RecordingNotesProvider only;
 * it never starts a new mic stream, recorder, WebSocket, or transcript engine.
 * The panel is draggable/resizable and floats over the current workspace.
 */
export function FloatingMiniCaption({ topOffset = 76, enabled = true }: FloatingMiniCaptionProps) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const {
    status,
    latestCaption,
    partialCaption,
    partialTranslationZh,
    latestFinalLine,
    captionLines,
  } = useLiveCaptions();
  const { currentDurationMillis, isLectureSessionPaused, toggleLectureSessionPause, addMarkMillis } =
    useRecordingNotes();

  const [panelVisible, setPanelVisible] = useState(true);
  const [markFlash, setMarkFlash] = useState(false);
  const panelPaused = isLectureSessionPaused;
  const [autoFollowFeed, setAutoFollowFeed] = useState(true);
  const [panelSize, setPanelSize] = useState({ width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT });

  const initial = useRef({
    x: Math.max(EDGE_MARGIN, width - DEFAULT_PANEL_WIDTH - 16),
    y: insets.top + topOffset,
  });
  const pan = useRef(new Animated.ValueXY(initial.current)).current;
  const posRef = useRef({ ...initial.current });
  const dragStart = useRef({ x: 0, y: 0 });
  const panelSizeRef = useRef(panelSize);
  panelSizeRef.current = panelSize;
  const resizeStartSizeRef = useRef(panelSize);
  const isResizingRef = useRef(false);
  // Ghost-preview resize architecture — mirrors app/mini-caption.tsx exactly
  // (the owner-approved Notes Caption resize behavior). Real width/height
  // changing on every drag frame forces a native layout pass of the whole
  // caption subtree (Yoga layout properties can't use the native driver, and
  // NativeLookupText renders one nested Text per English word) — that's what
  // made resize feel heavy before. During an active drag only this
  // content-free ghost box tracks the finger; the real panel stays frozen at
  // its committed `panelSize` and gets exactly one real layout pass, on
  // release.
  const resizeLiveSizeRef = useRef(panelSize);
  const panelSizeAnim = useRef(new Animated.ValueXY({ x: panelSize.width, y: panelSize.height })).current;
  useEffect(() => {
    if (isResizingRef.current) return;
    panelSizeAnim.setValue({ x: panelSize.width, y: panelSize.height });
  }, [panelSize, panelSizeAnim]);
  const [isResizeGhostVisible, setIsResizeGhostVisible] = useState(false);
  const feedScrollRef = useRef<ScrollView | null>(null);
  const feedMetricsRef = useRef({ contentHeight: 0, layoutHeight: 0 });
  const feedUserScrollingRef = useRef(false);
  const feedAutoScrollPendingRef = useRef(false);

  const initialListeningPill = useRef({
    x: Math.max(EDGE_MARGIN, width - LISTENING_PILL_WIDTH - 16),
    y: Math.max(EDGE_MARGIN, height - LISTENING_PILL_HEIGHT - 24),
  });
  const listeningPillPan = useRef(new Animated.ValueXY(initialListeningPill.current)).current;
  const listeningPillPosRef = useRef({ ...initialListeningPill.current });
  const listeningPillDragStart = useRef({ x: 0, y: 0 });
  const listeningPillWasDraggedRef = useRef(false);

  useEffect(() => {
    if (!markFlash) return;
    const id = setTimeout(() => setMarkFlash(false), 900);
    return () => clearTimeout(id);
  }, [markFlash]);

  const dragResponder = useMemo(() => {
    const settle = (dx: number, dy: number) => {
      const maxX = Math.max(EDGE_MARGIN, width - panelSizeRef.current.width - EDGE_MARGIN);
      const maxY = Math.max(EDGE_MARGIN, height - panelSizeRef.current.height - EDGE_MARGIN);
      const next = {
        x: Math.min(Math.max(dragStart.current.x + dx, EDGE_MARGIN), maxX),
        y: Math.min(Math.max(dragStart.current.y + dy, EDGE_MARGIN), maxY),
      };
      posRef.current = next;
      Animated.spring(pan, { toValue: next, useNativeDriver: true, friction: 9, tension: 80 }).start();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) =>
        !isResizingRef.current && (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4),
      onPanResponderGrant: () => {
        dragStart.current = { ...posRef.current };
      },
      onPanResponderMove: (_e, g) => {
        pan.setValue({ x: dragStart.current.x + g.dx, y: dragStart.current.y + g.dy });
      },
      onPanResponderRelease: (_e, g) => settle(g.dx, g.dy),
      onPanResponderTerminate: (_e, g) => settle(g.dx, g.dy),
    });
  }, [height, pan, width]);

  const resizeResponder = useMemo(() => {
    const maxWidth = Math.max(MIN_PANEL_WIDTH, width * 0.96);
    const maxHeight = Math.max(MIN_PANEL_HEIGHT, height * 0.88);
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        isResizingRef.current = true;
        resizeStartSizeRef.current = panelSizeRef.current;
        resizeLiveSizeRef.current = panelSizeRef.current;
        panelSizeAnim.setValue({ x: resizeStartSizeRef.current.width, y: resizeStartSizeRef.current.height });
        setIsResizeGhostVisible(true);
      },
      // High-frequency path — deliberately does NOT call setPanelSize (React
      // state) and does NOT touch the real panel's width/height at all; only
      // panelSizeAnim, which drives the content-free ghost preview. See the
      // ghost-preview comment above.
      onPanResponderMove: (_e, g) => {
        const next = {
          width: Math.min(Math.max(resizeStartSizeRef.current.width + g.dx, MIN_PANEL_WIDTH), maxWidth),
          height: Math.min(Math.max(resizeStartSizeRef.current.height + g.dy, MIN_PANEL_HEIGHT), maxHeight),
        };
        resizeLiveSizeRef.current = next;
        panelSizeAnim.setValue({ x: next.width, y: next.height });
      },
      onPanResponderRelease: () => {
        isResizingRef.current = false;
        const finalSize = resizeLiveSizeRef.current;
        setPanelSize(finalSize);
        setIsResizeGhostVisible(false);
        const maxX = Math.max(EDGE_MARGIN, width - finalSize.width - EDGE_MARGIN);
        const maxY = Math.max(EDGE_MARGIN, height - finalSize.height - EDGE_MARGIN);
        const nextPos = { x: Math.min(posRef.current.x, maxX), y: Math.min(posRef.current.y, maxY) };
        posRef.current = nextPos;
        Animated.spring(pan, { toValue: nextPos, useNativeDriver: true, friction: 9, tension: 80 }).start();
      },
      onPanResponderTerminate: () => {
        isResizingRef.current = false;
        setIsResizeGhostVisible(false);
        panelSizeAnim.setValue({ x: panelSizeRef.current.width, y: panelSizeRef.current.height });
      },
    });
  }, [height, pan, panelSizeAnim, width]);

  const listeningPillResponder = useMemo(() => {
    const settle = (dx: number, dy: number) => {
      const maxX = Math.max(EDGE_MARGIN, width - LISTENING_PILL_WIDTH - EDGE_MARGIN);
      const maxY = Math.max(EDGE_MARGIN, height - LISTENING_PILL_HEIGHT - EDGE_MARGIN);
      const next = {
        x: Math.min(Math.max(listeningPillDragStart.current.x + dx, EDGE_MARGIN), maxX),
        y: Math.min(Math.max(listeningPillDragStart.current.y + dy, EDGE_MARGIN), maxY),
      };
      listeningPillPosRef.current = next;
      Animated.spring(listeningPillPan, { toValue: next, useNativeDriver: true, friction: 9, tension: 80 }).start();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5,
      onPanResponderGrant: () => {
        listeningPillWasDraggedRef.current = true;
        listeningPillDragStart.current = { ...listeningPillPosRef.current };
      },
      onPanResponderMove: (_e, g) => {
        listeningPillPan.setValue({
          x: listeningPillDragStart.current.x + g.dx,
          y: listeningPillDragStart.current.y + g.dy,
        });
      },
      onPanResponderRelease: (_e, g) => {
        settle(g.dx, g.dy);
        setTimeout(() => {
          listeningPillWasDraggedRef.current = false;
        }, 120);
      },
      onPanResponderTerminate: (_e, g) => {
        settle(g.dx, g.dy);
        setTimeout(() => {
          listeningPillWasDraggedRef.current = false;
        }, 120);
      },
    });
  }, [height, listeningPillPan, width]);

  const captionsLive = status === 'active' || status === 'listening';
  const latestFinalEnglish = latestFinalLine?.text ?? captionLines[captionLines.length - 1]?.text ?? '';
  const visibleEnglishCaption = partialCaption || latestFinalEnglish || latestCaption;
  const captionLine = captionsLive
    ? visibleEnglishCaption || t('mini.listeningStatus')
    : status === 'connecting'
      ? t('mini.connecting')
      : visibleEnglishCaption
        ? visibleEnglishCaption
        : status === 'error'
          ? t('mini.unavailable')
          : t('mini.listeningStatus');
  const translationLine = partialTranslationZh || latestFinalLine?.translatedText || latestFinalLine?.translationZh;
  const translationPending = Boolean(latestFinalLine && !translationLine && !partialCaption);
  const seconds = Math.floor(Math.max(0, currentDurationMillis) / 1000);

  const panelScale = clamp(
    Math.min(panelSize.width / DEFAULT_PANEL_WIDTH, panelSize.height / DEFAULT_PANEL_HEIGHT),
    0.75,
    1.8,
  );
  const panelCompact = panelScale < 0.9;
  const panelMedium = panelScale >= 0.9 && panelScale < 1.15;
  const scaled = {
    panelPaddingX: Math.round(12 * panelScale),
    panelPaddingTop: Math.round(8 * panelScale),
    panelPaddingBottom: Math.round(12 * panelScale),
    panelGap: Math.round(8 * panelScale),
    panelRadius: Math.round(14 * panelScale),
    timer: Math.round(18 * panelScale),
    pausedLabel: Math.max(9, Math.round(10 * panelScale)),
    english: Math.round(17 * panelScale),
    chinese: Math.round(13 * panelScale),
    icon: Math.round(15 * panelScale),
    controlIcon: Math.round(17 * panelScale),
    close: Math.round(16 * panelScale),
    controlHeight: Math.round(42 * panelScale),
    controlGap: Math.round(6 * panelScale),
    controlLabel: Math.max(11, Math.round(12 * panelScale)),
    rowPaddingX: Math.round(10 * panelScale),
    rowPaddingY: Math.round(7 * panelScale),
    resizeVisual: Math.round(20 * panelScale),
    gripWidth: Math.round(34 * panelScale),
    gripHeight: Math.max(3, Math.round(4 * panelScale)),
    statusDot: Math.max(8, Math.round(9 * panelScale)),
  };
  const reservedResizeLaneHeight = 56;
  const reservedFooterHeight = scaled.controlHeight + reservedResizeLaneHeight + scaled.panelGap;
  const estimatedHeaderHeight = Math.max(scaled.timer, scaled.close) + scaled.gripHeight + scaled.panelGap * 2;
  const availableCaptionHeight = Math.max(
    0,
    panelSize.height - scaled.panelPaddingTop - scaled.panelPaddingBottom - estimatedHeaderHeight - reservedFooterHeight,
  );
  const panelArea = panelSize.width * panelSize.height;
  const showCaptionFeed =
    (panelSize.width >= 320 && panelSize.height >= 300 && availableCaptionHeight >= 140) ||
    (panelArea >= 150_000 && panelSize.width >= 300 && availableCaptionHeight >= 150);
  const panelIsTall = panelSize.height / panelSize.width >= 1.05 && availableCaptionHeight >= 120;
  const heightBoost = clamp(panelSize.height / DEFAULT_PANEL_HEIGHT, 1, 1.45);
  const latestOnlyBaseScale = showCaptionFeed
    ? panelScale
    : clamp(panelScale * (panelIsTall ? heightBoost : 1), 0.8, 1.35);
  const compactHeightScale = availableCaptionHeight < 92 ? 0.82 : availableCaptionHeight < 120 ? 0.9 : 1;
  const latestOnlyCaptionScale = showCaptionFeed
    ? panelScale
    : clamp(latestOnlyBaseScale * compactHeightScale, 0.78, 1.35);
  const latestOnlyEnglishSize = Math.round(17 * latestOnlyCaptionScale);
  const latestOnlyChineseSize = Math.round(13 * latestOnlyCaptionScale);
  const latestOnlyEnglishLines = availableCaptionHeight < 64 ? 1 : 2;
  const latestOnlyChineseLines =
    availableCaptionHeight < 78 ? 0 : availableCaptionHeight < 128 ? 1 : panelMedium ? 1 : 2;
  const showLatestOnlyChinese = latestOnlyChineseLines > 0;
  const currentActiveEnglish = visibleEnglishCaption.trim();
  const finalizedFeedLines = captionLines.filter((line, index) => {
    if (!currentActiveEnglish) return true;
    const isLatest = index === captionLines.length - 1;
    return !(isLatest && line.text.trim() === currentActiveEnglish);
  });
  const activeFeedLine = currentActiveEnglish
    ? {
        id: partialCaption ? 'active_interim' : latestFinalLine?.id ?? 'active_current',
        text: currentActiveEnglish,
        translatedText: translationLine,
        translationZh: translationLine,
        isActive: true,
      }
    : null;
  const feedLines = [
    ...finalizedFeedLines.map((line) => ({
      id: line.id,
      text: line.text,
      translatedText: line.translatedText ?? line.translationZh,
      translationZh: line.translationZh,
      isActive: false,
    })),
    ...(activeFeedLine ? [activeFeedLine] : []),
  ];
  const hasAnyCaption = Boolean(visibleEnglishCaption || translationLine);

  useEffect(() => {
    if (!showCaptionFeed) {
      setAutoFollowFeed(true);
      return;
    }
    if (!autoFollowFeed) return;
    feedAutoScrollPendingRef.current = true;
    const id = requestAnimationFrame(() => {
      feedScrollRef.current?.scrollToEnd({ animated: true });
      feedAutoScrollPendingRef.current = false;
    });
    return () => {
      cancelAnimationFrame(id);
      feedAutoScrollPendingRef.current = false;
    };
  }, [autoFollowFeed, showCaptionFeed, captionLines.length, partialCaption]);

  const updateAutoFollowFromScroll = (scrollY: number) => {
    const { contentHeight, layoutHeight } = feedMetricsRef.current;
    const distanceFromBottom = contentHeight - layoutHeight - scrollY;
    setAutoFollowFeed(distanceFromBottom < 72);
  };

  const markImportant = () => {
    addMarkMillis(currentDurationMillis);
    setMarkFlash(true);
  };

  // `enabled` (caller-controlled — see FloatingMiniCaptionProps) is the sole
  // mount gate. It must reflect whether a classroom recording session is
  // active, not the live-caption provider's own network/API status — a
  // backend outage (e.g. no ASR key configured) must not make this panel
  // disappear while a lecture is still being recorded. Once mounted, the
  // caption text/translation rendering below already degrades gracefully on
  // its own (connecting / listening / unavailable copy) — it never needed a
  // second full-panel gate on top of `enabled`.
  if (!enabled) return null;

  if (!panelVisible) {
    return (
      <Animated.View
        style={[styles.listeningPillWrap, { transform: listeningPillPan.getTranslateTransform() }]}
        {...listeningPillResponder.panHandlers}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mini.showCaptions')}
          onPress={() => {
            if (listeningPillWasDraggedRef.current) return;
            setPanelVisible(true);
          }}
          style={({ pressed }) => [styles.listeningPill, pressed && styles.pressed]}
        >
          <View style={styles.listeningDot} />
          <Text style={styles.listeningPillLabel}>{t('mini.listening')}</Text>
          <Ionicons name="chevron-up" size={15} color={colors.textOnNavyMuted} />
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <>
    <Animated.View
      style={[
        styles.panel,
        {
          width: panelSize.width,
          height: panelSize.height,
          borderRadius: scaled.panelRadius,
          paddingHorizontal: scaled.panelPaddingX,
          paddingTop: scaled.panelPaddingTop,
          paddingBottom: scaled.panelPaddingBottom,
          gap: scaled.panelGap,
          transform: pan.getTranslateTransform(),
        },
      ]}
    >
      {/* Drag zone: the header (grip + status row) is the ONLY area that moves
          the panel. Attaching the drag PanResponder here — instead of the whole
          panel — lets vertical swipes inside the caption ScrollView scroll the
          subtitle history instead of dragging the popup. */}
      <View style={{ gap: scaled.panelGap }} {...dragResponder.panHandlers}>
      <View
        style={[
          styles.grip,
          { width: scaled.gripWidth, height: scaled.gripHeight, borderRadius: scaled.gripHeight / 2 },
        ]}
      />

      <View style={[styles.statusRow, { gap: Math.max(6, Math.round(8 * panelScale)) }]}>
        <View
          style={[
            styles.recDot,
            { width: scaled.statusDot, height: scaled.statusDot, borderRadius: scaled.statusDot / 2 },
            panelPaused && styles.recDotPaused,
          ]}
        />
        <Text style={[styles.timer, { fontSize: scaled.timer }]}>{formatClock(seconds)}</Text>
        {panelPaused ? <Text style={[styles.pausedLabel, { fontSize: scaled.pausedLabel }]}>{t('mini.paused')}</Text> : null}
        <View style={styles.spacer} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mini.hideCaptions')}
          onPress={() => setPanelVisible(false)}
          hitSlop={8}
          style={({ pressed }) => [
            styles.closeBtn,
            {
              width: Math.round(26 * panelScale),
              height: Math.round(26 * panelScale),
              borderRadius: Math.round(13 * panelScale),
            },
            pressed && styles.pressed,
          ]}
        >
          <Ionicons name="close" size={scaled.close} color={colors.textOnNavyMuted} />
        </Pressable>
      </View>
      </View>

      <View
        style={[
          styles.captionBlock,
          styles.captionArea,
          !panelCompact && styles.captionBlockFlexible,
          !showCaptionFeed && styles.latestOnlyCaptionArea,
          !showCaptionFeed && { maxHeight: availableCaptionHeight },
          !showCaptionFeed && panelIsTall && styles.latestOnlyCaptionAreaTall,
          !hasAnyCaption && styles.captionBlockEmpty,
        ]}
      >
        {showCaptionFeed ? (
          <ScrollView
            ref={feedScrollRef}
            style={styles.feedScroll}
            contentContainerStyle={[styles.feedContent, { gap: Math.max(8, Math.round(10 * panelScale)) }]}
            showsVerticalScrollIndicator={false}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            scrollEnabled
            scrollEventThrottle={16}
            onLayout={(event) => {
              feedMetricsRef.current.layoutHeight = event.nativeEvent.layout.height;
            }}
            onScroll={(event) => {
              if (feedUserScrollingRef.current) updateAutoFollowFromScroll(event.nativeEvent.contentOffset.y);
            }}
            onScrollBeginDrag={() => { feedUserScrollingRef.current = true; }}
            onScrollEndDrag={(event) => {
              updateAutoFollowFromScroll(event.nativeEvent.contentOffset.y);
              feedUserScrollingRef.current = false;
            }}
            onMomentumScrollBegin={() => { feedUserScrollingRef.current = true; }}
            onMomentumScrollEnd={(event) => {
              updateAutoFollowFromScroll(event.nativeEvent.contentOffset.y);
              feedUserScrollingRef.current = false;
            }}
            onContentSizeChange={(_width, contentHeight) => {
              feedMetricsRef.current.contentHeight = contentHeight;
              if (feedAutoScrollPendingRef.current) feedScrollRef.current?.scrollToEnd({ animated: false });
            }}
          >
            {feedLines.length > 0 ? (
              feedLines.map((line) => (
                <View
                  key={line.id}
                  style={[
                    styles.feedLine,
                    line.isActive && styles.feedLineActive,
                    {
                      borderRadius: Math.round(8 * panelScale),
                      paddingHorizontal: scaled.rowPaddingX,
                      paddingVertical: scaled.rowPaddingY,
                    },
                  ]}
                >
                  <NativeLookupText
                    style={[
                      styles.captionText,
                      styles.feedEnglish,
                      { fontSize: scaled.english, lineHeight: Math.round(scaled.english * 1.4) },
                    ]}
                  >
                    {line.text}
                  </NativeLookupText>
                  {(line.translatedText ?? line.translationZh) ? (
                    <Text
                      style={[
                        styles.captionTranslation,
                        styles.feedChinese,
                        { fontSize: scaled.chinese, lineHeight: Math.round(scaled.chinese * 1.5) },
                      ]}
                    >
                      {line.translatedText ?? line.translationZh}
                    </Text>
                  ) : line.isActive && translationPending ? (
                    <Text style={[styles.captionTranslationPending, { fontSize: scaled.chinese }]}>{t('mini.translating')}</Text>
                  ) : null}
                </View>
              ))
            ) : (
              <CaptionFallbackRow
                captionsLive={captionsLive}
                captionLine={captionLine}
                iconSize={scaled.icon}
                englishSize={scaled.english}
                gap={Math.max(6, Math.round(6 * panelScale))}
                paddingX={scaled.rowPaddingX}
                paddingY={scaled.rowPaddingY}
                radiusValue={Math.round(8 * panelScale)}
              />
            )}
          </ScrollView>
        ) : (
          <View
            style={[
              styles.latestOnlyCaptionBlock,
              panelIsTall && styles.latestOnlyCaptionBlockTall,
              {
                gap: Math.max(4, Math.round(6 * latestOnlyCaptionScale)),
                borderRadius: Math.round(10 * latestOnlyCaptionScale),
                paddingVertical: panelIsTall ? Math.round(14 * latestOnlyCaptionScale) : 0,
              },
            ]}
          >
            <CaptionFallbackRow
              captionsLive={captionsLive}
              captionLine={captionLine}
              iconSize={scaled.icon}
              englishSize={latestOnlyEnglishSize}
              englishLines={latestOnlyEnglishLines}
              gap={Math.max(6, Math.round(6 * latestOnlyCaptionScale))}
              paddingX={Math.round(10 * latestOnlyCaptionScale)}
              paddingY={Math.round(7 * latestOnlyCaptionScale)}
              radiusValue={Math.round(8 * latestOnlyCaptionScale)}
            />
            {showLatestOnlyChinese && translationLine ? (
              <Text
                style={[
                  styles.captionTranslation,
                  {
                    paddingHorizontal: Math.round(10 * latestOnlyCaptionScale),
                    fontSize: latestOnlyChineseSize,
                    lineHeight: Math.round(latestOnlyChineseSize * 1.5),
                  },
                ]}
                numberOfLines={latestOnlyChineseLines}
                ellipsizeMode="tail"
              >
                {translationLine}
              </Text>
            ) : showLatestOnlyChinese && translationPending ? (
              <Text
                style={[
                  styles.captionTranslationPending,
                  { paddingHorizontal: Math.round(10 * latestOnlyCaptionScale), fontSize: latestOnlyChineseSize },
                ]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {t('mini.translating')}
              </Text>
            ) : null}
          </View>
        )}
      </View>

      <View style={styles.panelFooter}>
        <View style={[styles.controls, { gap: scaled.controlGap }]}> 
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mini.markImportant')}
            onPress={markImportant}
            style={({ pressed }) => [
              styles.controlBtn,
              { height: scaled.controlHeight, borderRadius: Math.round(8 * panelScale), gap: scaled.controlGap },
              markFlash && styles.controlBtnActive,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name={markFlash ? 'star' : 'star-outline'}
              size={scaled.controlIcon}
              color={markFlash ? colors.deepNavy : colors.textOnNavy}
            />
            {!panelCompact ? (
              <Text style={[styles.controlLabel, { fontSize: scaled.controlLabel }, markFlash && styles.controlLabelActive]}>
                {markFlash ? t('mini.marked') : t('mini.mark')}
              </Text>
            ) : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mini.expandPanel')}
            onPress={() =>
              setPanelSize((current) => {
                const maxWidth = Math.max(MIN_PANEL_WIDTH, width * 0.96);
                const maxHeight = Math.max(MIN_PANEL_HEIGHT, height * 0.88);
                const alreadyLarge = current.width >= maxWidth * 0.72 && current.height >= maxHeight * 0.72;
                return alreadyLarge
                  ? { width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT }
                  : { width: Math.round(maxWidth * 0.72), height: Math.round(maxHeight * 0.72) };
              })
            }
            style={({ pressed }) => [
              styles.controlBtn,
              { height: scaled.controlHeight, borderRadius: Math.round(8 * panelScale), gap: scaled.controlGap },
              pressed && styles.pressed,
            ]}
          >
            <Ionicons name="scan-outline" size={scaled.controlIcon} color={colors.textOnNavy} />
            {!panelCompact ? <Text style={[styles.controlLabel, { fontSize: scaled.controlLabel }]}>{t('mini.expand')}</Text> : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={panelPaused ? t('mini.resume') : t('mini.pause')}
            onPress={() => {
              void toggleLectureSessionPause();
            }}
            style={({ pressed }) => [
              styles.controlBtn,
              { height: scaled.controlHeight, borderRadius: Math.round(8 * panelScale), gap: scaled.controlGap },
              pressed && styles.pressed,
            ]}
          >
            <Ionicons name={panelPaused ? 'play' : 'pause'} size={scaled.controlIcon} color={colors.textOnNavy} />
            {!panelCompact ? (
              <Text style={[styles.controlLabel, { fontSize: scaled.controlLabel }]}>{panelPaused ? t('mini.resume') : t('mini.pause')}</Text>
            ) : null}
          </Pressable>
        </View>
        <View style={styles.resizeLane}>
          <View style={styles.resizeHandle} {...resizeResponder.panHandlers}>
            <Ionicons name="resize-outline" size={scaled.resizeVisual} color={colors.textOnNavyMuted} />
          </View>
        </View>
      </View>
    </Animated.View>

    {/* Resize preview — a content-free ghost outline shown only while
        actively dragging the resize handle. Same architecture as
        app/mini-caption.tsx: split into two nested Animated.Views because
        `pan`'s native-driven transform must not share a style array with
        panelSizeAnim's width/height (not native-driver-eligible — RN throws
        "Style property 'width'/'height' is not supported by native animated
        module" if they're mixed on one view). */}
    {isResizeGhostVisible ? (
      <Animated.View
        pointerEvents="none"
        style={[
          styles.resizeGhostPositioner,
          { transform: pan.getTranslateTransform() },
        ]}
      >
        <Animated.View
          style={[
            styles.resizeGhost,
            {
              width: panelSizeAnim.x,
              height: panelSizeAnim.y,
              borderRadius: scaled.panelRadius,
            },
          ]}
        />
      </Animated.View>
    ) : null}
    </>
  );
}

function CaptionFallbackRow({
  captionsLive,
  captionLine,
  iconSize,
  englishSize,
  englishLines,
  gap,
  paddingX,
  paddingY,
  radiusValue,
}: {
  captionsLive: boolean;
  captionLine: string;
  iconSize: number;
  englishSize: number;
  englishLines?: number;
  gap: number;
  paddingX: number;
  paddingY: number;
  radiusValue: number;
}) {
  return (
    <View style={[styles.captionRow, { gap, borderRadius: radiusValue, paddingHorizontal: paddingX, paddingVertical: paddingY }]}> 
      <Ionicons
        name={captionsLive ? 'chatbubble-ellipses' : 'information-circle-outline'}
        size={iconSize}
        color={colors.iceBlue}
      />
      <NativeLookupText
        style={[styles.captionText, { fontSize: englishSize, lineHeight: Math.round(englishSize * 1.4) }]}
        numberOfLines={englishLines}
        ellipsizeMode="tail"
      >
        {captionLine}
      </NativeLookupText>
    </View>
  );
}

const styles = StyleSheet.create({
  listeningPillWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: LISTENING_PILL_WIDTH,
    height: LISTENING_PILL_HEIGHT,
    zIndex: 12,
  },
  listeningPill: {
    width: LISTENING_PILL_WIDTH,
    height: LISTENING_PILL_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(6, 27, 52, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    ...shadows.button,
  },
  listeningDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#38C976',
  },
  listeningPillLabel: {
    flex: 1,
    color: colors.textOnNavy,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  panel: {
    position: 'absolute',
    flexDirection: 'column',
    top: 0,
    left: 0,
    zIndex: 12,
    backgroundColor: colors.deepNavy,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    ...shadows.float,
  },
  /**
   * Position-only wrapper for the resize ghost — carries `pan`'s
   * native-driven transform and nothing else, so it never shares a style
   * array with the ghost's (non-native-driver-eligible) width/height.
   */
  resizeGhostPositioner: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 13,
  },
  /** Content-free resize preview — see the render-time comment above. */
  resizeGhost: {
    backgroundColor: 'rgba(30, 41, 59, 0.35)',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.55)',
  },
  grip: {
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
    alignSelf: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  recDot: {
    backgroundColor: colors.recordingRed,
  },
  recDotPaused: {
    backgroundColor: colors.mutedBlueGray,
  },
  timer: {
    fontWeight: '800',
    color: colors.textOnNavy,
    fontVariant: ['tabular-nums'],
  },
  pausedLabel: {
    fontWeight: '800',
    letterSpacing: 0.8,
    color: colors.textOnNavyMuted,
  },
  spacer: { flex: 1 },
  closeBtn: {
    backgroundColor: colors.navyElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captionBlock: { gap: 4 },
  captionArea: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  latestOnlyCaptionArea: {
    justifyContent: 'flex-start',
    overflow: 'hidden',
  },
  latestOnlyCaptionAreaTall: { justifyContent: 'center' },
  latestOnlyCaptionBlock: {
    alignSelf: 'stretch',
    flexShrink: 1,
    overflow: 'hidden',
  },
  latestOnlyCaptionBlockTall: {
    justifyContent: 'center',
    minHeight: '100%',
  },
  captionBlockFlexible: {
    flex: 1,
    gap: spacing.sm,
  },
  captionBlockEmpty: { justifyContent: 'center' },
  captionRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  feedScroll: { flex: 1 },
  feedContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  feedLine: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    gap: 3,
  },
  feedLineActive: { backgroundColor: colors.navyElevated },
  feedEnglish: { flex: 0 },
  feedChinese: { paddingHorizontal: 0 },
  captionText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.45,
    fontWeight: '700',
    color: colors.textOnNavy,
  },
  captionTranslation: {
    paddingHorizontal: spacing.sm,
    fontSize: fontSize.xs,
    lineHeight: fontSize.xs * 1.5,
    fontWeight: '500',
    color: colors.textOnNavyMuted,
  },
  captionTranslationPending: {
    paddingHorizontal: spacing.sm,
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textOnNavyMuted,
  },
  panelFooter: {
    gap: 2,
    marginTop: 'auto',
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: colors.navyBorder,
    paddingTop: 4,
  },
  controls: {
    flexDirection: 'row',
    gap: 6,
    flexShrink: 0,
  },
  resizeLane: {
    minHeight: 56,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    flexShrink: 0,
  },
  controlBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.navyElevated,
  },
  controlBtnActive: { backgroundColor: colors.iceBlue },
  controlLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textOnNavy,
  },
  controlLabelActive: { color: colors.deepNavy },
  resizeHandle: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: colors.navyElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.96 }],
  },
});
