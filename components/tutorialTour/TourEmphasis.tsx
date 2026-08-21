/**
 * Contextual emphasis primitives for the integrated simulated tutorial.
 *
 * Deliberately NOT a spotlight/cutout system. There is no scrim, no hole, no
 * measured target rect, no instruction bubble anchored to a rectangle. The
 * whole simulated screen always stays readable — attention is directed by
 * raising the active control's contrast (a soft accent glow + border tint,
 * with an optional gentle pulse) and by *slightly* lowering the emphasis of
 * surrounding content, never by hiding it.
 *
 * All motion is Reduced-Motion-safe: with Reduce Motion on, the emphasised
 * state is applied statically and instantly — nothing is ever hidden behind
 * an animation that must complete.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius } from '@/constants/theme';
import { useReduceMotion } from '@/constants/motion';
import { useTutorialTour } from '@/lib/tutorialTour';

/**
 * Raises a control's prominence while it is the current teaching moment.
 * `radiusOverride` lets a caller match the wrapped control's own corner
 * radius so the glow traces the real shape rather than a generic box.
 */
export function Emphasis({
  active,
  children,
  style,
  radiusOverride,
}: {
  active: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  radiusOverride?: number;
}) {
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    if (!active) {
      pulse.setValue(0);
      return;
    }
    if (reduceMotion) {
      // Static emphasised state — full contrast, no breathing.
      pulse.setValue(1);
      return;
    }
    pulse.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [active, reduceMotion, pulse]);

  const glowRadius = radiusOverride ?? radius.lg;

  return (
    <View style={[styles.wrap, style]}>
      {active ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.glow,
            { borderRadius: glowRadius + 4, opacity: pulse },
          ]}
        />
      ) : null}
      {children}
    </View>
  );
}

/**
 * An emphasised control that IS the way forward.
 *
 * On an action moment the user taps this simulated control — the same one they
 * would tap in the real app — and the tour advances. There is no competing
 * Next button for those moments, so the interaction is unambiguous: the thing
 * that is glowing is the thing to press.
 *
 * The capture overlay only exists while this is the live target, so a control
 * left mounted from an earlier moment cannot be pressed, and
 * `advanceFromTarget` re-checks the moment id — a stale tap can never advance
 * the wrong step.
 */
export function ActionTarget({
  momentId,
  active,
  children,
  style,
  targetStyle,
  radiusOverride,
  accessibilityLabel,
  onPress,
}: {
  momentId: string;
  active: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  targetStyle?: StyleProp<ViewStyle>;
  radiusOverride?: number;
  accessibilityLabel?: string;
  /** Overrides the default advance for targets whose tap must ALSO change
   * simulated state — a review tab both selects itself and advances. */
  onPress?: () => void;
}) {
  const { advanceFromTarget } = useTutorialTour();
  const [pressed, setPressed] = useState(false);

  // The tap is captured by a transparent overlay ON TOP of the simulated
  // control rather than by wrapping it. Production buttons (PrimaryButton,
  // CourseCard, …) contain their own enabled Pressable with no onPress, and
  // an enabled Pressable becomes the touch responder and swallows the press —
  // so a wrapper would never see it. The overlay exists only while this is
  // the live target, so an inactive control stays completely inert.
  return (
    <Emphasis active={active} style={style} radiusOverride={radiusOverride}>
      <View style={[targetStyle, pressed && styles.targetPressed]}>
        {children}
        {active ? (
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            onPressIn={() => setPressed(true)}
            onPressOut={() => setPressed(false)}
            onPress={() => (onPress ? onPress() : advanceFromTarget(momentId))}
          />
        ) : null}
      </View>
    </Emphasis>
  );
}

/**
 * Slightly de-emphasises surrounding context while another element is being
 * taught. Never drops below a clearly-readable opacity — the surrounding UI
 * is educational context, not noise to be hidden (§1/§4).
 */
export function SoftDim({
  active,
  children,
  style,
}: {
  active: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[style, active && styles.softDim]}>{children}</View>;
}

/** A small tap ripple used to demonstrate a gesture (e.g. the double-tap
 * dictionary lookup) without any pointer-blocking layer. */
export function TapPulse({ active, style }: { active: boolean; style?: StyleProp<ViewStyle> }) {
  const reduceMotion = useReduceMotion();
  const scale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active || reduceMotion) {
      scale.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.delay(220),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      scale.setValue(0);
    };
  }, [active, reduceMotion, scale]);

  if (!active || reduceMotion) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.tapPulse,
        style,
        {
          opacity: scale.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
          transform: [{ scale: scale.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.9] }) }],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  // `justifyContent: center` keeps the wrapper from stretching a fixed-size
  // child (a round Pause button, a pill) to the row's full height, which is
  // what made the glow trace the wrapper instead of the control it marks.
  wrap: { position: 'relative', justifyContent: 'center' },
  glow: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: 'rgba(11, 31, 58, 0.05)',
  },
  // Readable, not hidden — surrounding context still teaches "where am I".
  softDim: { opacity: 0.55 },
  // Press feedback for an action target. The capture overlay is transparent,
  // so the feel has to come from the content it sits on.
  targetPressed: { transform: [{ scale: 0.97 }], opacity: 0.92 },
  tapPulse: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accent,
  },
});
