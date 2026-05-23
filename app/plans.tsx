/**
 * Plans / Upgrade screen.
 *
 * Lists the four subscription tiers, marks the active selection, and exposes a
 * Restore Purchases action. The actual "subscribe" call goes through the
 * PurchaseService abstraction in lib/purchases.ts.
 *
 * Two modes:
 *  - Mock (default) — preserves the legacy preview/Coming-Soon behavior so the
 *    app stays usable in Xcode-installed builds without going through Apple.
 *  - Real (when `EXPO_PUBLIC_USE_REAL_IAP=true`) — fetches localized App Store
 *    prices, drives the system purchase sheet, and lets Restore replay any
 *    prior subscription. The user's effective plan is still rendered from the
 *    backend `/api/quota/status` on the Settings card; backend receipt
 *    verification is a separate (Phase 2) task.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { colors, fontSize, layout, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import {
  LocalizedPrices,
  Plan,
  PLANS,
  PlanId,
  planById,
  purchaseService,
  PurchaseResult,
} from '@/lib/purchases';

/**
 * Standard Apple EULA. App Store Connect uses this by default unless a custom
 * EULA is uploaded; both are acceptable for Review.
 */
const TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
/**
 * Public-facing privacy policy. docs/privacy-policy.md is the source; this
 * placeholder URL must be replaced with the live hosted copy before submission.
 */
const PRIVACY_URL = 'https://youmilens.app/privacy';

export default function PlansScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const isRealMode = purchaseService.mode === 'real';

  const [activePlan, setActivePlan] = useState<PlanId | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPlanId, setBusyPlanId] = useState<PlanId | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [localizedPrices, setLocalizedPrices] = useState<LocalizedPrices>({});

  const loadActive = useCallback(async () => {
    setLoading(true);
    try {
      setActivePlan(await purchaseService.getActivePlan(userId));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadActive();
  }, [loadActive]);

  // In real mode, fetch App Store-localized prices once. Failures are silent;
  // the cards fall back to the hardcoded `priceLabel` from the catalog.
  useEffect(() => {
    if (!purchaseService.getLocalizedPrices) return;
    let cancelled = false;
    purchaseService
      .getLocalizedPrices()
      .then((prices) => {
        if (!cancelled) setLocalizedPrices(prices);
      })
      .catch(() => {
        /* fall back to catalog priceLabel */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectPlan = useCallback(
    async (planId: PlanId) => {
      if (__DEV__) console.log('[Plans] select plan', planId);
      if (planId === activePlan) return;

      // Mock mode preserves the legacy "Coming Soon" behavior for paid tiers so
      // the dev build never implies a real subscription was bought.
      if (!isRealMode && planId !== 'free') {
        Alert.alert(
          'Coming Soon',
          'Apple in-app purchases are coming soon. Paid plans are previewed here so you can see what is planned — no real payment is processed in this build.',
        );
        return;
      }

      if (__DEV__) console.log('[Plans] busyPlanId set', planId);
      setBusyPlanId(planId);
      // try/finally is mandatory here — without it, any thrown exception
      // between setBusyPlanId(planId) and the explicit clear leaves the
      // button stuck on "Processing…" forever.
      let result: PurchaseResult;
      try {
        result = await purchaseService.purchase(userId, planId);
      } finally {
        if (__DEV__) console.log('[Plans] clearing busyPlanId');
        setBusyPlanId(null);
      }

      if (!result.ok) {
        // Silently swallow a user-initiated cancel: showing an "error" alert
        // when the user themselves dismissed the sheet is App Review-unfriendly.
        if (result.canceled) return;
        Alert.alert('Could not switch plan', result.reason);
        return;
      }

      if (!isRealMode) {
        // Mock-only: switching to Free updates the preview indicator locally.
        setActivePlan(result.planId);
        Alert.alert(
          'Switched to Free',
          'Test mode — your selection has been recorded locally on this device.',
        );
        return;
      }

      // Real mode: the App Store accepted the subscription. The service
      // already resolved the planId; we use it for the CURRENT chip in
      // Plans. We intentionally do NOT mark the user's effective plan as
      // paid in any backend state — Settings reflects entitlement through
      // /api/quota/status after Phase 2 receipt validation.
      setActivePlan(result.planId);

      if (result.pendingAppleSync) {
        // Local-fallback success: the StoreKit sheet completed but Apple's
        // active-subscription query did not reflect the new product within
        // our poll window. Soften the alert wording and skip the extra
        // active-set refresh (it would just re-show the old tier).
        if (__DEV__) console.log('[Plans] purchase pending Apple sync');
        Alert.alert(
          'Purchase completed',
          'Apple subscription status may take a moment to update. Your Settings quota will update after server verification.',
        );
        return;
      }

      // Belt-and-suspenders refresh in case StoreKit's active set caught up
      // after the listener fired.
      void purchaseService
        .getActivePlan(userId)
        .then((latest) => setActivePlan(latest))
        .catch(() => {
          /* keep the resolver's planId */
        });

      const planName = planById(result.planId).name;
      Alert.alert(
        'Purchase complete',
        `Thanks for subscribing to ${planName}. Your plan will update in Settings once it is verified with our servers.`,
      );
    },
    [activePlan, isRealMode, userId],
  );

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    let result: Awaited<ReturnType<typeof purchaseService.restore>>;
    try {
      result = await purchaseService.restore(userId);
    } finally {
      setRestoring(false);
    }
    if (!result.ok) {
      Alert.alert('Restore unavailable', result.reason);
      return;
    }

    if (!isRealMode) {
      setActivePlan(result.planId);
      const planName = planById(result.planId).name;
      Alert.alert(
        'Restore Purchases',
        `Apple in-app purchases are not yet connected, so there is nothing to restore from the App Store. Locally remembered plan: ${planName}.`,
      );
      return;
    }

    // Real mode: keep the screen indicator in sync with what Apple reports.
    setActivePlan(result.planId);
    if (result.planId === 'free') {
      Alert.alert(
        'Nothing to restore',
        'No active Youmi Lens subscription was found on this Apple ID.',
      );
    } else {
      const planName = planById(result.planId).name;
      Alert.alert(
        'Purchases restored',
        `Your ${planName} subscription was found on this Apple ID. Your plan will update in Settings once it is verified with our servers.`,
      );
    }
  }, [isRealMode, userId]);

  const openExternal = useCallback((url: string) => {
    Linking.openURL(url).catch(() => {
      Alert.alert('Could not open link', 'Please try again later.');
    });
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={24} color={colors.deepNavy} />
        </Pressable>
        <Text style={styles.headerTitle}>Plans</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.heroBlock}>
            <Text style={styles.heroTitle}>Choose the plan that fits how you study</Text>
            <Text style={styles.heroSubtitle}>
              Plans are designed around monthly recording time, transcripts, summaries, and
              cloud-backed lecture history.
            </Text>
            {!isRealMode ? (
              <View style={styles.testNotice}>
                <Ionicons name="construct-outline" size={14} color={colors.deepNavy} />
                <Text style={styles.testNoticeText}>
                  Test mode — this screen is a local preview only. Your real plan and quota still
                  come from the backend Settings card.
                </Text>
              </View>
            ) : null}
          </View>

          {loading || activePlan === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.deepNavy} />
            </View>
          ) : (
            <View style={styles.cards}>
              {PLANS.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  isActive={activePlan === plan.id}
                  isBusy={busyPlanId === plan.id}
                  isRealMode={isRealMode}
                  displayPrice={localizedPrices[plan.id] ?? plan.priceLabel}
                  onSelect={() => void handleSelectPlan(plan.id)}
                />
              ))}
            </View>
          )}

          <View style={styles.restoreRow}>
            <SecondaryButton
              label={restoring ? 'Restoring…' : 'Restore Purchases'}
              icon="refresh-outline"
              onPress={() => void handleRestore()}
              disabled={restoring}
              style={styles.restoreButton}
            />
            {!isRealMode ? (
              <Text style={styles.restoreNote}>
                Test mode — restore will activate when Apple in-app purchase is live. Until then, Settings remains the source of truth for your real plan.
              </Text>
            ) : null}
          </View>

          <Text style={styles.footerNote}>
            Subscriptions auto-renew monthly unless canceled at least 24 hours before the end of the
            current period. You can manage or cancel a subscription in your iPad Settings → Apple ID
            → Subscriptions.
          </Text>

          <View style={styles.legalRow}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Terms of Use"
              onPress={() => openExternal(TERMS_URL)}
              hitSlop={8}
            >
              <Text style={styles.legalLink}>Terms of Use (EULA)</Text>
            </Pressable>
            <Text style={styles.legalSeparator}>·</Text>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Privacy Policy"
              onPress={() => openExternal(PRIVACY_URL)}
              hitSlop={8}
            >
              <Text style={styles.legalLink}>Privacy Policy</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function PlanCard({
  plan,
  isActive,
  isBusy,
  isRealMode,
  displayPrice,
  onSelect,
}: {
  plan: Plan;
  isActive: boolean;
  isBusy: boolean;
  isRealMode: boolean;
  displayPrice: string;
  onSelect: () => void;
}) {
  const activeChipLabel = isRealMode ? 'CURRENT' : 'PREVIEW';
  return (
    <GlassCard style={StyleSheet.flatten([styles.planCard, isActive && styles.planCardActive])}>
      <View style={styles.planHeader}>
        <View style={styles.planNameBlock}>
          <View style={styles.planNameRow}>
            <Text style={styles.planName}>{plan.name}</Text>
            {isActive ? (
              <View style={styles.activeChip}>
                <Ionicons name="checkmark" size={12} color="#157A58" />
                <Text style={styles.activeChipText}>{activeChipLabel}</Text>
              </View>
            ) : null}
          </View>
          {plan.blurb ? <Text style={styles.planBlurb}>{plan.blurb}</Text> : null}
        </View>
        <View style={styles.planPriceBlock}>
          <Text style={styles.planPrice}>{displayPrice}</Text>
          {plan.id !== 'free' ? <Text style={styles.planPriceCadence}>/month</Text> : null}
        </View>
      </View>

      <View style={styles.planFeatureList}>
        {plan.features.map((feature) => (
          <View key={feature} style={styles.planFeatureRow}>
            <Ionicons name="checkmark-circle" size={16} color={colors.success} />
            <Text style={styles.planFeatureText}>{feature}</Text>
          </View>
        ))}
      </View>

      {isActive ? (
        <Text style={styles.currentLine}>
          {isRealMode
            ? 'Current subscription on this Apple ID.'
            : 'Preview selection only — real plan is shown in Settings.'}
        </Text>
      ) : plan.id === 'free' ? (
        <SecondaryButton
          label="Switch to Free"
          icon="arrow-down-outline"
          onPress={onSelect}
          disabled={isBusy}
          style={styles.planButton}
        />
      ) : isRealMode ? (
        <PrimaryButton
          label={isBusy ? 'Processing…' : `Subscribe — ${displayPrice}/month`}
          icon="diamond-outline"
          onPress={onSelect}
          disabled={isBusy}
          style={styles.planButton}
        />
      ) : (
        <PrimaryButton
          label={`Coming Soon — ${displayPrice}/month`}
          icon="time-outline"
          onPress={onSelect}
          style={styles.planButton}
        />
      )}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.textPrimary },
  headerSpacer: { width: 44, height: 44 },
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxxl },
  content: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: spacing.xl },

  // ---- Hero ----
  heroBlock: { gap: spacing.sm },
  heroTitle: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  heroSubtitle: {
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.5,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  testNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    backgroundColor: colors.iceTint,
    borderWidth: 1,
    borderColor: colors.iceBlue,
  },
  testNoticeText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.5,
    color: colors.deepNavy,
    fontWeight: '600',
  },

  // ---- Loading ----
  loading: { paddingVertical: spacing.xxxl, alignItems: 'center' },

  // ---- Plan card list ----
  cards: { gap: spacing.lg },

  // ---- Plan card ----
  planCard: { gap: spacing.lg },
  planCardActive: { borderWidth: 2, borderColor: colors.deepNavy },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  planNameBlock: { flex: 1, gap: spacing.xs },
  planNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planName: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  planBlurb: {
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.45,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  activeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.successTint,
  },
  activeChipText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    color: '#157A58',
  },
  planPriceBlock: { alignItems: 'flex-end' },
  planPrice: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.textPrimary, letterSpacing: -0.3 },
  planPriceCadence: { fontSize: fontSize.xs, fontWeight: '600', color: colors.textTertiary },

  planFeatureList: { gap: spacing.sm },
  planFeatureRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planFeatureText: { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '500' },

  planButton: { alignSelf: 'stretch' },
  currentLine: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '600',
    textAlign: 'center',
  },

  // ---- Restore + footer ----
  restoreRow: { alignItems: 'center', gap: spacing.xs },
  restoreButton: { alignSelf: 'center' },
  restoreNote: { fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: '600' },
  footerNote: {
    fontSize: fontSize.xs,
    lineHeight: fontSize.xs * 1.5,
    color: colors.textTertiary,
    fontWeight: '500',
    textAlign: 'center',
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  legalLink: {
    fontSize: fontSize.xs,
    color: colors.deepNavy,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  legalSeparator: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
    fontWeight: '700',
  },

  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
});
