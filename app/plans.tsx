/**
 * Plans / Upgrade screen.
 *
 * Lists the four subscription tiers, marks the local preview selection, and exposes a
 * Restore Purchases action. The actual "subscribe" call goes through the
 * PurchaseService abstraction in lib/purchases.ts — currently a local mock,
 * so this screen is fully usable in an Xcode-installed development build
 * without uploading anything to App Store Connect.
 *
 * TODO(subscriptions): once StoreKit is real, do not use local mock state as
 * plan truth. Fetch the backend effective plan from /api/quota/status, mark
 * that tier as current, and let Settings + Plans render from the same source.
 */
import { Ionicons } from '@expo/vector-icons';
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
import { Plan, PLANS, PlanId, planById, purchaseService } from '@/lib/purchases';

export default function PlansScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [mockPreviewPlan, setMockPreviewPlan] = useState<PlanId | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPlanId, setBusyPlanId] = useState<PlanId | null>(null);
  const [restoring, setRestoring] = useState(false);

  const loadActive = useCallback(async () => {
    setLoading(true);
    try {
      setMockPreviewPlan(await purchaseService.getActivePlan(userId));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadActive();
  }, [loadActive]);

  const handleSelectPlan = useCallback(
    async (planId: PlanId) => {
      if (planId === mockPreviewPlan) return;

      // Paid plans are not yet purchasable. They show as "Coming Soon" and tap
      // surfaces an informational notice instead of changing the active plan,
      // so this build never implies a real subscription was bought.
      if (planId !== 'free') {
        Alert.alert(
          'Coming Soon',
          'Apple in-app purchases are coming soon. Paid plans are previewed here so you can see what is planned — no real payment is processed in this build.',
        );
        return;
      }

      // Free remains switchable in mock mode for previewing the "current plan" indicator.
      setBusyPlanId(planId);
      const result = await purchaseService.purchase(userId, planId);
      setBusyPlanId(null);
      if (!result.ok) {
        Alert.alert('Could not switch plan', result.reason);
        return;
      }
      setMockPreviewPlan(result.planId);
      Alert.alert(
        'Switched to Free',
        'Test mode — your selection has been recorded locally on this device.',
      );
    },
    [mockPreviewPlan, userId],
  );

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    const result = await purchaseService.restore(userId);
    setRestoring(false);
    if (!result.ok) {
      Alert.alert('Restore unavailable', result.reason);
      return;
    }
    setMockPreviewPlan(result.planId);
    const planName = planById(result.planId).name;
    Alert.alert(
      'Restore Purchases',
      `Apple in-app purchases are not yet connected, so there is nothing to restore from the App Store. Locally remembered plan: ${planName}.`,
    );
  }, [userId]);

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
            {purchaseService.mode === 'mock' ? (
              <View style={styles.testNotice}>
                <Ionicons name="construct-outline" size={14} color={colors.deepNavy} />
                <Text style={styles.testNoticeText}>
                  Test mode — this screen is a local preview only. Your real plan and quota still
                  come from the backend Settings card.
                </Text>
              </View>
            ) : null}
          </View>

          {loading || mockPreviewPlan === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.deepNavy} />
            </View>
          ) : (
            <View style={styles.cards}>
              {PLANS.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  isMockActive={mockPreviewPlan === plan.id}
                  isBusy={busyPlanId === plan.id}
                  onSelect={() => void handleSelectPlan(plan.id)}
                />
              ))}
            </View>
          )}

          <View style={styles.restoreRow}>
            <SecondaryButton
              label="Restore Purchases"
              icon="refresh-outline"
              onPress={() => void handleRestore()}
              disabled={restoring}
              style={styles.restoreButton}
            />
            <Text style={styles.restoreNote}>
              Test mode — restore will activate when Apple in-app purchase is live. Until then, Settings remains the source of truth for your real plan.
            </Text>
          </View>

          <Text style={styles.footerNote}>
            Subscriptions auto-renew monthly unless canceled at least 24 hours before the end of the
            current period. You can manage or cancel a subscription in your iPad Settings → Apple ID
            → Subscriptions.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function PlanCard({
  plan,
  isMockActive,
  isBusy,
  onSelect,
}: {
  plan: Plan;
  isMockActive: boolean;
  isBusy: boolean;
  onSelect: () => void;
}) {
  return (
    <GlassCard style={StyleSheet.flatten([styles.planCard, isMockActive && styles.planCardActive])}>
      <View style={styles.planHeader}>
        <View style={styles.planNameBlock}>
          <View style={styles.planNameRow}>
            <Text style={styles.planName}>{plan.name}</Text>
            {isMockActive ? (
              <View style={styles.activeChip}>
                <Ionicons name="checkmark" size={12} color="#157A58" />
                <Text style={styles.activeChipText}>PREVIEW</Text>
              </View>
            ) : null}
          </View>
          {plan.blurb ? <Text style={styles.planBlurb}>{plan.blurb}</Text> : null}
        </View>
        <View style={styles.planPriceBlock}>
          <Text style={styles.planPrice}>{plan.priceLabel}</Text>
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

      {isMockActive ? (
        <Text style={styles.currentLine}>Preview selection only — real plan is shown in Settings.</Text>
      ) : plan.id === 'free' ? (
        <SecondaryButton
          label="Switch to Free"
          icon="arrow-down-outline"
          onPress={onSelect}
          disabled={isBusy}
          style={styles.planButton}
        />
      ) : (
        <PrimaryButton
          label={`Coming Soon — ${plan.priceLabel}/month`}
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

  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
});
