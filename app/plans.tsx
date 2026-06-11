import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { SecondaryButton } from '@/components/SecondaryButton';
import { colors, fontSize, layout, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { fetchPlanStatus, PlanStatus, safeAccessLabel } from '@/lib/planStatus';
import {
  purchaseService,
  restoreMessageForCode,
  shouldShowPurchaseEntry,
  STUDENT_PASS_PRODUCT_ID,
  type RestoreResult,
  type StudentPassProduct,
} from '@/lib/purchases';

type BusyAction = 'purchase' | 'restore' | null;

export default function PlansScreen() {
  const router = useRouter();
  const { session, isGuest, exitGuest } = useAuth();
  const accessToken = session?.access_token ?? null;

  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
  const [product, setProduct] = useState<StudentPassProduct | null>(null);
  const [productLoading, setProductLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);

  const loadStatus = useCallback(async () => {
    if (!accessToken) {
      setPlanStatus(null);
      setStatusLoading(false);
      return;
    }
    setStatusLoading(true);
    setError(null);
    try {
      setPlanStatus(await fetchPlanStatus(accessToken));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account status is unavailable.');
    } finally {
      setStatusLoading(false);
    }
  }, [accessToken]);

  const loadProduct = useCallback(async () => {
    setProductLoading(true);
    try {
      setProduct(await purchaseService.getStudentPassProduct());
    } catch {
      setProduct(null);
    } finally {
      setProductLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProduct();
    return () => purchaseService.cleanup();
  }, [loadProduct]);

  useFocusEffect(
    useCallback(() => {
      void loadStatus();
    }, [loadStatus]),
  );

  const activeEntitlement = planStatus?.entitlement?.active ? planStatus.entitlement : null;
  const purchaseVisible = shouldShowPurchaseEntry(planStatus);
  const purchaseDisabled =
    isGuest || !accessToken || !purchaseVisible || productLoading || !product || busy !== null;

  const currentPlan = safeAccessLabel(planStatus?.planType, planStatus?.displayName);

  const quotaLines = useMemo(
    () => [
      ['Monthly minutes', formatNumber(planStatus?.minutesLimit, 'min')],
      ['Daily minutes', formatNumber(planStatus?.dailyMinutesLimit, 'min')],
      ['Recording length', formatNumber(planStatus?.maxRecordingMinutes, 'min')],
      ['Live session length', formatNumber(planStatus?.maxLiveSessionMinutes, 'min')],
      ['Recordings per day', formatNumber(planStatus?.maxRecordingsPerDay, 'recordings')],
      ['Processing jobs per day', formatNumber(planStatus?.maxProcessingJobsPerDay, 'jobs')],
    ],
    [planStatus],
  );

  const handleSignIn = async () => {
    await exitGuest();
    router.replace('/auth');
  };

  const handlePurchase = async () => {
    if (isGuest || !accessToken) {
      Alert.alert('Sign in required', 'Sign in before purchasing Student Basic.');
      return;
    }
    setBusy('purchase');
    setRestoreResult(null);
    try {
      const result = await purchaseService.purchaseStudentPass(accessToken);
      await loadStatus();
      if (result.ok) {
        Alert.alert('Student Basic active', result.message);
      } else {
        Alert.alert('Purchase not completed', result.message);
      }
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    if (isGuest || !accessToken) {
      Alert.alert('Sign in required', 'Sign in to refresh your purchase status.');
      return;
    }
    setBusy('restore');
    try {
      const result = await purchaseService.restoreStudentPass(accessToken);
      setRestoreResult(result);
      await loadStatus();
      Alert.alert(result.ok ? 'Access refreshed' : 'Access status', result.message);
    } finally {
      setBusy(null);
    }
  };

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
        <Text style={styles.headerTitle}>Student Basic</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.heroBlock}>
            <Text style={styles.heroTitle}>Youmi Lens Student Basic</Text>
            <Text style={styles.heroSubtitle}>30 days of Student Basic access.</Text>
            <Text style={styles.heroFinePrint}>One-time payment. Does not renew automatically.</Text>
          </View>

          {statusLoading && !planStatus ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.deepNavy} />
            </View>
          ) : error ? (
            <ErrorCard message={error} onRetry={() => void loadStatus()} />
          ) : (
            <>
              <GlassCard style={styles.card}>
                <Text style={styles.cardTitle}>Current plan</Text>
                <View style={styles.statusRow}>
                  <Text style={styles.statusName}>{currentPlan}</Text>
                  <View style={styles.activePill}>
                    <Ionicons name="checkmark" size={12} color="#157A58" />
                    <Text style={styles.activePillText}>ACTIVE</Text>
                  </View>
                </View>
                <LimitLine
                  label="Student Basic status"
                  value={activeEntitlement ? 'Active' : 'Not active'}
                />
                <LimitLine
                  label="Student Basic expiry"
                  value={formatDate(activeEntitlement?.expiresAt)}
                />
              </GlassCard>

              <GlassCard style={styles.card}>
                <Text style={styles.cardTitle}>Current Free plan usage remaining</Text>
                <UsageLine
                  icon="calendar-outline"
                  label="Monthly minutes"
                  value={formatRemaining(planStatus?.minutesRemaining, 'min')}
                />
                <UsageLine
                  icon="today-outline"
                  label="Daily minutes"
                  value={formatRemaining(planStatus?.dailyMinutesRemaining, 'min')}
                />
                <UsageLine
                  icon="mic-outline"
                  label="Recordings today"
                  value={formatRemaining(planStatus?.recordingsRemainingToday, 'recordings')}
                />
              </GlassCard>

              <GlassCard style={styles.card}>
                <Text style={styles.cardTitle}>Student Basic benefits</Text>
                <BenefitLine icon="school-outline" text="Premium lecture recording capacity for coursework." />
                <BenefitLine icon="albums-outline" text="Higher daily and monthly usage budgets." />
                <BenefitLine icon="sync-outline" text="Backend-verified access shared across signed-in devices." />
              </GlassCard>

              <GlassCard style={styles.card}>
                <Text style={styles.cardTitle}>Server-provided quota limits</Text>
                {quotaLines.map(([label, value]) => (
                  <LimitLine key={label} label={label} value={value} />
                ))}
              </GlassCard>

              <GlassCard style={styles.card}>
                <View style={styles.purchaseHeader}>
                  <View style={styles.purchaseText}>
                    <Text style={styles.productName}>
                      {product?.displayName ?? 'Student Basic - 30 Days'}
                    </Text>
                    <Text style={styles.productId}>{STUDENT_PASS_PRODUCT_ID}</Text>
                  </View>
                  <Text style={styles.price}>
                    {productLoading ? 'Loading…' : product?.displayPrice ?? 'Unavailable'}
                  </Text>
                </View>

                {isGuest || !accessToken ? (
                  <View style={styles.notice}>
                    <Ionicons name="lock-closed-outline" size={18} color={colors.deepNavy} />
                    <Text style={styles.noticeText}>Sign in before purchasing Student Basic.</Text>
                  </View>
                ) : null}

                {!purchaseVisible ? (
                  <View style={styles.notice}>
                    <Ionicons name="pause-circle-outline" size={18} color={colors.deepNavy} />
                    <Text style={styles.noticeText}>New Student Basic purchases are unavailable.</Text>
                  </View>
                ) : null}

                {!productLoading && !product ? (
                  <View style={styles.notice}>
                    <Ionicons name="alert-circle-outline" size={18} color={colors.deepNavy} />
                    <Text style={styles.noticeText}>
                      Student Basic could not be fetched from the App Store.
                    </Text>
                  </View>
                ) : null}

                {purchaseVisible ? (
                  <SecondaryButton
                    label={busy === 'purchase' ? 'Purchasing…' : 'Purchase Student Basic'}
                    icon="card-outline"
                    onPress={handlePurchase}
                    disabled={purchaseDisabled}
                    style={styles.actionButton}
                  />
                ) : null}
                <SecondaryButton
                  label={busy === 'restore' ? 'Refreshing…' : 'Refresh Access'}
                  icon="refresh-outline"
                  onPress={handleRestore}
                  disabled={busy !== null || isGuest || !accessToken}
                  style={styles.actionButton}
                />
                {isGuest ? (
                  <SecondaryButton
                    label="Sign In"
                    icon="log-in-outline"
                    onPress={handleSignIn}
                    style={styles.actionButton}
                  />
                ) : null}
                {restoreResult ? (
                  <Text style={styles.restoreText}>
                    {restoreResult.message ||
                      restoreMessageForCode(restoreResult.code)}
                  </Text>
                ) : null}
              </GlassCard>
            </>
          )}

          <Text style={styles.footerNote}>
            StoreKit transactions are verified by the Youmi Lens backend before access changes.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function UsageLine({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.usageLine}>
      <View style={styles.lineIcon}>
        <Ionicons name={icon} size={18} color={colors.deepNavy} />
      </View>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  );
}

function BenefitLine({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.benefitLine}>
      <View style={styles.lineIcon}>
        <Ionicons name={icon} size={18} color={colors.deepNavy} />
      </View>
      <Text style={styles.benefitText}>{text}</Text>
    </View>
  );
}

function LimitLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.limitLine}>
      <Text style={styles.limitLabel}>{label}</Text>
      <Text style={styles.limitValue}>{value}</Text>
    </View>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <GlassCard style={styles.card}>
      <Text style={styles.cardTitle}>Account status unavailable</Text>
      <Text style={styles.cardBody}>{message}</Text>
      <SecondaryButton
        label="Retry"
        icon="refresh-outline"
        onPress={onRetry}
        style={styles.actionButton}
      />
    </GlassCard>
  );
}

function formatNumber(value: number | null | undefined, unit: string): string {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Math.round(Number(value))} ${unit}`;
}

function formatRemaining(value: number | null | undefined, unit: string): string {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Math.max(0, Math.round(Number(value)))} ${unit}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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
  heroBlock: { gap: spacing.sm },
  heroTitle: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  heroSubtitle: {
    fontSize: fontSize.lg,
    lineHeight: fontSize.lg * 1.35,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  heroFinePrint: {
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.45,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  loading: { paddingVertical: spacing.xxxl, alignItems: 'center' },
  card: { gap: spacing.md },
  cardTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  cardBody: {
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.5,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  statusName: { flex: 1, fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.successTint,
  },
  activePillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    color: '#157A58',
  },
  usageLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  benefitLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  lineIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.iceTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineLabel: { flex: 1, fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '700' },
  lineValue: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '800' },
  benefitText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.45,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  limitLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  limitLabel: { flex: 1, fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600' },
  limitValue: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '800' },
  purchaseHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  purchaseText: { flex: 1, gap: 2 },
  productName: { fontSize: fontSize.lg, color: colors.textPrimary, fontWeight: '800' },
  productId: { fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: '600' },
  price: { fontSize: fontSize.xl, color: colors.textPrimary, fontWeight: '800' },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.iceTint,
    borderWidth: 1,
    borderColor: colors.iceBlue,
  },
  noticeText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.35,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  actionButton: { alignSelf: 'stretch' },
  restoreText: {
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.45,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  footerNote: {
    fontSize: fontSize.xs,
    lineHeight: fontSize.xs * 1.5,
    color: colors.textTertiary,
    fontWeight: '500',
    textAlign: 'center',
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
});
