import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';

import { motion, useReduceMotion } from '@/constants/motion';

/**
 * A translate-only page-shell settle — this NEVER touches opacity, on
 * purpose, and that is the whole point of its existence.
 *
 * ContentReveal (opacity + translateY) is deliberately off-limits for any
 * container that holds a dynamic, mutation-driven collection: Course
 * create/delete/remount/native reattachment could reset that wrapper's
 * opacity to 0, and the entire grid would disappear until reload. That
 * regression is why this component exists — it lets the WHOLE page shell
 * (heading + the dynamic body below it) settle into place together as one
 * movement, without ever putting the dynamic content through an
 * invisible-until-driven state. Worst case if this animation is interrupted
 * or misbehaves: content sits a few pixels offset. It can never disappear.
 *
 * Use ContentReveal for small, purely-static content (a heading) where the
 * extra opacity polish is safe. Use PageShellTransition for the container
 * that wraps that heading AND whatever dynamic content follows it, so both
 * move in the same synchronized settle instead of feeling disconnected.
 *
 * Runs on the native driver, so it costs nothing on the JS thread.
 */
export function PageShellTransition({
  children,
  style,
  /** Re-runs the settle when this changes — e.g. a tab-focus counter. */
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
      duration: motion.pageShellDuration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      // Cancel rather than stack when the settle re-runs (rapid tab
      // switching). Since opacity is never part of this animation, freezing
      // mid-flight can only ever strand content at a small translate offset
      // — settling explicitly at 0 still avoids even that residue.
      animation.stop();
      progress.setValue(1);
    };
  }, [progress, reduceMotion, revealKey]);

  const animatedStyle = reduceMotion
    ? null
    : {
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [motion.pageShellOffset, 0],
            }),
          },
        ],
      };

  return <Animated.View style={[style, animatedStyle as ViewStyle]}>{children}</Animated.View>;
}

export default PageShellTransition;
