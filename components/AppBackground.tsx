import { StyleSheet, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

export function AppBackground() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
        <Defs>
          <LinearGradient id="app-bg" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#EEF2FC" />
            <Stop offset="0.4" stopColor="#F6F8FF" />
            <Stop offset="0.7" stopColor="#E8F0FA" />
            <Stop offset="1" stopColor="#F0EEF8" />
          </LinearGradient>
          <RadialGradient id="blue-glow">
            <Stop offset="0" stopColor="#6488E6" stopOpacity={0.18} />
            <Stop offset="1" stopColor="#6488E6" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="violet-glow">
            <Stop offset="0" stopColor="#8C64E6" stopOpacity={0.1} />
            <Stop offset="1" stopColor="#8C64E6" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="teal-glow">
            <Stop offset="0" stopColor="#3CB4C8" stopOpacity={0.12} />
            <Stop offset="1" stopColor="#3CB4C8" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#app-bg)" />
        <Circle cx="-4%" cy="-6%" r="48%" fill="url(#blue-glow)" />
        <Circle cx="96%" cy="88%" r="38%" fill="url(#violet-glow)" />
        <Circle cx="38%" cy="78%" r="28%" fill="url(#teal-glow)" />
      </Svg>
    </View>
  );
}

export default AppBackground;
