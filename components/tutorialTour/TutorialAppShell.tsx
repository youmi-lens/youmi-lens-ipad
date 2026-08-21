/**
 * The persistent frame every simulated tutorial screen renders inside.
 *
 * This is what makes the tour feel like Youmi Lens rather than a slideshow:
 * the real `AppBackground`, the real bottom-tab geometry, and a deliberately
 * slim tutorial chrome that never dominates the product UI (§11). The tab
 * bar appears only where the REAL app shows it (the `(tabs)` group), and its
 * active item follows the journey so the user builds spatial memory (§3).
 *
 * The simulated tab bar is a visual replica, not the real `YLSidebar` —
 * that component requires live react-navigation `BottomTabBarProps` and its
 * items call `navigation.navigate`, which the tour must never do. Geometry,
 * colours and typography are matched to YLSidebar's `BottomTabFrame`.
 */
import { Ionicons } from '@expo/vector-icons';
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppBackground } from '@/components/AppBackground';
import { LogoMark } from '@/components/BrandHeader';
import { isPad } from '@/constants/deviceClass';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors, fontSize, layout, radius, shadows, spacing } from '@/constants/theme';
import { useT } from '@/lib/i18n';

import { Emphasis } from './TourEmphasis';

type TabId = 'record' | 'courses' | 'settings';

const TABS: { id: TabId; icon: keyof typeof Ionicons.glyphMap; labelKey: string }[] = [
  { id: 'record', icon: 'mic-outline', labelKey: 'nav.record' },
  { id: 'courses', icon: 'library-outline', labelKey: 'nav.courses' },
  { id: 'settings', icon: 'settings-outline', labelKey: 'nav.settings' },
];

export function TutorialAppShell({
  activeTab,
  progress,
  total,
  label,
  canGoBack,
  isFinal,
  isAction,
  onNext,
  onBack,
  onSkip,
  children,
}: {
  /** null on screens the real app pushes as full-screen stack routes. */
  activeTab: TabId | null;
  progress: number;
  total: number;
  label: string;
  canGoBack: boolean;
  isFinal: boolean;
  /** Action moments advance by tapping their simulated control, so the coach
   * bar shows NO Next for them — one way forward per moment. */
  isAction: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const insets = useSafeAreaInsets();
  // Production's YLSidebar renders a LEFT SIDEBAR at wide widths and a bottom
  // tab bar when compact (`isCompact ? <BottomTabFrame/> : <SidebarFrame/>`).
  // An iPad in landscape therefore has no bottom bar at all — the simulated
  // navigation has to switch the same way or the tour teaches the wrong place.
  const isCompact = useIsCompactWidth();
  const showSidebar = Boolean(activeTab) && !isCompact;
  const showBottomBar = Boolean(activeTab) && isCompact;

  const body = (
    <>
      <AppBackground />

      {/* Slim top chrome — a thin progress rail and an unobtrusive Skip. */}
      <View style={[styles.topChrome, { paddingTop: insets.top + 8 }]}>
        <View style={styles.progressRail}>
          <View style={[styles.progressFill, { flex: Math.max(progress, 0.001) }]} />
          <View style={{ flex: Math.max(total - progress, 0.001) }} />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={t('tutorialTour.skip')} onPress={onSkip} hitSlop={12}>
          <Text style={styles.skipText}>{t('tutorialTour.skip')}</Text>
        </Pressable>
      </View>

      {/* The simulated screen. */}
      <View style={styles.stage}>{children}</View>

      {/* Contextual coach line: a short label plus a compact advance control.
          Deliberately a slim strip, never a large card centred over the UI. */}
      <View style={styles.coachBar}>
        {canGoBack ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('tutorialTour.back')} onPress={onBack} hitSlop={12} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={18} color={colors.textTertiary} />
          </Pressable>
        ) : (
          <View style={styles.backSpacer} />
        )}
        <Text style={styles.coachLabel} numberOfLines={2}>{label}</Text>
        {/* Explanation moments get a Next; action moments get none, because
            their highlighted simulated control is the way forward.
            When Next IS the way forward it is the moment's one primary target,
            so it wears the SAME accent ring the simulated controls wear — a
            first-time user should never have to guess where to tap. */}
        {isAction ? null : (
          <Emphasis active radiusOverride={radius.pill}>
            <Pressable accessibilityRole="button" onPress={onNext} style={styles.nextChip}>
              <Text style={styles.nextChipText}>
                {isFinal ? t('tutorialTour.readyCta') : t('tutorialTour.next')}
              </Text>
            </Pressable>
          </Emphasis>
        )}
      </View>

      {/* Simulated bottom tab bar — only at compact width, matching the real
          app, which uses the left sidebar instead once there is room. */}
      {showBottomBar ? (
        <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <View pointerEvents="none" style={styles.tint} />
          {TABS.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <View key={tab.id} style={styles.bottomTab}>
                {selected ? <View pointerEvents="none" style={styles.bottomTabActiveOverlay} /> : null}
                <Ionicons name={tab.icon} size={22} color={selected ? colors.accent : colors.textSecondary} />
                <Text numberOfLines={1} style={[styles.bottomTabLabel, selected && styles.bottomTabLabelActive]}>
                  {t(tab.labelKey)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : (
        <View style={{ height: Math.max(insets.bottom, 10) }} />
      )}
    </>
  );

  // At wide width the whole app sits BESIDE the sidebar, so the simulated
  // sidebar has to wrap the stage rather than sit under it.
  if (showSidebar) {
    return (
      <View style={styles.root}>
        <View style={styles.wideRow}>
          <SimulatedSidebar activeTab={activeTab} insets={insets} />
          <View style={styles.wideBody}>{body}</View>
        </View>
      </View>
    );
  }

  return <View style={styles.root}>{body}</View>;
}

/** Visual replica of YLSidebar's SidebarFrame — brand, nav rows with the
 * active bar/overlay, and the account card pinned to the bottom. Not the real
 * component: its rows call `navigation.navigate`, which the tour must never do,
 * and its account card reads the live session. Geometry is matched exactly. */
function SimulatedSidebar({
  activeTab,
  insets,
}: {
  activeTab: TabId | null;
  insets: { top: number; bottom: number };
}) {
  const t = useT();
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
        {TABS.map((tab) => {
          const selected = tab.id === activeTab;
          return (
            <View key={tab.id} style={styles.navRow}>
              {selected ? (
                <>
                  <View pointerEvents="none" style={styles.navRowActiveOverlay} />
                  <View pointerEvents="none" style={styles.activeBar} />
                </>
              ) : null}
              <Ionicons name={tab.icon} size={18} color={selected ? colors.accent : colors.textSecondary} />
              <Text style={[styles.navLabel, selected && styles.navLabelActive]}>{t(tab.labelKey)}</Text>
            </View>
          );
        })}
      </View>

      <View style={styles.sidebarSpacer} />

      <View style={styles.account}>
        <View style={styles.avatar}><Text style={styles.avatarText}>Y</Text></View>
        <View style={styles.accountText}>
          <Text numberOfLines={1} style={styles.accountName}>{t('sidebar.guest')}</Text>
          <Text numberOfLines={1} style={styles.accountSubtitle}>{t('sidebar.localRecordings')}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  wideRow: { flex: 1, flexDirection: 'row' },
  // A rotated iPhone has much less vertical room. Explicitly allowing this
  // flex child to shrink keeps the persistent coach/Next chrome in viewport
  // instead of letting a portrait-sized simulated screen push it below fold.
  wideBody: { flex: 1, minWidth: 0, minHeight: 0 },

  // ---- Simulated sidebar (mirrors YLSidebar's SidebarFrame) ----
  sidebar: {
    width: layout.sidebar,
    paddingHorizontal: 11,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.glassEdge,
    overflow: 'hidden',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 9, paddingBottom: spacing.xl },
  brandName: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  brandLight: { color: colors.textSecondary, fontWeight: '500' },
  navigation: { gap: 2 },
  navRow: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 11, borderRadius: 11,
  },
  navRowActiveOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.surfaceMuted,
    borderRadius: 11,
  },
  activeBar: {
    position: 'absolute', left: -11, top: 7, bottom: 7, width: 3,
    borderTopRightRadius: 3, borderBottomRightRadius: 3, backgroundColor: colors.navy,
  },
  navLabel: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  navLabelActive: { color: colors.accent },
  sidebarSpacer: { flex: 1 },
  account: {
    flexDirection: 'row', alignItems: 'center', gap: 9, padding: 8,
    borderRadius: radius.md, backgroundColor: colors.glass,
    borderWidth: 1, borderColor: colors.glassEdge,
    ...shadows.soft,
  },
  avatar: {
    width: 30, height: 30, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy,
  },
  avatarText: { color: colors.pearlWhite, fontSize: fontSize.xs, fontWeight: '800' },
  accountText: { flex: 1 },
  accountName: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  accountSubtitle: { color: colors.textSecondary, fontSize: 10.5, marginTop: 1 },

  topChrome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingBottom: 6,
  },
  progressRail: {
    flex: 1,
    flexDirection: 'row',
    height: 2.5,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  progressFill: { backgroundColor: colors.accent, borderRadius: 2 },
  skipText: { color: colors.textTertiary, fontSize: fontSize.sm, fontWeight: '700' },

  stage: { flex: 1, minHeight: 0 },

  coachBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: 10,
  },
  backBtn: { padding: 2 },
  backSpacer: { width: 4 },
  coachLabel: {
    flex: 1,
    color: colors.ink,
    fontSize: isPad ? 15 : 14,
    fontWeight: '700',
    lineHeight: 19,
  },
  nextChip: {
    backgroundColor: colors.navy,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: radius.pill,
  },
  nextChipText: { color: colors.textOnNavy, fontSize: 13, fontWeight: '700' },

  // ---- Simulated bottom tab bar (mirrors YLSidebar's BottomTabFrame) ----
  bottomBar: {
    flexDirection: 'row',
    width: '100%',
    paddingTop: 8,
    paddingHorizontal: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.glassEdge,
    backgroundColor: colors.pearlWhite,
  },
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255, 255, 255, 0.58)' },
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
  bottomTabLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  bottomTabLabelActive: { color: colors.accent },
});

export default TutorialAppShell;
