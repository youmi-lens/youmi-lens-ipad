/**
 * Mini Workspace — a Notability-style notebook page used while recording.
 *
 * The whole screen is a long, scrollable handwritten + typed notebook
 * (NotebookCanvas). A small, compact recording panel floats on top and can be
 * dragged anywhere on screen so it never blocks note-taking. Notes are kept in
 * the recording-draft context so they survive navigating back to the
 * recording screen and are saved into the lecture when recording finishes.
 */
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  NotebookCanvas,
  type NotebookOverlayRect,
} from '@/components/NotebookCanvas';
import { NativeLookupText } from '@/components/NativeLookupText';
import { PressableScale } from '@/components/PressableScale';
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
const MINI_NAV_HEIGHT = 50;
const LISTENING_PILL_WIDTH = 176;
const LISTENING_PILL_HEIGHT = 42;
const CAPTION_DEFAULT_LOCAL_TOP = 96;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export default function MiniCaptionScreen() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ elapsed?: string }>();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const insetTop = insets.top;
  const insetBottom = insets.bottom;
  const insetLeft = insets.left;
  const insetRight = insets.right;
  // Phone portrait is much narrower than the panel's iPad-era default — keep a
  // comfortable margin instead of letting it nearly span the screen.
  const initialPanelWidth = Math.min(DEFAULT_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width - EDGE_MARGIN * 4));

  const {
    status,
    latestCaption,
    partialCaption,
    partialTranslationZh,
    latestFinalLine,
    captionLines,
  } = useLiveCaptions();
  const {
    draftNotes,
    draftStrokes,
    draftImages,
    setDraftNotes,
    setDraftStrokes,
    setDraftImages,
    currentDurationMillis,
    isLectureSessionPaused,
    toggleLectureSessionPause,
    addMarkMillis,
  } = useRecordingNotes();

  const [fallbackMillis, setFallbackMillis] = useState((Number(params.elapsed ?? 0) || 0) * 1000);
  const panelPaused = isLectureSessionPaused;
  const [markFlash, setMarkFlash] = useState(false);
  const [panelVisible, setPanelVisible] = useState(true);
  const [autoFollowFeed, setAutoFollowFeed] = useState(true);
  const [panelSize, setPanelSize] = useState({
    width: initialPanelWidth,
    height: DEFAULT_PANEL_HEIGHT,
  });

  // Recording mirrors its authoritative clock into shared draft state. This
  // local clock is only a fallback for the brief case where Mini mounts before
  // that shared value is available.
  useEffect(() => {
    if (panelPaused || currentDurationMillis > 0) return;
    const id = setInterval(() => setFallbackMillis((ms) => ms + 1000), 1000);
    return () => clearInterval(id);
  }, [currentDurationMillis, panelPaused]);

  useEffect(() => {
    if (!markFlash) return;
    const id = setTimeout(() => setMarkFlash(false), 900);
    return () => clearTimeout(id);
  }, [markFlash]);

  // ---- Draggable floating panel ----
  const initial = useRef({
    x: Math.max(EDGE_MARGIN + insetLeft, width - initialPanelWidth - 16 - insetRight),
    y: insets.top + MINI_NAV_HEIGHT + CAPTION_DEFAULT_LOCAL_TOP,
  });
  const pan = useRef(new Animated.ValueXY(initial.current)).current;
  const posRef = useRef({ ...initial.current });
  const dragStart = useRef({ x: 0, y: 0 });
  const panelSizeRef = useRef(panelSize);
  panelSizeRef.current = panelSize;
  const resizeStartSizeRef = useRef(panelSize);
  const isResizingRef = useRef(false);
  // Live panel box size during an active resize drag. Driven directly by the
  // resize gesture and applied to the panel's width/height via panelSizeAnim
  // (below) WITHOUT going through React state — see panelSizeAnim's comment.
  // Deliberately separate from panelSizeRef, which is re-synced to the
  // (currently frozen, during a resize) `panelSize` state on every render and
  // would otherwise clobber this mid-gesture.
  const resizeLiveSizeRef = useRef(panelSize);
  // Drives ONLY the lightweight resize-preview ghost box's width/height during
  // an active drag — never the real panel. Physical-device testing proved
  // that animating the real panel's width/height (even via a plain
  // Animated.Value, with zero React re-renders) still doesn't track the
  // finger smoothly: width/height are Yoga layout properties (RN's own
  // NativeAnimatedAllowlist.js excludes them from native-driver support —
  // "all non-layout properties" only), so every setValue() still forced a
  // full native layout pass of the panel's subtree, including the
  // unvirtualized caption ScrollView and NativeLookupText's many nested
  // per-word Text fragments. The real panel's content now stays completely
  // frozen at its committed `panelSize` for the whole gesture — see the
  // ghost box below for what actually tracks the finger.
  // Kept in sync with `panelSize` state whenever it changes from a
  // non-gesture source (mount, orientation change).
  const panelSizeAnim = useRef(new Animated.ValueXY({ x: panelSize.width, y: panelSize.height })).current;
  useEffect(() => {
    if (isResizingRef.current) return; // a live gesture owns the value; don't fight it
    panelSizeAnim.setValue({ x: panelSize.width, y: panelSize.height });
  }, [panelSize, panelSizeAnim]);
  // Content-free resize preview, shown only while actively dragging the
  // resize handle. A rare, low-frequency state change (once per gesture
  // start/end) — not touched on every move frame, so it costs nothing extra.
  const [isResizeGhostVisible, setIsResizeGhostVisible] = useState(false);
  const feedScrollRef = useRef<ScrollView | null>(null);
  const feedMetricsRef = useRef({ contentHeight: 0, layoutHeight: 0 });
  const feedUserScrollingRef = useRef(false);
  const feedAutoScrollPendingRef = useRef(false);
  const initialListeningPill = useRef({
    x: Math.max(EDGE_MARGIN + insetLeft, width - LISTENING_PILL_WIDTH - 16 - insetRight),
    y: Math.max(EDGE_MARGIN + insetTop, height - LISTENING_PILL_HEIGHT - 24 - insetBottom),
  });
  const listeningPillPan = useRef(new Animated.ValueXY(initialListeningPill.current)).current;
  const listeningPillPosRef = useRef({ ...initialListeningPill.current });
  const listeningPillDragStart = useRef({ x: 0, y: 0 });
  const listeningPillWasDraggedRef = useRef(false);
  const [captionOverlayRect, setCaptionOverlayRect] = useState<NotebookOverlayRect>({
    x: initial.current.x,
    y: initial.current.y,
    width: initialPanelWidth,
    height: DEFAULT_PANEL_HEIGHT,
  });

  const updateCaptionOverlayRect = useCallback(
    (
      position: { x: number; y: number },
      size: { width: number; height: number },
    ) => {
      setCaptionOverlayRect({ ...position, ...size });
    },
    [],
  );

  const dragResponder = useMemo(() => {
    const minX = EDGE_MARGIN + insetLeft;
    const minY = EDGE_MARGIN + insetTop;
    const settle = (dx: number, dy: number) => {
      const maxX = Math.max(minX, width - panelSizeRef.current.width - EDGE_MARGIN - insetRight);
      const maxY = Math.max(minY, height - panelSizeRef.current.height - EDGE_MARGIN - insetBottom);
      const next = {
        x: Math.min(Math.max(dragStart.current.x + dx, minX), maxX),
        y: Math.min(Math.max(dragStart.current.y + dy, minY), maxY),
      };
      posRef.current = next;
      updateCaptionOverlayRect(next, panelSizeRef.current);
      Animated.spring(pan, {
        toValue: next,
        useNativeDriver: true,
        friction: 9,
        tension: 80,
      }).start();
    };
    return PanResponder.create({
      // Taps fall through to the panel's buttons; only a clear drag moves it.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) =>
        !isResizingRef.current && (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4),
      onPanResponderGrant: () => {
        dragStart.current = { ...posRef.current };
      },
      onPanResponderMove: (_e, g) => {
        const next = { x: dragStart.current.x + g.dx, y: dragStart.current.y + g.dy };
        pan.setValue(next);
        updateCaptionOverlayRect(next, panelSizeRef.current);
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
  }, [width, height, insetTop, insetBottom, insetLeft, insetRight, pan, updateCaptionOverlayRect]);

  const listeningPillResponder = useMemo(() => {
    const minX = EDGE_MARGIN + insetLeft;
    const minY = EDGE_MARGIN + insetTop;
    const settle = (dx: number, dy: number) => {
      const maxX = Math.max(minX, width - LISTENING_PILL_WIDTH - EDGE_MARGIN - insetRight);
      const maxY = Math.max(minY, height - LISTENING_PILL_HEIGHT - EDGE_MARGIN - insetBottom);
      const next = {
        x: Math.min(Math.max(listeningPillDragStart.current.x + dx, minX), maxX),
        y: Math.min(Math.max(listeningPillDragStart.current.y + dy, minY), maxY),
      };
      listeningPillPosRef.current = next;
      updateCaptionOverlayRect(next, {
        width: LISTENING_PILL_WIDTH,
        height: LISTENING_PILL_HEIGHT,
      });
      Animated.spring(listeningPillPan, {
        toValue: next,
        useNativeDriver: true,
        friction: 9,
        tension: 80,
      }).start();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5,
      onPanResponderGrant: () => {
        listeningPillWasDraggedRef.current = true;
        listeningPillDragStart.current = { ...listeningPillPosRef.current };
      },
      onPanResponderMove: (_e, g) => {
        const next = {
          x: listeningPillDragStart.current.x + g.dx,
          y: listeningPillDragStart.current.y + g.dy,
        };
        listeningPillPan.setValue(next);
        updateCaptionOverlayRect(next, {
          width: LISTENING_PILL_WIDTH,
          height: LISTENING_PILL_HEIGHT,
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
  }, [height, insetTop, insetBottom, insetLeft, insetRight, listeningPillPan, updateCaptionOverlayRect, width]);

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
      // High-frequency path (fires on every touch-move sample). Deliberately
      // does NOT call setPanelSize/setCaptionOverlayRect (React state), does
      // NOT touch the real panel's width/height, and does NOT re-layout the
      // caption feed at all — only panelSizeAnim, which drives the
      // content-free ghost preview box below. The real panel (padding,
      // border radius, font scale, the caption feed, NativeLookupText's
      // per-word fragments) stays completely frozen at its pre-drag values
      // for the whole gesture and gets exactly one real layout pass, on
      // release, once the final size is known — the ghost box visibly and
      // continuously tracks the finger in the meantime.
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
        updateCaptionOverlayRect(posRef.current, finalSize);
        setIsResizeGhostVisible(false);
        const maxX = Math.max(EDGE_MARGIN + insetLeft, width - finalSize.width - EDGE_MARGIN - insetRight);
        const maxY = Math.max(EDGE_MARGIN + insetTop, height - finalSize.height - EDGE_MARGIN - insetBottom);
        const nextPos = {
          x: Math.min(posRef.current.x, maxX),
          y: Math.min(posRef.current.y, maxY),
        };
        posRef.current = nextPos;
        Animated.spring(pan, {
          toValue: nextPos,
          useNativeDriver: true,
          friction: 9,
          tension: 80,
        }).start();
      },
      onPanResponderTerminate: () => {
        isResizingRef.current = false;
        setIsResizeGhostVisible(false);
        // A cancelled gesture must not leave the visual box out of sync with
        // committed state — snap the preview back to the last committed size.
        panelSizeAnim.setValue({ x: panelSizeRef.current.width, y: panelSizeRef.current.height });
      },
    });
  }, [height, insetTop, insetBottom, insetLeft, insetRight, pan, panelSizeAnim, updateCaptionOverlayRect, width]);

  useEffect(() => {
    const minX = EDGE_MARGIN + insetLeft;
    const minY = EDGE_MARGIN + insetTop;

    if (panelVisible) {
      const nextSize = {
        width: Math.min(
          panelSize.width,
          Math.max(MIN_PANEL_WIDTH, width - insetLeft - insetRight - EDGE_MARGIN * 2),
        ),
        height: Math.min(
          panelSize.height,
          Math.max(MIN_PANEL_HEIGHT, height - insetTop - insetBottom - EDGE_MARGIN * 2),
        ),
      };
      if (nextSize.width !== panelSize.width || nextSize.height !== panelSize.height) {
        panelSizeRef.current = nextSize;
        setPanelSize(nextSize);
      }

      const nextPosition = {
        x: clamp(
          posRef.current.x,
          minX,
          Math.max(minX, width - nextSize.width - EDGE_MARGIN - insetRight),
        ),
        y: clamp(
          posRef.current.y,
          minY,
          Math.max(minY, height - nextSize.height - EDGE_MARGIN - insetBottom),
        ),
      };
      posRef.current = nextPosition;
      pan.setValue(nextPosition);
      updateCaptionOverlayRect(nextPosition, nextSize);
      return;
    }

    const nextPillPosition = {
      x: clamp(
        listeningPillPosRef.current.x,
        minX,
        Math.max(minX, width - LISTENING_PILL_WIDTH - EDGE_MARGIN - insetRight),
      ),
      y: clamp(
        listeningPillPosRef.current.y,
        minY,
        Math.max(minY, height - LISTENING_PILL_HEIGHT - EDGE_MARGIN - insetBottom),
      ),
    };
    listeningPillPosRef.current = nextPillPosition;
    listeningPillPan.setValue(nextPillPosition);
    updateCaptionOverlayRect(nextPillPosition, {
      width: LISTENING_PILL_WIDTH,
      height: LISTENING_PILL_HEIGHT,
    });
  }, [
    height,
    insetBottom,
    insetLeft,
    insetRight,
    insetTop,
    listeningPillPan,
    pan,
    panelSize,
    panelVisible,
    updateCaptionOverlayRect,
    width,
  ]);

  const notebookAvoidRects = useMemo(
    () => [
      {
        x: captionOverlayRect.x - insets.left,
        y: captionOverlayRect.y - insets.top - MINI_NAV_HEIGHT,
        width: captionOverlayRect.width,
        height: captionOverlayRect.height,
      },
    ],
    [captionOverlayRect, insets.left, insets.top],
  );

  const captionsLive = status === 'active' || status === 'listening';
  const latestFinalEnglish = latestFinalLine?.text ?? captionLines[captionLines.length - 1]?.text ?? '';
  const visibleEnglishCaption = partialCaption || latestFinalEnglish || latestCaption;
  // English is the primary live caption; Chinese is translation support
  // underneath it. Fixed order for V1 — see Settings → Language.
  const captionLine = captionsLive
    ? visibleEnglishCaption || t('mini.listeningStatus')
    : status === 'connecting'
      ? t('mini.connecting')
      : visibleEnglishCaption
        ? visibleEnglishCaption
        : status === 'error' || status === 'unavailable'
          ? t('mini.unavailable')
          : t('mini.listeningStatus');
  const translationLine = partialTranslationZh || latestFinalLine?.translatedText || latestFinalLine?.translationZh;
  const translationPending = Boolean(latestFinalLine && !translationLine && !partialCaption);
  const displayMillis = currentDurationMillis > 0 ? currentDurationMillis : fallbackMillis;
  const seconds = Math.floor(displayMillis / 1000);
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

  // The caption panel (including its ScrollView) is conditionally rendered —
  // `setPanelVisible(false)` (minimize to the listening pill) fully unmounts
  // it, and `setPanelVisible(true)` mounts a brand-new one. A fresh mount
  // naturally starts scrolled to the top of history. `autoFollowFeed` is
  // parent-level state that survives that unmount, so if the user had
  // scrolled up to read history before minimizing, reopening kept
  // autoFollowFeed=false and the new ScrollView was never told to catch up —
  // it just sat at the top. Every reopen must reset to the live edge
  // regardless of where the user was reading before closing.
  const wasPanelVisibleRef = useRef(panelVisible);
  useEffect(() => {
    if (panelVisible && !wasPanelVisibleRef.current) {
      setAutoFollowFeed(true);
    }
    wasPanelVisibleRef.current = panelVisible;
  }, [panelVisible]);

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
  }, [
    autoFollowFeed,
    showCaptionFeed,
    captionLines.length,
    partialCaption,
  ]);

  const updateAutoFollowFromScroll = (scrollY: number) => {
    const { contentHeight, layoutHeight } = feedMetricsRef.current;
    const distanceFromBottom = contentHeight - layoutHeight - scrollY;
    setAutoFollowFeed(distanceFromBottom < 72);
  };

  const markImportant = () => {
    addMarkMillis(displayMillis);
    setMarkFlash(true);
  };

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.canvasSlot}>
          <NotebookCanvas
            style={styles.canvas}
            strokes={draftStrokes}
            text={draftNotes}
            images={draftImages}
            onStrokesChange={setDraftStrokes}
            onTextChange={setDraftNotes}
            onImagesChange={setDraftImages}
            avoidRects={notebookAvoidRects}
            showFixedHistory
          />
        </View>
      </SafeAreaView>

      <View style={[styles.miniNav, { top: insets.top + 8 }]} pointerEvents="box-none">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mini.backRecording')}
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={18} color={colors.deepNavy} />
          <Text style={styles.backButtonLabel}>{t('mini.recording')}</Text>
        </Pressable>
      </View>

      {!panelVisible ? (
        <Animated.View
          style={[
            styles.listeningPillWrap,
            { transform: listeningPillPan.getTranslateTransform() },
          ]}
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
      ) : null}

      {/* ---- Floating, draggable recording panel ---- */}
      {panelVisible ? (
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
        {/* Drag zone: only the header (grip + status row) moves the panel, so a
            vertical swipe inside the caption ScrollView scrolls the subtitle
            history instead of dragging the whole popup. Mirrors the shared
            FloatingMiniCaption fix (e8f37d0), which this Notebook workspace
            panel never received. */}
        <View style={{ gap: scaled.panelGap }} {...dragResponder.panHandlers}>
        <View
          style={[
            styles.grip,
            {
              width: scaled.gripWidth,
              height: scaled.gripHeight,
              borderRadius: scaled.gripHeight / 2,
            },
          ]}
        />

        <View style={[styles.statusRow, { gap: Math.max(6, Math.round(8 * panelScale)) }]}>
          <View
            style={[
              styles.recDot,
              {
                width: scaled.statusDot,
                height: scaled.statusDot,
                borderRadius: scaled.statusDot / 2,
              },
              panelPaused && styles.recDotPaused,
            ]}
          />
          <Text
            style={[styles.timer, { fontSize: scaled.timer }]}
          >
            {formatClock(seconds)}
          </Text>
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
              contentContainerStyle={[
                styles.feedContent,
                { gap: Math.max(8, Math.round(10 * panelScale)) },
              ]}
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
                        {
                          fontSize: scaled.english,
                          lineHeight: Math.round(scaled.english * 1.4),
                        },
                      ]}
                    >
                      {line.text}
                    </NativeLookupText>
                    {(line.translatedText ?? line.translationZh) ? (
                      <Text
                        style={[
                          styles.captionTranslation,
                          styles.feedChinese,
                          {
                            fontSize: scaled.chinese,
                            lineHeight: Math.round(scaled.chinese * 1.5),
                          },
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
                <View
                  style={[
                    styles.captionRow,
                    {
                      gap: Math.max(6, Math.round(6 * panelScale)),
                      borderRadius: Math.round(8 * panelScale),
                      paddingHorizontal: scaled.rowPaddingX,
                      paddingVertical: scaled.rowPaddingY,
                    },
                  ]}
                >
                  <Ionicons
                    name={captionsLive ? 'chatbubble-ellipses' : 'information-circle-outline'}
                    size={scaled.icon}
                    color={colors.iceBlue}
                  />
                  <NativeLookupText
                    style={[
                      styles.captionText,
                      {
                        fontSize: scaled.english,
                        lineHeight: Math.round(scaled.english * 1.4),
                      },
                    ]}
                  >
                    {captionLine}
                  </NativeLookupText>
                </View>
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
              <View
                style={[
                  styles.captionRow,
                  {
                    gap: Math.max(6, Math.round(6 * latestOnlyCaptionScale)),
                    borderRadius: Math.round(8 * latestOnlyCaptionScale),
                    paddingHorizontal: Math.round(10 * latestOnlyCaptionScale),
                    paddingVertical: Math.round(7 * latestOnlyCaptionScale),
                  },
                ]}
              >
                <Ionicons
                  name={captionsLive ? 'chatbubble-ellipses' : 'information-circle-outline'}
                  size={scaled.icon}
                  color={colors.iceBlue}
                />
                <NativeLookupText
                  style={[
                    styles.captionText,
                    {
                      fontSize: latestOnlyEnglishSize,
                      lineHeight: Math.round(latestOnlyEnglishSize * 1.4),
                    },
                  ]}
                  numberOfLines={latestOnlyEnglishLines}
                  ellipsizeMode="tail"
                >
                  {captionLine}
                </NativeLookupText>
              </View>
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
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('mini.markImportant')}
              onPress={markImportant}
              style={[
                styles.controlBtn,
                { height: scaled.controlHeight, borderRadius: Math.round(8 * panelScale), gap: scaled.controlGap },
                markFlash && styles.controlBtnActive,
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
            </PressableScale>
            <PressableScale
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
              style={[
                styles.controlBtn,
                { height: scaled.controlHeight, borderRadius: Math.round(8 * panelScale), gap: scaled.controlGap },
              ]}
            >
              <Ionicons name="scan-outline" size={scaled.controlIcon} color={colors.textOnNavy} />
              {!panelCompact ? <Text style={[styles.controlLabel, { fontSize: scaled.controlLabel }]}>{t('mini.expand')}</Text> : null}
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={panelPaused ? t('mini.resume') : t('mini.pause')}
              onPress={() => {
                void toggleLectureSessionPause();
              }}
              style={[
                styles.controlBtn,
                { height: scaled.controlHeight, borderRadius: Math.round(8 * panelScale), gap: scaled.controlGap },
              ]}
            >
              <Ionicons name={panelPaused ? 'play' : 'pause'} size={scaled.controlIcon} color={colors.textOnNavy} />
              {!panelCompact ? (
                <Text style={[styles.controlLabel, { fontSize: scaled.controlLabel }]}> 
                  {panelPaused ? t('mini.resume') : t('mini.pause')}
                </Text>
              ) : null}
            </PressableScale>
          </View>
          <View style={styles.resizeLane}>
            <View style={styles.resizeHandle} {...resizeResponder.panHandlers}>
              <Ionicons name="resize-outline" size={scaled.resizeVisual} color={colors.textOnNavyMuted} />
            </View>
          </View>
        </View>
      </Animated.View>
      ) : null}

      {/* Resize preview — a content-free ghost outline shown only while
          actively dragging the resize handle. Tracks the finger via
          panelSizeAnim/pan; carries no caption text, no ScrollView, no
          NativeLookupText, so it costs essentially nothing to lay out on
          every gesture frame. The real panel above stays frozen at its
          committed size the whole time; see resizeResponder's comments.
          Split into two nested Animated.Views deliberately: `pan`'s
          transform (native-driver-eligible, used with useNativeDriver:true
          elsewhere for the drag/settle springs) must not share a style
          array with panelSizeAnim's width/height (NOT native-driver-
          eligible — RN's own Animated system throws "Style property
          'width'/'height' is not supported by native animated module" if a
          native-driven transform and a JS-driven width/height are mixed on
          the same view). The outer view carries ONLY the transform; the
          inner view carries ONLY the size. */}
      {panelVisible && isResizeGhostVisible ? (
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  safe: {
    flex: 1,
  },
  canvasSlot: {
    flex: 1,
    paddingTop: MINI_NAV_HEIGHT,
  },
  canvas: {
    flex: 1,
  },
  miniNav: {
    position: 'absolute',
    left: spacing.md,
    zIndex: 3,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  backButtonLabel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.deepNavy,
  },
  listeningPillWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: LISTENING_PILL_WIDTH,
    height: LISTENING_PILL_HEIGHT,
    zIndex: 3,
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

  // ---- Floating panel ----
  panel: {
    position: 'absolute',
    flexDirection: 'column',
    top: 0,
    left: 0,
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
  },
  /** Content-free resize preview — see the render-time comment above. */
  resizeGhost: {
    backgroundColor: 'rgba(30, 41, 59, 0.35)',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.55)',
  },
  grip: {
    width: 34,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
    alignSelf: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  recDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.recordingRed,
  },
  recDotPaused: {
    backgroundColor: colors.mutedBlueGray,
  },
  timer: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.textOnNavy,
    fontVariant: ['tabular-nums'],
  },
  pausedLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: colors.textOnNavyMuted,
  },
  spacer: {
    flex: 1,
  },
  closeBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.navyElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captionRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  captionBlock: {
    gap: 4,
  },
  captionArea: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  latestOnlyCaptionArea: {
    justifyContent: 'flex-start',
    overflow: 'hidden',
  },
  latestOnlyCaptionAreaTall: {
    justifyContent: 'center',
  },
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
  captionBlockEmpty: {
    justifyContent: 'center',
  },
  feedScroll: {
    flex: 1,
  },
  feedContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  feedLine: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    gap: 3,
  },
  feedLineActive: {
    backgroundColor: colors.navyElevated,
  },
  feedEnglish: {
    flex: 0,
  },
  feedChinese: {
    paddingHorizontal: 0,
  },
  // English — primary: brighter and bolder than the Chinese line.
  captionText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.45,
    fontWeight: '700',
    color: colors.textOnNavy,
  },
  // Chinese — secondary support: one size step down, muted, lighter weight.
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
  controlBtnActive: {
    backgroundColor: colors.iceBlue,
  },
  controlLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textOnNavy,
  },
  controlLabelActive: {
    color: colors.deepNavy,
  },
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
