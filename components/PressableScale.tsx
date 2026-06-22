import { ComponentProps, ReactNode, useRef } from 'react';
import { Animated, Pressable, StyleProp, ViewStyle } from 'react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PressableScaleProps = Omit<ComponentProps<typeof Pressable>, 'style' | 'children'> & {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Resting → pressed scale. Lower = more pronounced press. */
  scaleTo?: number;
  /** Resting → pressed opacity. */
  opacityTo?: number;
};

/**
 * A Pressable with an Apple-like soft press: a quick spring scale-down + a gentle
 * opacity dip on press-in, and a softly-sprung release. Built on RN's core
 * Animated with the native driver — no dependencies, runs off the JS thread.
 *
 * This is purely tactile: it never changes a component's resting size, layout, or
 * colour. Disabled buttons do not animate and keep the caller's resting style, so
 * a disabled control stays visually stable and clearly non-interactive.
 */
export function PressableScale({
  children,
  style,
  scaleTo = 0.96,
  opacityTo = 0.9,
  disabled = false,
  onPressIn,
  onPressOut,
  ...rest
}: PressableScaleProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const animatedStyle = { transform: [{ scale }], opacity } as unknown as ViewStyle;

  return (
    <AnimatedPressable
      disabled={disabled}
      onPressIn={(event) => {
        if (!disabled) {
          Animated.parallel([
            Animated.spring(scale, { toValue: scaleTo, useNativeDriver: true, speed: 50, bounciness: 0 }),
            Animated.timing(opacity, { toValue: opacityTo, duration: 90, useNativeDriver: true }),
          ]).start();
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (!disabled) {
          Animated.parallel([
            Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 38, bounciness: 6 }),
            Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }),
          ]).start();
        }
        onPressOut?.(event);
      }}
      style={[style, disabled ? null : animatedStyle]}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}

export default PressableScale;
