import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackground } from '@/components/AppBackground';
import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { GlassIconButton } from '@/components/WorkspaceUI';
import { colors, radius } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { formatDate as formatAppDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { fetchPlanStatus, PlanStatus } from '@/lib/planStatus';
import {
  shouldShowPurchaseEntry,
} from '@/lib/purchases';
import type { LoadedSubscriptionProduct, SubscriptionCatalog } from '@/lib/subscriptionCore';
import { PREVIEW_PRICES, SUBSCRIPTIONS_LIVE } from '@/lib/subscriptionPreview';
import type { SubscriptionPlan } from '@/lib/subscriptionProducts';
import {
  isSubscriptionProductId,
  planForSubscriptionProductId,
  SUBSCRIPTION_PRIVACY_URL,
  SUBSCRIPTION_TERMS_URL,
} from '@/lib/subscriptionProducts';
import { subscriptionService } from '@/lib/subscriptions';

type BusyAction = 'purchase' | 'refresh' | null;
type StudentBasicStatus = 'Active' | 'Not active' | 'Expired' | 'Checking';
type PlanChoice = SubscriptionPlan;

// Three plain-language benefits — no quota table, no jargon. Each maps to a
// protected paid limit (600 monthly minutes · 6 recordings/day · 10 jobs/day).
const BENEFITS = [
  'plans.benefit1',
  'plans.benefit2',
  'plans.benefit3',
] as const;

// Commercialization V2 stays inert until ASC metadata, the deployed verifier,
// and true-device Sandbox validation all pass. Preview prices are display-only;
// every live purchase and price comes from the StoreKit product identifier.

export default function PlansScreen() {
  const { t, language } = useI18n();
  const formatDate = (value: string | null | undefined) => formatAppDate(value, language) || '—';
  const router = useRouter();
  const { session, user, isGuest, exitGuest } = useAuth();
  const accessToken = session?.access_token ?? null;
  const accountId = user?.id ?? null;
  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
  const [planStatusAccountId, setPlanStatusAccountId] = useState<string | null>(null);
  const [products, setProducts] = useState<SubscriptionCatalog>({ monthly: null, annual: null });
  const [productLoading, setProductLoading] = useState(SUBSCRIPTIONS_LIVE);
  const [productError, setProductError] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanChoice>('annual');
  const [accessRefreshMessage, setAccessRefreshMessage] = useState<string | null>(null);
  const activeAccountRef = useRef(accountId);
  const statusRequestRef = useRef(0);
  const purchaseLockRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  activeAccountRef.current = accountId;

  const loadStatus = useCallback(async () => {
    const requestId = ++statusRequestRef.current;
    const requestedAccountId = accountId;
    if (!accessToken || !requestedAccountId) {
      setPlanStatus(null);
      setPlanStatusAccountId(null);
      setStatusLoading(false);
      return null;
    }
    setStatusLoading(true);
    setError(null);
    try {
      const nextStatus = await fetchPlanStatus(accessToken);
      if (requestId !== statusRequestRef.current || activeAccountRef.current !== requestedAccountId) {
        return null;
      }
      setPlanStatus(nextStatus);
      setPlanStatusAccountId(requestedAccountId);
      return nextStatus;
    } catch (nextError) {
      // Raw technical detail stays in logs; the user sees a localized generic message.
      console.warn('[plans] plan status load failed', nextError);
      if (requestId === statusRequestRef.current && activeAccountRef.current === requestedAccountId) {
        setError(t('plans.statusUnavailable'));
      }
      return null;
    } finally {
      if (requestId === statusRequestRef.current && activeAccountRef.current === requestedAccountId) {
        setStatusLoading(false);
      }
    }
  }, [accessToken, accountId, t]);
  const loadProducts = useCallback(async (force = false) => {
    if (!SUBSCRIPTIONS_LIVE) {
      setProductLoading(false);
      return;
    }
    setProductLoading(true);
    setProductError(false);
    try {
      const nextProducts = await subscriptionService.loadProducts(force);
      setProducts(nextProducts);
      setSelectedPlan((current) => {
        if (nextProducts[current]) return current;
        if (nextProducts.annual) return 'annual';
        if (nextProducts.monthly) return 'monthly';
        return current;
      });
    } catch {
      setProducts({ monthly: null, annual: null });
      setProductError(true);
    } finally {
      setProductLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProducts();
    return () => subscriptionService.cleanup();
  }, [loadProducts]);
  useEffect(() => {
    statusRequestRef.current += 1;
    setPlanStatus(null);
    setPlanStatusAccountId(null);
    setAccessRefreshMessage(null);
    setError(null);
    setStatusLoading(Boolean(accessToken && accountId));
  }, [accessToken, accountId]);
  useFocusEffect(useCallback(() => { void loadStatus(); }, [loadStatus]));
  useEffect(() => {
    const appStateListener = AppState.addEventListener('change', (nextState) => {
      const wasBackgrounded = appStateRef.current === 'background' || appStateRef.current === 'inactive';
      appStateRef.current = nextState;
      if (wasBackgrounded && nextState === 'active') void loadStatus();
    });
    return () => appStateListener.remove();
  }, [loadStatus]);

  const currentStatus = planStatusAccountId === accountId ? planStatus : null;
  const activeEntitlement = currentStatus?.entitlement?.active ? currentStatus.entitlement : null;
  const activeSubscriptionPlan = planForSubscriptionProductId(activeEntitlement?.productId);
  const purchaseVisible = shouldShowPurchaseEntry(currentStatus);
  const purchaseUnavailable = currentStatus?.studentPass?.isPurchasable === false;
  const selectedProduct = products[selectedPlan];
  const purchaseDisabled = isGuest || !accessToken || !purchaseVisible || productLoading || !selectedProduct || busy !== null;
  const studentBasicStatus = getStudentBasicStatus(currentStatus, statusLoading);

  const handlePurchase = async () => {
    if (isGuest || !accessToken) return Alert.alert(t('plans.signInRequired'), t('plans.signInPurchase'));
    if (purchaseLockRef.current || busy !== null || !purchaseVisible || !selectedProduct) return;
    purchaseLockRef.current = true;
    setBusy('purchase');
    setAccessRefreshMessage(null);
    try {
      const result = await subscriptionService.purchase(selectedPlan, accessToken, accountId);
      if (result.code === 'cancelled') return;
      if (result.code === 'pending') {
        Alert.alert(t('plans.purchasePending'), result.message);
        return;
      }
      if (!result.ok) {
        Alert.alert(t('plans.purchaseIncomplete'), result.message);
        return;
      }

      const refreshedStatus = await loadStatus();
      if (refreshedStatus && confirmsStudentBasicGrant(refreshedStatus)) {
        Alert.alert(t('plans.activeTitle'), t('plans.activeBody'));
      } else {
        Alert.alert(
          t('plans.refreshNeeded'),
          t('plans.refreshNeededBody'),
        );
      }
    } finally {
      purchaseLockRef.current = false;
      setBusy(null);
    }
  };
  const handleRefreshAccess = async () => {
    if (isGuest || !accessToken) return Alert.alert(t('plans.signInRequired'), t('plans.refreshSignIn'));
    if (busy !== null) return;
    setBusy('refresh');
    try {
      const result = await subscriptionService.restore(accessToken);
      const refreshedStatus = await loadStatus();
      if (!refreshedStatus) {
        setAccessRefreshMessage(result.message);
        Alert.alert(t('plans.refreshFailed'), t('plans.refreshFailedBody'));
        return;
      }
      const message = accessMessageForStatus(refreshedStatus, t);
      setAccessRefreshMessage(message);
      Alert.alert(t('plans.refreshed'), message);
    } finally {
      setBusy(null);
    }
  };
  const handleManageSubscription = async () => {
    try {
      await subscriptionService.manageSubscriptions();
    } catch {
      Alert.alert(t('plans.appStoreUnavailable'), t('plans.manageFailed'));
    }
  };
  const handleSignIn = async () => { await exitGuest(); router.replace('/auth'); };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
      <AppBackground />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.topBar}>
            <GlassIconButton icon="chevron-back" onPress={() => router.back()} />
            <Text style={styles.topTitle}>{t('plans.studentAccess')}</Text>
          </View>

          {statusLoading && !currentStatus ? (
            <View style={styles.loading}><ActivityIndicator color={colors.accent} /></View>
          ) : (
            <GlassCard elevated padding={28} style={styles.card}>
              <View style={styles.cardHead}>
                <View style={styles.iconBadge}>
                  <Ionicons name="sparkles" size={24} color={colors.pearlWhite} />
                </View>
                {studentBasicStatus === 'Active' ? (
                  <View style={[styles.pill, styles.pillActive]}>
                    <Text style={[styles.pillText, styles.pillTextActive]}>{t('plans.active')}</Text>
                  </View>
                ) : studentBasicStatus === 'Expired' ? (
                  <View style={styles.pill}>
                    <Text style={styles.pillText}>{t('plans.expired')}</Text>
                  </View>
                ) : null}
              </View>

              <Text style={styles.title}>{t('plans.studentBasic')}</Text>
              <Text style={styles.subtitle}>{t('plans.subtitle')}</Text>

              <View style={styles.planOptions}>
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selectedPlan === 'monthly', disabled: SUBSCRIPTIONS_LIVE && !products.monthly }}
                  disabled={SUBSCRIPTIONS_LIVE && !products.monthly}
                  onPress={() => { if (!SUBSCRIPTIONS_LIVE || products.monthly) setSelectedPlan('monthly'); }}
                  style={[styles.planOption, selectedPlan === 'monthly' && styles.planOptionSelected, SUBSCRIPTIONS_LIVE && !products.monthly && styles.planOptionDisabled]}
                >
                  <View style={styles.planOptionHead}>
                    <Text style={styles.planName}>{t('plans.monthly')}</Text>
                    <View style={[styles.radio, selectedPlan === 'monthly' && styles.radioOn]}>
                      {selectedPlan === 'monthly' ? <Ionicons name="checkmark" size={12} color={colors.pearlWhite} /> : null}
                    </View>
                  </View>
                  <View style={styles.planPriceRow}>
                    <PlanPrice loading={productLoading} product={products.monthly} previewPrice={PREVIEW_PRICES.monthly} unavailableLabel={t('plans.unavailableShort')} />
                    <Text style={styles.planTerm}>{periodLabel(products.monthly, 'monthly', t)}</Text>
                  </View>
                </Pressable>

                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selectedPlan === 'annual', disabled: SUBSCRIPTIONS_LIVE && !products.annual }}
                  disabled={SUBSCRIPTIONS_LIVE && !products.annual}
                  onPress={() => { if (!SUBSCRIPTIONS_LIVE || products.annual) setSelectedPlan('annual'); }}
                  style={[styles.planOption, selectedPlan === 'annual' && styles.planOptionSelected, SUBSCRIPTIONS_LIVE && !products.annual && styles.planOptionDisabled]}
                >
                  <View style={styles.planOptionHead}>
                    <Text style={styles.planName}>{t('plans.annual')}</Text>
                    <View style={[styles.radio, selectedPlan === 'annual' && styles.radioOn]}>
                      {selectedPlan === 'annual' ? <Ionicons name="checkmark" size={12} color={colors.pearlWhite} /> : null}
                    </View>
                  </View>
                  <View style={styles.planPriceRow}>
                    <PlanPrice loading={productLoading} product={products.annual} previewPrice={PREVIEW_PRICES.annual} unavailableLabel={t('plans.unavailableShort')} />
                    <Text style={styles.planTerm}>{periodLabel(products.annual, 'annual', t)}</Text>
                  </View>
                  <View style={styles.savePill}>
                    <Text style={styles.savePillText}>{t('plans.save')}</Text>
                  </View>
                </Pressable>
              </View>

              <View style={styles.divider} />

              <Text style={styles.lead}>{t('plans.lead')}</Text>
              <View style={styles.benefits}>
                {BENEFITS.map((benefit) => (
                  <View key={t(benefit)} style={styles.benefit}>
                    <View style={styles.benefitCheck}>
                      <Ionicons name="checkmark" size={13} color={colors.accent} />
                    </View>
                    <Text style={styles.benefitText}>{t(benefit)}</Text>
                  </View>
                ))}
              </View>

              {activeEntitlement ? (
                <>
                  {activeSubscriptionPlan ? (
                    <View style={styles.accessEndsRow}>
                      <Text style={styles.accessEndsLabel}>{t('plans.currentPlan')}</Text>
                      <Text style={styles.accessEndsValue}>
                        {activeSubscriptionPlan === 'annual' ? t('plans.annual') : t('plans.monthly')}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.accessEndsRow}>
                    <Text style={styles.accessEndsLabel}>
                      {activeEntitlement.autoRenewStatus ? t('plans.renewsOn') : t('plans.accessEnds')}
                    </Text>
                    <Text style={styles.accessEndsValue}>{formatDate(activeEntitlement?.expiresAt)}</Text>
                  </View>
                  {activeSubscriptionPlan && activeEntitlement.autoRenewStatus !== null && activeEntitlement.autoRenewStatus !== undefined ? (
                    <View style={styles.accessEndsRow}>
                      <Text style={styles.accessEndsLabel}>{t('plans.autoRenew')}</Text>
                      <Text style={styles.accessEndsValue}>
                        {activeEntitlement.autoRenewStatus ? t('plans.autoRenewOn') : t('plans.autoRenewOff')}
                      </Text>
                    </View>
                  ) : null}
                  <Text style={styles.activeNote}>{t('plans.activeNote')}</Text>
                </>
              ) : null}

              {error ? (
                <Pressable onPress={() => void loadStatus()}>
                  <Text style={styles.errorText}>{error} {t('settings.plan.tapToRetry')}</Text>
                </Pressable>
              ) : null}

              <View style={styles.actions}>
                <PrimaryButton
                  label={t('plans.subscribe')}
                  icon="sparkles-outline"
                  onPress={() => void handlePurchase()}
                  disabled={!SUBSCRIPTIONS_LIVE || purchaseDisabled}
                  loading={busy === 'purchase'}
                />
                {!SUBSCRIPTIONS_LIVE ? (
                  <Text style={styles.unavailableNote}>{t('plans.comingSoonNote')}</Text>
                ) : productError ? (
                  <Pressable onPress={() => void loadProducts(true)}>
                    <Text style={styles.unavailableNote}>{t('plans.storeLoadFailed')} {t('settings.plan.tapToRetry')}</Text>
                  </Pressable>
                ) : purchaseUnavailable ? (
                  <Text style={styles.unavailableNote}>{t('plans.unavailable')}</Text>
                ) : null}

                <SecondaryButton
                  label={busy === 'refresh' ? t('plans.refreshing') : t('plans.refreshAccess')}
                  icon="refresh-outline"
                  onPress={() => void handleRefreshAccess()}
                  disabled={busy !== null || isGuest || !accessToken}
                />
                {activeEntitlement && isSubscriptionProductId(activeEntitlement.productId) ? (
                  <SecondaryButton
                    label={t('plans.manageSubscription')}
                    icon="open-outline"
                    onPress={() => void handleManageSubscription()}
                    disabled={busy !== null}
                  />
                ) : null}
                {isGuest ? (
                  <SecondaryButton label={t('common.signIn')} icon="log-in-outline" onPress={() => void handleSignIn()} />
                ) : null}
              </View>

              <Text style={styles.helper}>{t('plans.purchaseCheck')}</Text>
              {accessRefreshMessage ? <Text style={styles.refreshMessage}>{accessRefreshMessage}</Text> : null}
              <Text style={styles.fine}>{t('plans.fine')}</Text>
              <View style={styles.legalLinks}>
                <Pressable onPress={() => void Linking.openURL(SUBSCRIPTION_TERMS_URL)}>
                  <Text style={styles.legalLink}>{t('plans.termsOfUse')}</Text>
                </Pressable>
                <Text style={styles.legalDivider}>·</Text>
                <Pressable onPress={() => void Linking.openURL(SUBSCRIPTION_PRIVACY_URL)}>
                  <Text style={styles.legalLink}>{t('plans.privacyPolicy')}</Text>
                </Pressable>
              </View>
            </GlassCard>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function PlanPrice({
  loading,
  product,
  previewPrice,
  unavailableLabel,
}: {
  loading: boolean;
  product: LoadedSubscriptionProduct | null;
  previewPrice: string;
  unavailableLabel: string;
}) {
  if (!SUBSCRIPTIONS_LIVE) return <Text style={styles.planPrice}>{previewPrice}</Text>;
  if (loading) return <View style={styles.priceSkeleton} />;
  return <Text style={styles.planPrice}>{product?.displayPrice ?? unavailableLabel}</Text>;
}

function periodLabel(
  product: LoadedSubscriptionProduct | null,
  fallback: SubscriptionPlan,
  t: (key: string) => string,
): string {
  const unit = product?.periodUnit ?? (fallback === 'monthly' ? 'month' : 'year');
  return unit === 'month' ? t('plans.monthlyTerm') : t('plans.annualTerm');
}

function getStudentBasicStatus(status: PlanStatus | null, loading: boolean): StudentBasicStatus {
  if (loading && !status) return 'Checking';
  if (status?.entitlement?.active || status?.studentPassActive) return 'Active';
  if (
    status?.entitlement?.status === 'expired' ||
    status?.entitlement?.latestEntitlement?.status === 'expired'
  ) {
    return 'Expired';
  }
  return 'Not active';
}

function accessMessageForStatus(status: PlanStatus, t: (key: string) => string): string {
  const studentStatus = getStudentBasicStatus(status, false);
  if (studentStatus === 'Active') return t('plans.accessMessageActive');
  if (studentStatus === 'Expired') return t('plans.accessMessageExpired');
  return t('plans.accessMessageInactive');
}

function confirmsStudentBasicGrant(status: PlanStatus): boolean {
  const entitlementActive = status.entitlement?.active === true || status.studentPassActive === true;
  const hasExpiry = Boolean(status.entitlement?.expiresAt ?? status.studentPassExpiry);
  return (
    entitlementActive &&
    hasExpiry &&
    (status.monthlyMinutesLimit ?? status.minutesLimit) === 600 &&
    status.dailyMinutesLimit === 120 &&
    status.maxRecordingMinutes === 90 &&
    status.maxLiveSessionMinutes === 90 &&
    status.maxRecordingsPerDay === 6 &&
    status.maxProcessingJobsPerDay === 10
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingHorizontal: 24, paddingVertical: 24, flexGrow: 1 },
  content: { width: '100%', maxWidth: 460, alignSelf: 'center', gap: 22 },

  topBar: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  topTitle: { color: colors.ink, fontSize: 21, fontWeight: '800', letterSpacing: -0.3 },

  loading: { minHeight: 320, alignItems: 'center', justifyContent: 'center' },

  // Single upgrade card
  card: { width: '100%' },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconBadge: {
    width: 54, height: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.navy,
    shadowColor: colors.navy, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.14, shadowRadius: 16, elevation: 3,
  },
  pill: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted },
  pillActive: { backgroundColor: colors.successTint },
  pillText: { color: colors.textSecondary, fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  pillTextActive: { color: colors.success },

  title: { color: colors.ink, fontSize: 28, lineHeight: 33, fontWeight: '800', letterSpacing: -0.5, marginTop: 20 },
  subtitle: { color: colors.textSecondary, fontSize: 15, lineHeight: 21, marginTop: 7 },

  // Two selectable subscription plans, side by side.
  planOptions: { flexDirection: 'row', gap: 11, marginTop: 18 },
  planOption: {
    flex: 1, borderRadius: 16, padding: 14, gap: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceMuted,
  },
  planOptionSelected: { borderColor: colors.navy, borderWidth: 1.5, backgroundColor: colors.iceTint },
  planOptionDisabled: { opacity: 0.45 },
  planOptionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  planName: { color: colors.ink, fontSize: 14, fontWeight: '700', letterSpacing: -0.2 },
  radio: {
    width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: 'transparent',
  },
  radioOn: { borderColor: colors.navy, backgroundColor: colors.navy },
  planPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  planPrice: { color: colors.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  priceSkeleton: { width: 64, height: 22, borderRadius: 6, backgroundColor: colors.border },
  planTerm: { color: colors.textTertiary, fontSize: 12, fontWeight: '500' },
  savePill: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: colors.successTint },
  savePillText: { color: colors.success, fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 22 },

  lead: { color: colors.textPrimary, fontSize: 15.5, lineHeight: 22, fontWeight: '600' },
  benefits: { marginTop: 18, gap: 14 },
  benefit: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  benefitCheck: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.iceTint },
  benefitText: { color: colors.ink, fontSize: 15, fontWeight: '600' },

  accessEndsRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 22, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  accessEndsLabel: { color: colors.textSecondary, fontSize: 13 },
  accessEndsValue: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  activeNote: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 12, backgroundColor: colors.successTint, padding: 12, borderRadius: 12 },

  errorText: { color: colors.recordingRed, fontSize: 12.5, lineHeight: 18, marginTop: 18 },

  actions: { marginTop: 26, gap: 11 },
  unavailableNote: { color: colors.textTertiary, fontSize: 11.5, lineHeight: 16, textAlign: 'center' },
  helper: { color: colors.textTertiary, fontSize: 11.5, lineHeight: 16, textAlign: 'center', marginTop: 12 },
  refreshMessage: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 10 },
  fine: { color: colors.textTertiary, fontSize: 11.5, lineHeight: 17, textAlign: 'center', marginTop: 14 },
  legalLinks: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 8 },
  legalLink: { color: colors.accent, fontSize: 11.5, lineHeight: 17, fontWeight: '600' },
  legalDivider: { color: colors.textTertiary, fontSize: 11.5 },
});
