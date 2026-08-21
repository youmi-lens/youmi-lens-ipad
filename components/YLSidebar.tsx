import { Ionicons } from '@expo/vector-icons';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Href, useRouter } from 'expo-router';
import { ComponentProps, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/BrandHeader';
import { PressableScale } from '@/components/PressableScale';
import { motion } from '@/constants/motion';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors, fontSize, layout, radius, shadows, spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';

/**
 * Fades the selected-tab indicator (background tint / active bar / pill) in
 * or out over `motion.tabIndicatorDuration`. Deliberately separate from the
 * icon/label color, which stays an instant snap — the state change itself
 * (what's selected) must always be immediate; only the decorative indicator
 * eases. Starting a new `Animated.timing` on a value already mid-flight
 * interrupts it in place (standard RN Animated behavior), so rapid tab
 * switching can't stack animations — each tap just redirects the current one.
 */
function useSelectedIndicator(selected: boolean): Animated.Value {
  const progress = useRef(new Animated.Value(selected ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: selected ? 1 : 0,
      duration: motion.tabIndicatorDuration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, selected]);
  return progress;
}

type IconName = ComponentProps<typeof Ionicons>['name'];

const ICONS: Record<string, IconName> = {
  index: 'mic-outline',
  courses: 'library-outline',
  settings: 'settings-outline',
};

type SidebarItem = {
  key: string;
  icon: IconName;
  label: string;
  selected: boolean;
  onPress: () => void;
};

function SidebarNavRow({ item }: { item: SidebarItem }) {
  const indicator = useSelectedIndicator(item.selected);
  return (
    <PressableScale
      accessibilityRole="tab"
      accessibilityState={{ selected: item.selected }}
      accessibilityLabel={item.label}
      onPress={item.onPress}
      style={styles.navRow}
    >
      <Animated.View pointerEvents="none" style={[styles.navRowActiveOverlay, { opacity: indicator }]} />
      <Animated.View pointerEvents="none" style={[styles.activeBar, { opacity: indicator }]} />
      <Ionicons
        name={item.icon}
        size={18}
        color={item.selected ? colors.accent : colors.textSecondary}
      />
      <Text style={[styles.navLabel, item.selected && styles.navLabelActive]}>{item.label}</Text>
    </PressableScale>
  );
}

function SidebarFrame({ items }: { items: SidebarItem[] }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, username, isGuest } = useAuth();
  const t = useT();
  const accountName = isGuest ? t('sidebar.guest') : username ?? user?.email?.split('@')[0] ?? t('sidebar.account');
  const accountSubtitle = isGuest ? t('sidebar.localRecordings') : user?.email ?? t('sidebar.signedIn');
  const initials = accountName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <View style={[styles.sidebar, { paddingTop: Math.max(insets.top, 24), paddingBottom: Math.max(insets.bottom, 18) }]}>
      <View pointerEvents="none" style={styles.tint} />

      <View style={styles.brand}>
        <LogoMark size={28} />
        <Text style={styles.brandName}>
          Youmi <Text style={styles.brandLight}>Lens</Text>
        </Text>
      </View>

      <View style={styles.navigation}>
        {items.map((item) => <SidebarNavRow key={item.key} item={item} />)}
      </View>

      <View style={styles.spacer} />

      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('sidebar.openAccountSettings')}
        onPress={() => router.push('/settings')}
        style={styles.account}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials || 'U'}</Text>
        </View>
        <View style={styles.accountText}>
          <Text numberOfLines={1} style={styles.accountName}>{accountName}</Text>
          <Text numberOfLines={1} style={styles.accountSubtitle}>{accountSubtitle}</Text>
        </View>
      </PressableScale>
    </View>
  );
}

function BottomTabItem({ item }: { item: SidebarItem }) {
  const indicator = useSelectedIndicator(item.selected);
  return (
    <PressableScale
      accessibilityRole="tab"
      accessibilityState={{ selected: item.selected }}
      accessibilityLabel={item.label}
      onPress={item.onPress}
      style={styles.bottomTab}
    >
      <Animated.View pointerEvents="none" style={[styles.bottomTabActiveOverlay, { opacity: indicator }]} />
      <Ionicons
        name={item.icon}
        size={22}
        color={item.selected ? colors.accent : colors.textSecondary}
      />
      <Text
        numberOfLines={1}
        style={[styles.bottomTabLabel, item.selected && styles.navLabelActive]}
      >
        {item.label}
      </Text>
    </PressableScale>
  );
}

function BottomTabFrame({ items }: { items: SidebarItem[] }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <View pointerEvents="none" style={styles.tint} />
      {items.map((item) => <BottomTabItem key={item.key} item={item} />)}
    </View>
  );
}

export function YLSidebar({ state, descriptors, navigation }: BottomTabBarProps) {
  const t = useT();
  const isCompact = useIsCompactWidth();
  const items = state.routes.map((route, index) => {
    const selected = state.index === index;
    const options = descriptors[route.key].options;
    const label =
      route.name === 'index' ? t('nav.record') :
      route.name === 'courses' ? t('nav.courses') :
      route.name === 'settings' ? t('nav.settings') :
      typeof options.title === 'string' ? options.title : route.name;
    return {
      key: route.key,
      icon: ICONS[route.name] ?? 'ellipse-outline',
      label,
      selected,
      onPress: () => {
        const event = navigation.emit({
          type: 'tabPress',
          target: route.key,
          canPreventDefault: true,
        });
        if (!selected && !event.defaultPrevented) navigation.navigate(route.name);
      },
    };
  });
  return isCompact ? <BottomTabFrame items={items} /> : <SidebarFrame items={items} />;
}

export function WorkspaceSidebar({
  active = 'record',
}: {
  active?: 'record' | 'courses' | 'settings';
}) {
  const router = useRouter();
  const isCompact = useIsCompactWidth();
  const t = useT();
  if (isCompact) return null;

  const routes: {
    key: 'record' | 'courses' | 'settings';
    icon: IconName;
    label: string;
    href: Href;
  }[] = [
    { key: 'record', icon: 'mic-outline', label: t('nav.record'), href: '/' },
    { key: 'courses', icon: 'library-outline', label: t('nav.courses'), href: '/courses' },
    { key: 'settings', icon: 'settings-outline', label: t('nav.settings'), href: '/settings' },
  ];

  return (
    <SidebarFrame
      items={routes.map((route) => ({
        ...route,
        selected: active === route.key,
        onPress: () => router.replace(route.href),
      }))}
    />
  );
}

const styles = StyleSheet.create({
  sidebar: {
    width: layout.sidebar,
    paddingHorizontal: 11,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.glassEdge,
    overflow: 'hidden',
  },
  bottomBar: {
    flexDirection: 'row',
    width: '100%',
    paddingTop: 8,
    paddingHorizontal: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.glassEdge,
    backgroundColor: colors.pearlWhite,
  },
  bottomTab: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: 11,
  },
  bottomTabActiveOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.surfaceMuted,
    borderRadius: 11,
  },
  bottomTabLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  tint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.58)',
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
    // 44pt is the iOS minimum comfortable touch target; the sidebar's primary
    // navigation should not be the tightest hit area in the app.
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 11,
    borderRadius: 11,
  },
  // An absolutely-positioned sibling (not the row's own backgroundColor) so
  // its opacity can fade independently — the row itself never re-renders
  // just to change tint.
  navRowActiveOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.surfaceMuted,
    borderRadius: 11,
  },
  activeBar: {
    position: 'absolute',
    left: -11,
    top: 7,
    bottom: 7,
    width: 3,
    borderTopRightRadius: 3,
    borderBottomRightRadius: 3,
    backgroundColor: colors.navy,
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
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassEdge,
    ...shadows.soft,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.navy,
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
});

export default YLSidebar;
