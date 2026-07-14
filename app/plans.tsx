import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  purchaseService,
  restoreMessageForCode,
  shouldShowPurchaseEntry,
  type StudentPassProduct,
} from '@/lib/purchases';

type BusyAction = 'purchase' | 'refresh' | null;
type StudentBasicStatus = 'Active' | 'Not active' | 'Expired' | 'Checking';

// Three plain-language benefits — no quota table, no jargon. Each maps to a
// protected paid limit (600 monthly minutes · 6 recordings/day · 10 jobs/day).
const BENEFITS = [
  'plans.benefit1',
  'plans.benefit2',
  'plans.benefit3',
] as const;

export default function PlansScreen() {
  const { t, language } = useI18n();
  const formatDate = (value: string | null | undefined) => formatAppDate(value, language) || '—';
  const router = useRouter();
  const { session, user, isGuest, exitGuest } = useAuth();
  const accessToken = session?.access_token ?? null;
  const accountId = user?.id ?? null;
  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
  const [planStatusAccountId, setPlanStatusAccountId] = useState<string | null>(null);
  const [product, setProduct] = useState<StudentPassProduct | null>(null);
  const [productLoading, setProductLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
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
  const purchaseVisible = shouldShowPurchaseEntry(currentStatus);
  const purchaseUnavailable = currentStatus?.studentPass?.isPurchasable === false;
  const purchaseDisabled = isGuest || !accessToken || !purchaseVisible || productLoading || !product || busy !== null;
  const purchaseButtonLabel = purchaseUnavailable
    ? t('plans.comingSoon')
    : productLoading
      ? t('plans.loading')
      : t('plans.purchase');
  const studentBasicStatus = getStudentBasicStatus(currentStatus, statusLoading);

  const handlePurchase = async () => {
    if (isGuest || !accessToken) return Alert.alert(t('plans.signInRequired'), t('plans.signInPurchase'));
    if (purchaseLockRef.current || busy !== null || !purchaseVisible || !product) return;
    purchaseLockRef.current = true;
    setBusy('purchase');
    setAccessRefreshMessage(null);
    try {
      const result = await purchaseService.purchaseStudentPass(accessToken);
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
      const result = await purchaseService.restoreStudentPass(accessToken);
      const refreshedStatus = await loadStatus();
      if (!refreshedStatus) {
        setAccessRefreshMessage(result.message || restoreMessageForCode(result.code));
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

              <View style={styles.priceRow}>
                <Text style={styles.price}>{productLoading ? t('plans.loading') : product?.displayPrice ?? t('plans.appStoreUnavailable')}</Text>
                <Text style={styles.priceTerm}>{t('plans.term')}</Text>
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
                  <View style={styles.accessEndsRow}>
                    <Text style={styles.accessEndsLabel}>{t('plans.accessEnds')}</Text>
                    <Text style={styles.accessEndsValue}>{formatDate(activeEntitlement?.expiresAt)}</Text>
                  </View>
                  <Text style={styles.activeNote}>{t('plans.activeNote')}</Text>
                </>
              ) : null}

              {error ? (
                <Pressable onPress={() => void loadStatus()}>
                  <Text style={styles.errorText}>{error} {t('settings.plan.tapToRetry')}</Text>
                </Pressable>
              ) : null}

              <View style={styles.actions}>
                {purchaseVisible || purchaseUnavailable ? (
                  <PrimaryButton
                    label={purchaseButtonLabel}
                    icon={purchaseUnavailable ? 'time-outline' : 'card-outline'}
                    onPress={() => void handlePurchase()}
                    disabled={purchaseDisabled}
                    loading={busy === 'purchase'}
                  />
                ) : null}
                {purchaseUnavailable ? (
                  <Text style={styles.unavailableNote}>{t('plans.unavailable')}</Text>
                ) : null}

                <SecondaryButton
                  label={busy === 'refresh' ? t('plans.refreshing') : t('plans.refreshAccess')}
                  icon="refresh-outline"
                  onPress={() => void handleRefreshAccess()}
                  disabled={busy !== null || isGuest || !accessToken}
                />
                {isGuest ? (
                  <SecondaryButton label={t('common.signIn')} icon="log-in-outline" onPress={() => void handleSignIn()} />
                ) : null}
              </View>

              <Text style={styles.helper}>{t('plans.purchaseCheck')}</Text>
              {accessRefreshMessage ? <Text style={styles.refreshMessage}>{accessRefreshMessage}</Text> : null}
              <Text style={styles.fine}>{t('plans.fine')}</Text>
            </GlassCard>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
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

  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 9, marginTop: 16 },
  price: { color: colors.ink, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  priceTerm: { color: colors.textTertiary, fontSize: 12.5, fontWeight: '500' },

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
});
