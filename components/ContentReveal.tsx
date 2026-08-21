import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';

import { motion, useReduceMotion } from '@/constants/motion';

/**
 * One restrained container-level reveal, shared by every surface that swaps a
 * skeleton for real content or mounts a tab body.
 *
 * Use it on the CONTAINER, never per list row — animating each row of a long
 * list is both visually noisy and the fastest way to make a virtualized list
 * stutter. One fade over the whole body reads as the page settling.
 *
 * Runs on the native driver, so it costs nothing on the JS thread.
 *
 * Reduce Motion: the translation is dropped and the fade shortened, but the
 * content still appears at full opacity immediately — reduced motion must never
 * mean "slower".
 */
export function ContentReveal({
  children,
  style,
  /** Re-runs the reveal when this changes — e.g. the selected tab key. */
  revealKey,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  revealKey?: string | number;
}) {
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: motion.contentRevealDuration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      // Stopping cancels rather than stacks when the reveal re-runs. Critically,
      // `stop()` freezes the value wherever it happens to be — an interrupted
      // reveal used to strand content at partial opacity, permanently, because
      // nothing ever drove it the rest of the way. Content must never be left
      // unreadable by a cancelled decoration, so settle at fully visible.
      animation.stop();
      progress.setValue(1);
    };
  }, [progress, reduceMotion, revealKey]);

  const animatedStyle = reduceMotion
    ? { opacity: progress }
    : {
        opacity: progress,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [motion.contentRevealOffset, 0],
            }),
          },
        ],
      };

  return <Animated.View style={[style, animatedStyle as ViewStyle]}>{children}</Animated.View>;
}

export default ContentReveal;
