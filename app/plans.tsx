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
import { ensureGuestIapIdentity, hasGuestIapIdentity } from '@/lib/guestIap';
import { useI18n } from '@/lib/i18n';
import { fetchPlanStatus, PlanStatus } from '@/lib/planStatus';
import {
  shouldShowPurchaseEntry,
} from '@/lib/purchases';
import { logDiag } from '@/lib/iapDiag';
import { boundedPaymentTask, PAYMENT_UI_WAIT_TIMEOUT_MS } from '@/lib/boundedPaymentTask';
import { isTrialAvailable, type LoadedSubscriptionProduct, type SubscriptionCatalog } from '@/lib/subscriptionCore';
import { PREVIEW_PRICES, SUBSCRIPTIONS_LIVE } from '@/lib/subscriptionPreview';
import type { SubscriptionPlan } from '@/lib/subscriptionProducts';
import {
  isSubscriptionProductId,
  planForSubscriptionProductId,
  SUBSCRIPTION_PRIVACY_URL,
  SUBSCRIPTION_TERMS_URL,
} from '@/lib/subscriptionProducts';
import { BillingRequestIdentity } from '@/lib/billingRequestIdentity';
import { fetchSubscriptionAvailability, canPurchaseSubscription, type SubscriptionAvailability } from '@/lib/subscriptionAvailability';
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
  const screenIdentity = isGuest ? 'guest' : accountId;
  const signedRequestIdentity = useRef(new BillingRequestIdentity()).current;
  const productRequestIdentity = useRef(new BillingRequestIdentity()).current;
  const introRequestIdentity = useRef(new BillingRequestIdentity()).current;
  const actionIdentity = useRef(new BillingRequestIdentity()).current;
  const guestRequestIdentity = useRef(new BillingRequestIdentity()).current;
  const availabilityIdentity = useRef(new BillingRequestIdentity()).current;
  signedRequestIdentity.setIdentity(screenIdentity);
  productRequestIdentity.setIdentity(screenIdentity);
  introRequestIdentity.setIdentity(screenIdentity);
  actionIdentity.setIdentity(screenIdentity);
  guestRequestIdentity.setIdentity(screenIdentity);
  availabilityIdentity.setIdentity(screenIdentity);
  const [availability, setAvailability] = useState<SubscriptionAvailability[] | null>(null);
  const [availabilityAccount, setAvailabilityAccount] = useState<string | null>(null);
  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
  const [planStatusAccountId, setPlanStatusAccountId] = useState<string | null>(null);
  // App Review 5.1.1(v): the guest-IAP identity/status are ENTIRELY separate
  // from the main account's session/status above — sourced from the isolated
  // client in lib/guestIapClient.ts, never from useAuth(). This is what lets a
  // guest purchase, see their own active plan, and Restore, while Cloud
  // Library and every other main-session consumer stay completely unaware.
  const [guestAccountId, setGuestAccountId] = useState<string | null>(null);
  const [guestPlanStatus, setGuestPlanStatus] = useState<PlanStatus | null>(null);
  const [guestPlanStatusAccountId, setGuestPlanStatusAccountId] = useState<string | null>(null);
  const [guestStatusLoading, setGuestStatusLoading] = useState(false);
  const [products, setProducts] = useState<SubscriptionCatalog>({ monthly: null, annual: null });
  // Fails closed: starts (and stays, on any query failure) `false` — the UI
  // must never advertise a trial it isn't sure the current Apple ID gets.
  const [introEligible, setIntroEligible] = useState(false);
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
    const identityTicket = signedRequestIdentity.begin();
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
      const nextStatus = await boundedPaymentTask(() => fetchPlanStatus(accessToken), PAYMENT_UI_WAIT_TIMEOUT_MS, 'plan_status');
      if (!signedRequestIdentity.owns(identityTicket) || requestId !== statusRequestRef.current || activeAccountRef.current !== requestedAccountId) {
        return null;
      }
      setPlanStatus(nextStatus);
      setPlanStatusAccountId(requestedAccountId);
      return nextStatus;
    } catch (nextError) {
      // Raw technical detail stays in logs; the user sees a localized generic message.
      console.warn('[plans] plan status load failed', nextError);
      if (signedRequestIdentity.owns(identityTicket) && requestId === statusRequestRef.current && activeAccountRef.current === requestedAccountId) {
        setError(t('plans.statusUnavailable'));
      }
      return null;
    } finally {
      if (signedRequestIdentity.owns(identityTicket) && requestId === statusRequestRef.current && activeAccountRef.current === requestedAccountId) {
        setStatusLoading(false);
      }
    }
  }, [accessToken, accountId, t, signedRequestIdentity]);

  /**
   * Read-only guest status refresh: reuses an EXISTING guest-IAP identity if
   * one is already on this device (never mints a new anonymous user just from
   * viewing the screen — only an actual purchase/restore attempt does that).
   * This is what makes a relaunch correctly show a returning guest's active
   * plan (G5) without ever touching the main account's session or status.
   */
  const loadGuestStatus = useCallback(async () => {
    const ticket = guestRequestIdentity.begin();
    const hasIdentity = await hasGuestIapIdentity();
    if (!guestRequestIdentity.owns(ticket)) return null;
    if (!hasIdentity) {
      setGuestPlanStatus(null);
      setGuestPlanStatusAccountId(null);
      setGuestStatusLoading(false);
      return null;
    }
    const identity = await ensureGuestIapIdentity();
    if (!guestRequestIdentity.owns(ticket)) return null;
    if (!identity) {
      setGuestPlanStatus(null);
      setGuestPlanStatusAccountId(null);
      setGuestStatusLoading(false);
      return null;
    }
    setGuestAccountId(identity.accountId);
    setGuestStatusLoading(true);
    try {
      const nextStatus = await boundedPaymentTask(() => fetchPlanStatus(identity.accessToken), PAYMENT_UI_WAIT_TIMEOUT_MS, 'plan_status');
      if (!guestRequestIdentity.owns(ticket)) return null;
      setGuestPlanStatus(nextStatus);
      setGuestPlanStatusAccountId(identity.accountId);
      return nextStatus;
    } catch (nextError) {
      console.warn('[plans] guest plan status load failed', nextError);
      return null;
    } finally {
      if (guestRequestIdentity.owns(ticket)) setGuestStatusLoading(false);
    }
  }, [guestRequestIdentity]);

  const loadAvailability = useCallback(async () => {
    const ticket = availabilityIdentity.begin();
    setAvailability(null);
    try {
      const next = await fetchSubscriptionAvailability();
      if (!availabilityIdentity.owns(ticket)) return;
      setAvailability(next);
      setAvailabilityAccount(ticket.identity);
    } catch {
      if (availabilityIdentity.owns(ticket)) { setAvailability(null); setAvailabilityAccount(null); }
    }
  }, [availabilityIdentity]);
  useEffect(() => { void loadAvailability(); }, [screenIdentity, loadAvailability]);

  const loadProducts = useCallback(async (force = false) => {
    const productTicket = productRequestIdentity.begin();
    if (!SUBSCRIPTIONS_LIVE) {
      setProductLoading(false);
      return;
    }
    setProductLoading(true);
    setProductError(false);
    try {
      const nextProducts = await subscriptionService.loadProducts(force);
      if (!productRequestIdentity.owns(productTicket)) return;
      setProducts(nextProducts);
      setSelectedPlan((current) => {
        if (nextProducts[current]) return current;
        if (nextProducts.annual) return 'annual';
        if (nextProducts.monthly) return 'monthly';
        return current;
      });
    } catch {
      if (!productRequestIdentity.owns(productTicket)) return;
      setProducts({ monthly: null, annual: null });
      setProductError(true);
    } finally {
      if (productRequestIdentity.owns(productTicket)) setProductLoading(false);
    }
  }, [productRequestIdentity]);

  useEffect(() => {
    void loadProducts();
    // Independent of product loading: getIntroOfferEligibility() already
    // fails closed internally, and its failure must never affect whether
    // products load or purchase remains available.
    if (SUBSCRIPTIONS_LIVE) {
      const ticket = introRequestIdentity.begin();
      void subscriptionService.getIntroOfferEligibility().then((eligible) => { if (introRequestIdentity.owns(ticket)) setIntroEligible(eligible); });
    }
    return () => subscriptionService.cleanup();
  }, [loadProducts, introRequestIdentity, screenIdentity]);
  useEffect(() => {
    statusRequestRef.current += 1;
    setPlanStatus(null);
    setPlanStatusAccountId(null);
    setAvailability(null);
    setGuestPlanStatus(null);
    setGuestPlanStatusAccountId(null);
    setIntroEligible(false);
    setAccessRefreshMessage(null);
    setError(null);
    setStatusLoading(Boolean(accessToken && accountId));
    setBusy(null);
    purchaseLockRef.current = false;
  }, [accessToken, accountId, screenIdentity]);
  useFocusEffect(useCallback(() => { void loadStatus(); if (isGuest) void loadGuestStatus(); }, [loadStatus, loadGuestStatus, isGuest]));
  useEffect(() => {
    const appStateListener = AppState.addEventListener('change', (nextState) => {
      const wasBackgrounded = appStateRef.current === 'background' || appStateRef.current === 'inactive';
      appStateRef.current = nextState;
      if (wasBackgrounded && nextState === 'active') {
        void loadStatus();
        if (isGuest) void loadGuestStatus();
      }
    });
    return () => appStateListener.remove();
  }, [loadStatus, loadGuestStatus, isGuest]);

  // App Review 5.1.1(v): a guest's "current status" comes from the isolated
  // guest-IAP identity, never from the main account — this single branch is
  // what makes every derived value below (active entitlement, purchase
  // visibility, the status pill) correct for guests with zero further changes.
  const currentStatus = isGuest
    ? (guestAccountId && guestPlanStatusAccountId === guestAccountId ? guestPlanStatus : null)
    : (planStatusAccountId === accountId ? planStatus : null);
  const activeEntitlement = currentStatus?.entitlement?.active ? currentStatus.entitlement : null;
  const activeSubscriptionPlan = planForSubscriptionProductId(activeEntitlement?.productId);
  // The legacy Student Basic purchase flag only governs the retired
  // single-pass product. It must not hide the live Monthly/Annual StoreKit
  // subscriptions once those products are enabled and loaded. A genuinely
  // active entitlement still suppresses a duplicate subscription entry.
  // Outside the live surface, retain the legacy availability behavior.
  const purchaseVisible = SUBSCRIPTIONS_LIVE
    ? !activeEntitlement
    // A guest with NO known status yet (never purchased, no identity created)
    // must default to purchasable — shouldShowPurchaseEntry(null) is false,
    // which is correct for "still loading" on the main-account path but wrong
    // for "genuinely nothing to hide it" on the guest path.
    : isGuest
      ? (currentStatus ? shouldShowPurchaseEntry(currentStatus) : true)
      : shouldShowPurchaseEntry(currentStatus);
  const purchaseUnavailable = !SUBSCRIPTIONS_LIVE && currentStatus?.studentPass?.isPurchasable === false;
  const selectedProduct = products[selectedPlan];
  const backendAvailability = availabilityAccount === screenIdentity ? availability : null;
  const purchaseDisabled = !purchaseVisible || productLoading || !selectedProduct || busy !== null || !canPurchaseSubscription(selectedPlan, products, backendAvailability, SUBSCRIPTIONS_LIVE);
  const studentBasicStatus = getStudentBasicStatus(currentStatus, isGuest ? guestStatusLoading : statusLoading);
  // Necessary AND sufficient: the product's own offer mode, AND live Apple-ID
  // eligibility (fails closed to false — see getIntroOfferEligibility).
  const monthlyTrialAvailable = SUBSCRIPTIONS_LIVE && isTrialAvailable(products.monthly, introEligible);
  const annualTrialAvailable = SUBSCRIPTIONS_LIVE && isTrialAvailable(products.annual, introEligible);
  const selectedTrialAvailable = selectedPlan === 'monthly' ? monthlyTrialAvailable : annualTrialAvailable;

  /**
   * App Review 5.1.1(v): the identity that drives purchase/restore. For a
   * signed-in user this is unchanged — the main session, exactly as before.
   * For a guest, this obtains (creating on first use) the ISOLATED guest-IAP
   * identity — never the main session, never anything that touches
   * AuthProvider or Cloud Library. `subscriptionService.purchase`/`.restore`
   * are otherwise completely unmodified: they only ever see an access token +
   * a UUID, and cannot tell (nor need to) which source it came from.
   */
  const resolvePurchaseIdentity = async (): Promise<{ token: string; account: string } | null> => {
    if (!isGuest) return accessToken && accountId ? { token: accessToken, account: accountId } : null;
    const identity = await ensureGuestIapIdentity();
    if (!identity) return null;
    setGuestAccountId(identity.accountId);
    return { token: identity.accessToken, account: identity.accountId };
  };
  const refreshCurrentStatus = () => (isGuest ? loadGuestStatus() : loadStatus());
  const refreshPaymentStatus = async () => {
    logDiag('entitlement_refresh_started');
    try {
      const status = await boundedPaymentTask(refreshCurrentStatus, PAYMENT_UI_WAIT_TIMEOUT_MS, 'entitlement_refresh');
      logDiag(status ? 'entitlement_refresh_succeeded' : 'entitlement_refresh_failed');
      return status;
    } catch {
      logDiag('entitlement_refresh_failed');
      return null;
    }
  };

  const handlePurchase = async () => {
    if (purchaseLockRef.current || busy !== null || !purchaseVisible || !selectedProduct) return;
    purchaseLockRef.current = true;
    setBusy('purchase');
    setAccessRefreshMessage(null);
    const actionTicket = actionIdentity.begin();
    try {
      const identity = await boundedPaymentTask(resolvePurchaseIdentity, PAYMENT_UI_WAIT_TIMEOUT_MS, 'purchase_identity');
      if (!actionIdentity.owns(actionTicket)) return;
      if (!identity) {
        Alert.alert(t('plans.purchaseUnavailableTitle'), t('plans.guestPurchaseUnavailable'));
        return;
      }
      const result = await subscriptionService.purchase(selectedPlan, identity.token, identity.account);
      if (!actionIdentity.owns(actionTicket)) return;
      if (result.code === 'cancelled') return;
      if (result.code === 'pending') {
        Alert.alert(t('plans.purchasePending'), result.message);
        return;
      }
      if (result.code === 'verify_timeout') {
        // Apple may already have completed the transaction — never claim it failed.
        Alert.alert(t('plans.refreshNeeded'), result.message);
        return;
      }
      if (!result.ok) {
        Alert.alert(t('plans.purchaseIncomplete'), result.message);
        return;
      }

      if (!actionIdentity.owns(actionTicket)) return;
      const refreshedStatus = await refreshPaymentStatus();
      if (!actionIdentity.owns(actionTicket)) return;
      if (refreshedStatus && confirmsStudentBasicGrant(refreshedStatus)) {
        Alert.alert(t('plans.activeTitle'), t('plans.activeBody'));
      } else {
        Alert.alert(
          t('plans.refreshNeeded'),
          t('plans.refreshNeededBody'),
        );
      }
    } catch {
      if (!actionIdentity.owns(actionTicket)) return;
      Alert.alert(t('plans.purchaseUnavailableTitle'), t('plans.guestPurchaseUnavailable'));
    } finally {
      if (actionIdentity.owns(actionTicket)) {
        purchaseLockRef.current = false;
        setBusy(null);
        logDiag('purchase_busy_cleared', { plan: selectedPlan });
      }
    }
  };
  const handleRefreshAccess = async () => {
    if (busy !== null) return;
    setBusy('refresh');
    const actionTicket = actionIdentity.begin();
    try {
      const identity = await boundedPaymentTask(resolvePurchaseIdentity, PAYMENT_UI_WAIT_TIMEOUT_MS, 'restore_identity');
      if (!actionIdentity.owns(actionTicket)) return;
      if (!identity) {
        Alert.alert(t('plans.purchaseUnavailableTitle'), t('plans.guestPurchaseUnavailable'));
        return;
      }
      const result = await subscriptionService.restore(identity.token, identity.account);
      if (!actionIdentity.owns(actionTicket)) return;
      const refreshedStatus = await refreshPaymentStatus();
      if (!actionIdentity.owns(actionTicket)) return;
      if (!result.ok && !['no_purchase', 'expired', 'revoked'].includes(result.code)) {
        setAccessRefreshMessage(result.message);
        Alert.alert(t('plans.refreshFailed'), result.message);
        return;
      }
      if (!refreshedStatus) {
        setAccessRefreshMessage(result.message);
        Alert.alert(t('plans.refreshFailed'), t('plans.refreshFailedBody'));
        return;
      }
      const message = accessMessageForStatus(refreshedStatus, t);
      setAccessRefreshMessage(message);
      Alert.alert(t('plans.refreshed'), message);
    } catch {
      if (!actionIdentity.owns(actionTicket)) return;
      Alert.alert(t('plans.refreshFailed'), t('plans.refreshFailedBody'));
    } finally {
      if (actionIdentity.owns(actionTicket)) {
        setBusy(null);
        logDiag('restore_busy_cleared');
      }
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
                  {monthlyTrialAvailable ? (
                    <Text style={styles.planTrialBadge}>{t('plans.freeTrialOneMonth')}</Text>
                  ) : null}
                  {monthlyTrialAvailable && products.monthly ? (
                    <Text style={styles.planTrialThen}>{t('plans.thenPricePerMonth', { price: products.monthly.displayPrice })}</Text>
                  ) : null}
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
                  {annualTrialAvailable ? (
                    <Text style={styles.planTrialBadge}>{t('plans.freeTrialOneMonth')}</Text>
                  ) : null}
                  {annualTrialAvailable && products.annual ? (
                    <Text style={styles.planTrialThen}>{t('plans.thenPricePerYear', { price: products.annual.displayPrice })}</Text>
                  ) : null}
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
                  label={selectedTrialAvailable ? t('plans.startFreeTrial') : t('plans.subscribe')}
                  icon="sparkles-outline"
                  onPress={() => void handlePurchase()}
                  disabled={!SUBSCRIPTIONS_LIVE || purchaseDisabled}
                  loading={busy === 'purchase'}
                />
                {!canPurchaseSubscription(selectedPlan, products, backendAvailability, SUBSCRIPTIONS_LIVE) ? (
                  <Text style={styles.unavailableNote}>{t('plans.subscriptionsUnavailable')}</Text>
                ) : !SUBSCRIPTIONS_LIVE ? (
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
                  disabled={busy !== null}
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
  // SECONDARY: visually subordinate to planPrice (fontSize 20/weight 800) — the
  // billed amount must read first. App Review 3.1.2(c): a free trial can never
  // out-weigh the price it's offered against.
  planTrialBadge: { color: colors.accent, fontSize: 13, fontWeight: '700', marginTop: 3 },
  // TERTIARY: smallest, most muted — the auto-renewal disclosure.
  planTrialThen: { color: colors.textTertiary, fontSize: 12, fontWeight: '500', marginTop: 2 },
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
