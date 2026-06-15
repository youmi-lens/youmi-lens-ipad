import { StyleSheet, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

/**
 * Neutral off-white app background with very faint atmospheric brand hints.
 *
 * Drawn in a fixed iPad viewBox (`xMidYMid slice`) so the blob composition keeps
 * the reference look while scaling across split-view and portrait sizes.
 */
export function AppBackground() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 1194 834"
        preserveAspectRatio="xMidYMid slice"
      >
        <Defs>
          <LinearGradient id="app-bg" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#F8F9FC" />
            <Stop offset="0.42" stopColor="#F7F8FB" />
            <Stop offset="0.72" stopColor="#F4F5F8" />
            <Stop offset="1" stopColor="#F8F7FA" />
          </LinearGradient>
          <RadialGradient id="blob-blue" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#0B1F3A" stopOpacity={0.045} />
            <Stop offset="0.68" stopColor="#0B1F3A" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="blob-violet" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#685D7A" stopOpacity={0.035} />
            <Stop offset="0.7" stopColor="#685D7A" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="blob-teal" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#526B6B" stopOpacity={0.025} />
            <Stop offset="0.7" stopColor="#526B6B" stopOpacity={0} />
          </RadialGradient>
        </Defs>

        <Rect width="1194" height="834" fill="url(#app-bg)" />
        <Circle cx={540} cy={300} r={320} fill="url(#blob-blue)" />
        <Circle cx={900} cy={640} r={280} fill="url(#blob-violet)" />
        <Circle cx={560} cy={760} r={240} fill="url(#blob-teal)" />
      </Svg>
    </View>
  );
}

export default AppBackground;
