import { Ionicons } from '@expo/vector-icons';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/BrandHeader';
import { colors, fontSize, layout, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';

type IconName = ComponentProps<typeof Ionicons>['name'];

const ICONS: Record<string, IconName> = {
  index: 'mic-outline',
  courses: 'library-outline',
  settings: 'settings-outline',
};

export function YLSidebar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, username, isGuest } = useAuth();
  const accountName = isGuest ? 'Guest' : username ?? user?.email?.split('@')[0] ?? 'Account';
  const accountSubtitle = isGuest ? 'Local recordings' : user?.email ?? 'Signed in';
  const initials = accountName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <View style={[styles.sidebar, { paddingTop: Math.max(insets.top, 24), paddingBottom: Math.max(insets.bottom, 18) }]}>
      <BlurView intensity={42} tint="light" style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={styles.tint} />

      <View style={styles.brand}>
        <LogoMark size={28} />
        <Text style={styles.brandName}>
          Youmi <Text style={styles.brandLight}>Lens</Text>
        </Text>
      </View>

      <View style={styles.navigation}>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const options = descriptors[route.key].options;
          const label = typeof options.title === 'string' ? options.title : route.name;
          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };

          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={focused ? { selected: true } : {}}
              onPress={onPress}
              style={({ pressed }) => [
                styles.navRow,
                focused && styles.navRowActive,
                pressed && styles.pressed,
              ]}
            >
              {focused ? <View style={styles.activeBar} /> : null}
              <Ionicons
                name={ICONS[route.name] ?? 'ellipse-outline'}
                size={18}
                color={focused ? colors.accent : colors.textSecondary}
              />
              <Text style={[styles.navLabel, focused && styles.navLabelActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.spacer} />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open account settings"
        onPress={() => router.push('/settings')}
        style={({ pressed }) => [styles.account, pressed && styles.pressed]}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials || 'U'}</Text>
        </View>
        <View style={styles.accountText}>
          <Text numberOfLines={1} style={styles.accountName}>{accountName}</Text>
          <Text numberOfLines={1} style={styles.accountSubtitle}>{accountSubtitle}</Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sidebar: {
    width: layout.sidebar,
    paddingHorizontal: 11,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
    overflow: 'hidden',
  },
  tint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 9,
    paddingBottom: spacing.xl,
  },
  brandName: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  brandLight: {
    color: colors.textSecondary,
    fontWeight: '500',
  },
  navigation: {
    gap: 2,
  },
  navRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 11,
    borderRadius: 11,
  },
  navRowActive: {
    backgroundColor: 'rgba(29, 62, 138, 0.10)',
  },
  activeBar: {
    position: 'absolute',
    left: -11,
    top: 7,
    bottom: 7,
    width: 3,
    borderTopRightRadius: 3,
    borderBottomRightRadius: 3,
    backgroundColor: colors.accentBright,
  },
  navLabel: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  navLabelActive: {
    color: colors.accent,
  },
  spacer: {
    flex: 1,
  },
  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    padding: 8,
    borderRadius: radius.md,
    backgroundColor: 'rgba(29, 62, 138, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(29, 62, 138, 0.15)',
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  avatarText: {
    color: colors.pearlWhite,
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  accountText: {
    flex: 1,
  },
  accountName: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  accountSubtitle: {
    color: colors.textSecondary,
    fontSize: 10.5,
    marginTop: 1,
  },
  pressed: {
    opacity: 0.78,
  },
});

export default YLSidebar;
