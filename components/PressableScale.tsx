import { ComponentProps, ReactNode, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleProp, ViewStyle } from 'react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PressableScaleProps = Omit<ComponentProps<typeof Pressable>, 'style' | 'children'> & {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Resting → pressed scale. Lower = more pronounced press. */
  scaleTo?: number;
  /** Resting → pressed opacity. */
  opacityTo?: number;
  /**
   * Extra style applied only while pressed.
   *
   * For flat list rows, a background tint is the native affordance a scale
   * cannot stand in for — a full-width row that shrinks reads as the list
   * flexing. This exists so those rows can share this primitive instead of
   * forking a second press system; it is not a general-purpose escape hatch.
   */
  pressedStyle?: StyleProp<ViewStyle>;
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
  scaleTo = 0.98,
  opacityTo = 0.94,
  pressedStyle,
  disabled = false,
  onPressIn,
  onPressOut,
  ...rest
}: PressableScaleProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  // Only tracked when a caller actually needs a pressed style, so the common
  // case still re-renders zero times per press.
  const [pressed, setPressed] = useState(false);

  const animatedStyle = { transform: [{ scale }], opacity } as unknown as ViewStyle;

  return (
    <AnimatedPressable
      disabled={disabled}
      onPressIn={(event) => {
        if (!disabled) {
          if (pressedStyle) setPressed(true);
          scale.stopAnimation();
          opacity.stopAnimation();
          Animated.parallel([
            Animated.timing(scale, { toValue: scaleTo, duration: 70, easing: Easing.out(Easing.quad), useNativeDriver: true }),
            Animated.timing(opacity, { toValue: opacityTo, duration: 70, useNativeDriver: true }),
          ]).start();
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (!disabled) {
          if (pressedStyle) setPressed(false);
          scale.stopAnimation();
          opacity.stopAnimation();
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 1, duration: 130, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          ]).start();
        }
        onPressOut?.(event);
      }}
      style={[style, disabled ? null : animatedStyle, pressed && !disabled ? pressedStyle : null]}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}

export default PressableScale;
