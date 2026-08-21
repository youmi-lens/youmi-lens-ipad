import { Tabs } from 'expo-router';
import { Easing, StyleSheet, View } from 'react-native';

import { AppBackground } from '@/components/AppBackground';
import { YLSidebar } from '@/components/YLSidebar';
import { motion, useReduceMotion } from '@/constants/motion';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors } from '@/constants/theme';

/**
 * @react-navigation/bottom-tabs keeps every tab screen mounted and drives a
 * real, native, overlapping opacity crossfade between the outgoing and
 * incoming screen via its own `animation`/`transitionSpec` options (see
 * BottomTabView.js: both routes' `tabAnims` values animate in the SAME
 * `Animated.parallel`, native driver, so this genuinely overlaps rather than
 * "instant swap then incoming animation"). This is the built-in mechanism —
 * not a custom reimplementation.
 *
 * It is applied ONLY to Record and Settings, deliberately NOT to Courses.
 * The `animation` option fades the ENTIRE scene container, with no way to
 * exempt a sub-tree — so turning it on for a screen that holds the Course
 * grid would put the grid's opacity in motion on every tab switch. Record
 * and Settings hold no such mutation-driven collection, so a whole-scene
 * fade is unconditionally safe there. Courses keeps its own, more surgical
 * V1/V2 treatment instead (ContentReveal on the heading only, PageShellTransition
 * — translate-only — on the shell including the grid): confirmed by reading
 * `hasAnimation()` in BottomTabView.js that when a screen's own `animation`
 * option is left at the default `'none'` (Courses, here), its scene
 * container's opacity is structurally never interpolated, in either
 * direction, regardless of what any other tab is configured to do.
 */
const CROSSFADE_TRANSITION_SPEC = {
  animation: 'timing' as const,
  config: {
    duration: motion.pageShellDuration,
    easing: Easing.out(Easing.cubic),
  },
};

/**
 * iPad split-view foundation: persistent 232pt sidebar with the existing
 * Record, Courses, and Settings routes rendered in the detail area.
 * On phone-width screens this collapses to a bottom tab bar instead.
 */
export default function TabLayout() {
  const isCompact = useIsCompactWidth();
  // bottom-tabs has no built-in Reduce Motion awareness — unlike ContentReveal
  // and PageShellTransition, which drop their own translation/opacity
  // internally, this scene-level crossfade has to be switched off from the
  // outside: 'none' resolves to a hard-coded 0ms transitionSpec (see
  // NAMED_TRANSITIONS_PRESETS.none in BottomTabView.js), so Reduce Motion
  // users get an instant route swap, never a delayed or partial one.
  const reduceMotion = useReduceMotion();
  const crossfadeAnimation = reduceMotion ? 'none' : 'fade';
  return (
    <View style={styles.root}>
      <AppBackground />
      <Tabs
        tabBar={(props) => <YLSidebar {...props} />}
        screenOptions={{
          headerShown: false,
          tabBarPosition: isCompact ? 'bottom' : 'left',
          sceneStyle: { backgroundColor: 'transparent' },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{ title: 'Record', animation: crossfadeAnimation, transitionSpec: CROSSFADE_TRANSITION_SPEC }}
        />
        <Tabs.Screen name="courses" options={{ title: 'Courses' }} />
        <Tabs.Screen
          name="settings"
          options={{ title: 'Settings', animation: crossfadeAnimation, transitionSpec: CROSSFADE_TRANSITION_SPEC }}
        />
      </Tabs>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
