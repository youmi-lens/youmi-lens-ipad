import { Ionicons } from '@expo/vector-icons';
import { ReactNode, useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';

import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { useT } from '@/lib/i18n';

// ─── Layout constants ────────────────────────────────────────────────────────

// Width of the revealed delete action at rest (snapped-open state).
const ACTION_WIDTH = 96;

// Maximum rubber-banded travel distance (past ACTION_WIDTH it gets harder).
const MAX_TRANSLATE = 220;

// ─── Gesture thresholds ──────────────────────────────────────────────────────

// Activation: horizontal movement must exceed this before we track.
// Lowered from 10 → 5 to respond earlier.
const DRAG_DEAD_ZONE = 5;

// Direction ratio: dx must beat dy by this factor for a clear horizontal swipe.
// Lowered from 1.8 → 1.2 to capture shallower horizontal drags.
const DIRECTION_RATIO = 1.2;

// Capture threshold for the aggressive "steal from ScrollView" handler.
// Slightly higher than the move threshold so we only capture clear swipes.
const CAPTURE_DEAD_ZONE = 6;
const CAPTURE_DIRECTION_RATIO = 1.3;

// Snapping threshold: if release is past this, snap open.
const REVEAL_THRESHOLD = ACTION_WIDTH * 0.5; // ~48 px

// Full-swipe: trigger onDelete if dragged this far or this fast.
const FULL_SWIPE_DISTANCE = 155; // px
const FULL_SWIPE_VELOCITY = 0.5; // px/ms

// Delete area maximum width shown during a full-swipe animation.
const FULL_SWIPE_WIDTH = 140;

// ─── Types ───────────────────────────────────────────────────────────────────

type SwipeDeleteRowProps = {
  children: ReactNode;
  enabled?: boolean;
  open?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  onDelete: () => void;
  style?: ViewStyle;
  rowStyle?: ViewStyle;
};

// ─── Component ───────────────────────────────────────────────────────────────

export function SwipeDeleteRow({
  children,
  enabled = true,
  open = false,
  onOpen,
  onClose,
  onDelete,
  style,
  rowStyle,
}: SwipeDeleteRowProps) {
  const t = useT();
  // ── Animated values ──────────────────────────────────────────────────────
  //
  // TWO separate animated values on TWO separate drivers — never mixed:
  //
  //   translateX  → foreground row transform:translateX  (useNativeDriver: true)
  //                 Also drives icon opacity + scale (native driver).
  //
  //   deleteWidth → red panel's `width` style             (useNativeDriver: false)
  //                 Width is not supported by the native animated module, so this
  //                 MUST stay on the JS driver. No `width` is ever driven by the
  //                 native driver — the "'width' is not supported" warning will
  //                 never appear.
  //
  const translateX = useRef(new Animated.Value(0)).current;
  const deleteWidth = useRef(new Animated.Value(0)).current;

  // Snapshot of translateX when the current gesture started.
  const gestureBaseRef = useRef(0);
  // Guard against duplicate onDelete triggers within a single gesture.
  const fullSwipeTriggeredRef = useRef(false);

  // ── Helpers ──────────────────────────────────────────────────────────────

  // Rubber-band resistance for travel beyond ACTION_WIDTH.
  const applyResistance = (rawX: number): number => {
    if (rawX >= 0) return 0;
    const abs = Math.abs(rawX);
    if (abs <= ACTION_WIDTH) return rawX;
    const overflow = abs - ACTION_WIDTH;
    const compressed = ACTION_WIDTH + overflow * 0.35;
    return -Math.min(compressed, MAX_TRANSLATE);
  };

  // Compute the delete panel width that matches a given translateX value.
  // Maps the absolute translation to a panel width — 1:1 up to ACTION_WIDTH,
  // then adds a gentle overshoot curve beyond that.
  const widthForTranslation = (tx: number): number => {
    const abs = Math.abs(tx);
    if (abs <= ACTION_WIDTH) return abs;
    // Beyond ACTION_WIDTH the width grows slightly more than the translation
    // (visual "opening up" effect) but caps at FULL_SWIPE_WIDTH.
    const overflow = abs - ACTION_WIDTH;
    return Math.min(ACTION_WIDTH + overflow * 0.6, FULL_SWIPE_WIDTH);
  };

  // Synchronise both animated values to the same logical translation — used
  // during live drag (setValue = instant, no animation).
  const syncDrag = (tx: number) => {
    translateX.setValue(tx);
    deleteWidth.setValue(widthForTranslation(tx));
  };

  // Spring translateX to a target value (native driver).
  const springTranslateX = (toValue: number, onDone?: () => void) =>
    Animated.spring(translateX, {
      toValue,
      useNativeDriver: true,
      tension: 110,
      friction: 14,
      overshootClamping: false,
    }).start(({ finished }) => {
      if (finished && onDone) onDone();
    });

  // Animate deleteWidth to a target value (JS driver, no native driver).
  const animateDeleteWidth = (toValue: number, duration = 260) =>
    Animated.spring(deleteWidth, {
      toValue,
      useNativeDriver: false,   // ← width is NOT supported by the native driver
      tension: 110,
      friction: 14,
      overshootClamping: false,
    }).start();

  // Snap both values open (to the resting open position).
  const snapOpen = () => {
    springTranslateX(-ACTION_WIDTH);
    animateDeleteWidth(ACTION_WIDTH);
  };

  // Snap both values closed.
  const snapClosed = () => {
    springTranslateX(0);
    animateDeleteWidth(0);
  };

  // Full-swipe: animate out to screen edge, then call onDelete.
  const triggerFullSwipeDelete = () => {
    const screenWidth = Dimensions.get('window').width;
    // Grow the delete area dramatically before the card flies off.
    Animated.timing(deleteWidth, {
      toValue: FULL_SWIPE_WIDTH,
      duration: 200,
      useNativeDriver: false,   // ← width — JS driver only
    }).start();
    Animated.timing(translateX, {
      toValue: -screenWidth,
      duration: 280,
      useNativeDriver: true,
    }).start(() => {
      onDelete();
      // Silent reset — if the Alert is dismissed and the parent keeps the row,
      // the row will be in the right position (parent controls open prop).
      translateX.setValue(0);
      deleteWidth.setValue(0);
    });
  };

  // ── Sync with parent-controlled open prop ────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      snapClosed();
      return;
    }
    if (open) {
      snapOpen();
    } else {
      snapClosed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, open]);

  // ── PanResponder ─────────────────────────────────────────────────────────
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // ── Standard "should I handle this?" ──────────────────────────────
        // Lower threshold (5 px, ratio 1.2×) so the row starts tracking earlier.
        onMoveShouldSetPanResponder: (_evt, gesture) => {
          if (!enabled) return false;
          return (
            Math.abs(gesture.dx) > DRAG_DEAD_ZONE &&
            Math.abs(gesture.dx) > Math.abs(gesture.dy) * DIRECTION_RATIO
          );
        },

        // ── Capture variant — wins the gesture from the parent ScrollView ──
        // Called before onMoveShouldSetPanResponder on the parent. Returning
        // true here "steals" the gesture so the ScrollView never gets it.
        // We use a slightly higher threshold (6 px, ratio 1.3×) so vertical
        // scrolls and taps are NOT captured — only clear leftward horizontal
        // swipes are stolen from the ScrollView. This is the fix for
        // "have to swipe several times before Delete opens".
        onMoveShouldSetPanResponderCapture: (_evt, gesture) => {
          if (!enabled) return false;
          // Only capture clear leftward horizontal movement.
          return (
            gesture.dx < -CAPTURE_DEAD_ZONE &&
            Math.abs(gesture.dx) > Math.abs(gesture.dy) * CAPTURE_DIRECTION_RATIO
          );
        },

        onPanResponderGrant: () => {
          fullSwipeTriggeredRef.current = false;
          // Snapshot the current animated value so we can offset from it.
          translateX.stopAnimation((value) => {
            gestureBaseRef.current = value;
          });
        },

        onPanResponderMove: (_evt, gesture) => {
          if (!enabled || fullSwipeTriggeredRef.current) return;
          const raw = gestureBaseRef.current + gesture.dx;
          const clamped = applyResistance(raw);
          // Direct setValue — no spring while finger is down, so the row
          // tracks the finger with zero lag.
          syncDrag(clamped);
        },

        onPanResponderRelease: (_evt, gesture) => {
          if (!enabled || fullSwipeTriggeredRef.current) return;

          const currentRaw = gestureBaseRef.current + gesture.dx;
          const absDistance = Math.abs(currentRaw);
          const isFastSwipe = gesture.vx < -FULL_SWIPE_VELOCITY;
          const isFarSwipe = absDistance >= FULL_SWIPE_DISTANCE;

          if (isFastSwipe || isFarSwipe) {
            fullSwipeTriggeredRef.current = true;
            triggerFullSwipeDelete();
            return;
          }

          const shouldOpen = absDistance > REVEAL_THRESHOLD || gesture.vx < -0.25;
          if (shouldOpen) {
            onOpen?.();
            snapOpen();
          } else {
            onClose?.();
            snapClosed();
          }
        },

        onPanResponderTerminate: () => {
          if (fullSwipeTriggeredRef.current) return;
          // Another responder took over — restore the expected resting state.
          if (open) {
            snapOpen();
          } else {
            snapClosed();
          }
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, onClose, onOpen, open],
  );

  // ── Delete panel visual interpolations (native driver — no width here) ───
  //
  // Icon + label: fade in and scale up as the row is swiped open.
  // Both interpolate from translateX, which is on the native driver.
  //
  const iconOpacity = translateX.interpolate({
    inputRange: [-ACTION_WIDTH, -ACTION_WIDTH * 0.45, -ACTION_WIDTH * 0.15, 0],
    outputRange: [1, 0.85, 0.2, 0],
    extrapolate: 'clamp',
  });

  // Scale from 0.85 (just appearing) → 1.05 (slight pop at full open) → 1.0.
  const iconScale = translateX.interpolate({
    inputRange: [-ACTION_WIDTH * 1.3, -ACTION_WIDTH, -ACTION_WIDTH * 0.35, 0],
    outputRange: [1.05, 1.0, 0.85, 0.7],
    extrapolate: 'clamp',
  });

  // Depth overlay fades in during deep/full-swipe for a richer red.
  const overlayOpacity = translateX.interpolate({
    inputRange: [-MAX_TRANSLATE * 0.9, -ACTION_WIDTH * 1.2, -ACTION_WIDTH],
    outputRange: [0.38, 0.18, 0],
    extrapolate: 'clamp',
  });

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <View style={[styles.shell, style]}>
      {/* ── Delete action layer ────────────────────────────────────────────
          The red panel's width is driven by `deleteWidth` (JS driver).
          It grows from 0 → ACTION_WIDTH as the user swipes left, giving a
          clear visual that the delete zone is expanding to receive the card.
          The panel is right-anchored via absolute positioning + right: 0.   */}
      {enabled ? (
        <Animated.View
          style={[
            styles.actionWrap,
            {
              // width is animated by deleteWidth on the JS driver.
              // This is the ONLY place width animation is used. It is
              // explicitly on the JS driver (useNativeDriver: false above).
              width: deleteWidth,
            },
          ]}
        >
          {/* Solid red fill — no scaleX, just the container growing wider */}
          <View style={styles.actionBackground} />

          {/* Depth overlay — fades in on deep swipe (native driver opacity) */}
          <Animated.View
            style={[styles.actionDepthOverlay, { opacity: overlayOpacity }]}
          />

          {/* Pressable delete tap target — fills the growing panel */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.delete')}
            onPress={onDelete}
            style={({ pressed }) => [styles.deleteAction, pressed && styles.deletePressed]}
          >
            {/* Icon + label — fade in and scale up as the panel grows */}
            <Animated.View
              style={[
                styles.iconLabelWrap,
                {
                  opacity: iconOpacity,
                  transform: [{ scale: iconScale }],
                },
              ]}
            >
              <Ionicons name="trash-outline" size={22} color={colors.pearlWhite} />
              <Text style={styles.deleteLabel}>{t('common.delete')}</Text>
            </Animated.View>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* ── Foreground card ─────────────────────────────────────────────────
          translateX only — no scaleX so content is never distorted.
          Slides left as the finger moves, revealing the growing delete zone. */}
      <Animated.View
        {...(enabled ? panResponder.panHandlers : {})}
        style={[styles.foreground, rowStyle, { transform: [{ translateX }] }]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: radius.lg,
  },
  foreground: {
    backgroundColor: colors.surface,
  },
  // Action panel — right-anchored; width is animated (grows from right edge).
  actionWrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    borderTopRightRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    // No fixed width here — width is set by the Animated.View style above.
  },
  // Solid red fill — always covers the full actionWrap area.
  actionBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.recordingRed,
    borderTopRightRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  // Darker-red overlay — deepens the color during full-swipe.
  actionDepthOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#B91C1C',
    borderTopRightRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    pointerEvents: 'none',
  },
  // Pressable fills the entire growing panel (100% width/height of actionWrap).
  deleteAction: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deletePressed: {
    opacity: 0.78,
  },
  // Icon + label container — uniform scale only, never scaleX.
  iconLabelWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  deleteLabel: {
    fontSize: fontSize.sm,
    color: colors.pearlWhite,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
