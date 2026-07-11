import { Ionicons } from '@expo/vector-icons';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Href, useRouter } from 'expo-router';
import { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/BrandHeader';
import { colors, fontSize, layout, radius, shadows, spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';

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
        {items.map((item) => (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={item.selected ? { selected: true } : {}}
              onPress={item.onPress}
              style={({ pressed }) => [
                styles.navRow,
                item.selected && styles.navRowActive,
                pressed && styles.pressed,
              ]}
            >
              {item.selected ? <View style={styles.activeBar} /> : null}
              <Ionicons
                name={item.icon}
                size={18}
                color={item.selected ? colors.accent : colors.textSecondary}
              />
              <Text style={[styles.navLabel, item.selected && styles.navLabelActive]}>{item.label}</Text>
            </Pressable>
        ))}
      </View>

      <View style={styles.spacer} />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('sidebar.openAccountSettings')}
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

export function YLSidebar({ state, descriptors, navigation }: BottomTabBarProps) {
  const t = useT();
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
  return <SidebarFrame items={items} />;
}

export function WorkspaceSidebar({
  active = 'record',
}: {
  active?: 'record' | 'courses' | 'settings';
}) {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const t = useT();
  if (width < 900) return null;

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
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 11,
    borderRadius: 11,
  },
  navRowActive: {
    backgroundColor: colors.surfaceMuted,
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
  pressed: {
    opacity: 0.78,
  },
});

export default YLSidebar;
