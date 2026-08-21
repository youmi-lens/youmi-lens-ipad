import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';

import { motion, useReduceMotion } from '@/constants/motion';

/**
 * A per-item entrance settle for cards in a mutation-driven collection — each
 * instance owns its OWN `Animated.Value`. This is deliberately NOT a single
 * shared container wrapped around the whole list: that pattern (one opacity
 * animation over an entire collection) is exactly what caused the Courses
 * grid white-screen regression — create/delete/remount/native reattachment
 * could reset the wrapper's opacity to 0 and blank every card at once. A
 * Per-card opacity still proved unsafe on a physical iPad: a Realtime insert
 * could attach while its native entrance was interrupted and leave that one
 * active Course looking disabled. The entrance is therefore translate-only.
 * It can still settle once, but visibility no longer depends on animation.
 *
 * Plays once per (component instance × `revealKey`): a card that re-renders
 * because its own data changed (rename, lecture count, cloud sync) does NOT
 * replay, because `revealKey` — the tab's focus-only token — did not change.
 * A genuinely new card (new Course UUID key, new component instance) always
 * plays its own entrance on mount, which doubles as its "just created" cue
 * without needing any dedicated "isNew" tracking.
 *
 * `index` drives a capped stagger delay but is deliberately NOT a dependency
 * of the effect — a list reorder (rename changing sort position, deletion
 * shifting indices) must never replay an existing card's entrance; only a
 * `revealKey` change (or first mount) does.
 */
export function StaggeredCardEntrance({
  children,
  style,
  revealKey,
  index = 0,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  revealKey?: string | number;
  index?: number;
}) {
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    const delay = Math.min(index, motion.cardStaggerCap) * motion.cardStaggerMs;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: motion.cardEntranceDuration,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!finished) progress.setValue(1);
    });
    return () => {
      // An interrupted settle must not leave a residual vertical offset.
      animation.stop();
      progress.setValue(1);
    };
    // `index` is read above but deliberately NOT a dependency: only a
    // revealKey change (or first mount) should ever restart a card's
    // entrance, never a position shift from an unrelated list mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, reduceMotion, revealKey]);

  const animatedStyle = reduceMotion
    ? null
    : {
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [motion.cardEntranceOffset, 0],
            }),
          },
        ],
      };

  return <Animated.View style={[style, animatedStyle as ViewStyle]}>{children}</Animated.View>;
}

export default StaggeredCardEntrance;
