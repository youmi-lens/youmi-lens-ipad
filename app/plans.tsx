import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackground } from '@/components/AppBackground';
import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { GlassIconButton, ProgressBar } from '@/components/WorkspaceUI';
import { colors, layout, radius } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { fetchPlanStatus, PlanStatus, safeAccessLabel } from '@/lib/planStatus';
import {
  purchaseService,
  restoreMessageForCode,
  shouldShowPurchaseEntry,
  STUDENT_PASS_PRODUCT_ID,
  type StudentPassProduct,
} from '@/lib/purchases';

type BusyAction = 'purchase' | 'refresh' | null;
type StudentBasicStatus = 'Active' | 'Not active' | 'Expired' | 'Checking';

const QUOTAS = [
  ['Monthly minutes', '300 min', '600 min'],
  ['Daily minutes', '120 min', '120 min'],
  ['Recording length', '60 min', '90 min'],
  ['Live session length', '60 min', '90 min'],
  ['Recordings per day', '2', '6'],
  ['Processing jobs per day', '2', '10'],
] as const;

const BUY_FEATURES = [
  'Longer lecture capture',
  'More daily recordings',
  'Higher processing capacity',
] as const;

export default function PlansScreen() {
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
      if (requestId === statusRequestRef.current && activeAccountRef.current === requestedAccountId) {
        setError(nextError instanceof Error ? nextError.message : 'Account status is unavailable.');
      }
      return null;
    } finally {
      if (requestId === statusRequestRef.current && activeAccountRef.current === requestedAccountId) {
        setStatusLoading(false);
      }
    }
  }, [accessToken, accountId]);
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
  const purchaseDisabled = isGuest || !accessToken || !purchaseVisible || productLoading || !product || busy !== null;
  const currentPlan = currentStatus
    ? safeAccessLabel(currentStatus.planType, currentStatus.displayName)
    : 'Checking account';
  const studentBasicStatus = getStudentBasicStatus(currentStatus, statusLoading || Boolean(accessToken));
  const recordingsRemaining = currentStatus?.recordingsRemainingToday;
  const limit = currentStatus?.maxRecordingsPerDay ?? 0;

  const handlePurchase = async () => {
    if (isGuest || !accessToken) return Alert.alert('Sign in required', 'Sign in before purchasing Student Basic.');
    if (purchaseLockRef.current || busy !== null || !purchaseVisible || !product) return;
    purchaseLockRef.current = true;
    setBusy('purchase');
    setAccessRefreshMessage(null);
    try {
      const result = await purchaseService.purchaseStudentPass(accessToken);
      if (result.code === 'cancelled') return;
      if (result.code === 'pending') {
        Alert.alert('Purchase pending', result.message);
        return;
      }
      if (!result.ok) {
        Alert.alert('Purchase not completed', result.message);
        return;
      }

      const refreshedStatus = await loadStatus();
      if (refreshedStatus && confirmsStudentBasicGrant(refreshedStatus)) {
        Alert.alert('Student Basic active', 'Your verified purchase is active and your updated limits are ready.');
      } else {
        Alert.alert(
          'Access refresh needed',
          'Apple payment was verified, but updated access could not be confirmed. Tap Refresh Access before trying again.',
        );
      }
    } finally {
      purchaseLockRef.current = false;
      setBusy(null);
    }
  };
  const handleRefreshAccess = async () => {
    if (isGuest || !accessToken) return Alert.alert('Sign in required', 'Sign in to refresh your purchase status.');
    if (busy !== null) return;
    setBusy('refresh');
    try {
      const result = await purchaseService.restoreStudentPass(accessToken);
      const refreshedStatus = await loadStatus();
      if (!refreshedStatus) {
        setAccessRefreshMessage(result.message || restoreMessageForCode(result.code));
        Alert.alert('Access refresh failed', 'Quota and access status could not be refreshed. Check your connection and try again.');
        return;
      }
      const message = accessMessageForStatus(refreshedStatus);
      setAccessRefreshMessage(message);
      Alert.alert('Access refreshed', message);
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
            <Text style={styles.topTitle}>Student Access</Text>
          </View>

          {statusLoading && !currentStatus ? (
            <View style={styles.loading}><ActivityIndicator color={colors.accent} /></View>
          ) : (
            <View style={styles.grid}>
              <View style={styles.leftColumn}>
                <View style={styles.hero}>
                  <Text style={styles.eyebrow}>Upgrade</Text>
                  <Text style={styles.heroTitle}>More room for serious lecture weeks</Text>
                  <Text style={styles.heroBody}>30 days of premium lecture support</Text>
                  <Text style={styles.heroFine}>One-time payment. Does not renew automatically.</Text>
                  <View style={styles.heroPriceRow}>
                    <Text style={styles.heroPrice}>{productLoading ? 'Loading price…' : product?.displayPrice ?? 'App Store unavailable'}</Text>
                    <Text style={styles.heroPriceTerm}>one-time · 30 days</Text>
                  </View>
                </View>

                <GlassCard>
                  <View style={styles.statusTop}>
                    <View style={styles.statusIcon}><Ionicons name="flash-outline" size={19} color={colors.accent} /></View>
                    <View style={styles.statusInfo}>
                      <Text style={styles.statusPlan}>{currentPlan}</Text>
                      <Text style={styles.statusSub}>
                        {recordingsRemaining == null
                          ? 'Access status from your Youmi Lens account'
                          : `${recordingsRemaining} of ${limit || '—'} daily recordings remaining`}
                      </Text>
                    </View>
                    <View style={[styles.statusBadge, studentBasicStatus === 'Active' && styles.statusBadgeActive]}>
                      <Text style={[styles.statusBadgeText, studentBasicStatus === 'Active' && styles.statusBadgeTextActive]}>
                        {studentBasicStatus.toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  {error ? (
                    <Pressable onPress={() => void loadStatus()}><Text style={styles.errorText}>{error} Tap to retry.</Text></Pressable>
                  ) : (
                    <>
                      <ProgressBar
                        value={limit > 0 && recordingsRemaining != null ? recordingsRemaining / limit : 0}
                        style={styles.statusProgress}
                      />
                      <View style={styles.accessEndsRow}>
                        <Text style={styles.accessEndsLabel}>Access ends</Text>
                        <Text style={styles.accessEndsValue}>{formatDate(activeEntitlement?.expiresAt)}</Text>
                      </View>
                      <View style={styles.limitsBlock}>
                        <Text style={styles.limitsTitle}>Current backend limits</Text>
                        <View style={styles.limitsGrid}>
                          <CurrentLimit label="Monthly" value={formatMinutes(currentStatus?.monthlyMinutesLimit ?? currentStatus?.minutesLimit)} />
                          <CurrentLimit label="Daily" value={formatMinutes(currentStatus?.dailyMinutesLimit)} />
                          <CurrentLimit label="Recording" value={formatMinutes(currentStatus?.maxRecordingMinutes)} />
                          <CurrentLimit label="Live session" value={formatMinutes(currentStatus?.maxLiveSessionMinutes)} />
                          <CurrentLimit label="Recordings/day" value={formatCount(currentStatus?.maxRecordingsPerDay)} />
                          <CurrentLimit label="Processing/day" value={formatCount(currentStatus?.maxProcessingJobsPerDay)} />
                        </View>
                      </View>
                    </>
                  )}
                </GlassCard>

                <GlassCard>
                  <View style={styles.compareHeader}>
                    <Text style={styles.compareTitle}>What you get</Text>
                    <View style={styles.boostBadge}><Text style={styles.boostBadgeText}>30-day boost</Text></View>
                  </View>
                  <View style={styles.tableHeader}>
                    <Text style={[styles.thCell, styles.thFeature]}>Quota</Text>
                    <Text style={styles.thCell}>Free</Text>
                    <Text style={[styles.thCell, styles.thPaid]}>Student Basic</Text>
                  </View>
                  {QUOTAS.map(([label, free, paid]) => (
                    <View key={label} style={styles.tableRow}>
                      <Text style={[styles.tdCell, styles.tdFeature]}>{label}</Text>
                      <Text style={[styles.tdCell, styles.tdFree]}>{free}</Text>
                      <View style={[styles.tdCell, styles.tdPaidWrap]}>
                        <Ionicons name="checkmark" size={13} color={colors.success} />
                        <Text style={styles.tdPaid}>{paid}</Text>
                      </View>
                    </View>
                  ))}
                </GlassCard>
              </View>

              <GlassCard elevated style={styles.buyCard}>
                <View style={styles.buyGlow} />
                <View style={styles.buyIcon}><Ionicons name="sparkles" size={26} color={colors.pearlWhite} /></View>
                <Text style={styles.buyName}>{product?.displayName ?? 'Student Basic'}</Text>
                <Text style={styles.buyPrice}>{productLoading ? 'Loading…' : product?.displayPrice ?? 'Unavailable'}</Text>
                <Text style={styles.buyTerm}>30 days of access · does not renew automatically</Text>

                <View style={styles.feats}>
                  {BUY_FEATURES.map((feature) => (
                    <View key={feature} style={styles.feat}>
                      <View style={styles.featCheck}><Ionicons name="checkmark" size={12} color={colors.success} /></View>
                      <Text style={styles.featText}>{feature}</Text>
                    </View>
                  ))}
                </View>

                {activeEntitlement ? (
                  <View style={styles.noticeSuccess}>
                    <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                    <Text style={styles.noticeSuccessText}>Your active access remains visible even when new purchases are closed.</Text>
                  </View>
                ) : null}
                {isGuest || !accessToken ? (
                  <View style={styles.notice}><Ionicons name="lock-closed-outline" size={18} color={colors.accent} /><Text style={styles.noticeText}>Sign in before purchasing Student Basic.</Text></View>
                ) : null}
                {currentStatus?.studentPass?.isPurchasable === false ? (
                  <View style={styles.notice}><Ionicons name="pause-circle-outline" size={18} color={colors.accent} /><Text style={styles.noticeText}>New Student Basic purchases are currently unavailable.</Text></View>
                ) : null}
                {!productLoading && !product ? (
                  <View style={styles.notice}><Ionicons name="alert-circle-outline" size={18} color={colors.accent} /><Text style={styles.noticeText}>Student Basic could not be fetched from the App Store.</Text></View>
                ) : null}

                {purchaseVisible ? (
                  <PrimaryButton label="Purchase Student Basic" icon="card-outline" onPress={() => void handlePurchase()} disabled={purchaseDisabled} loading={busy === 'purchase'} style={styles.cta} />
                ) : null}
                <SecondaryButton label={busy === 'refresh' ? 'Refreshing Access…' : 'Refresh Access'} icon="refresh-outline" onPress={() => void handleRefreshAccess()} disabled={busy !== null || isGuest || !accessToken} style={styles.refreshBtn} />
                {isGuest ? <SecondaryButton label="Sign in" icon="log-in-outline" onPress={() => void handleSignIn()} style={styles.refreshBtn} /> : null}
                {accessRefreshMessage ? <Text style={styles.refreshMessage}>{accessRefreshMessage}</Text> : null}

                <Text style={styles.fine}>Billed once through the App Store. Access is verified by the Youmi Lens backend.</Text>
                <Text style={styles.sku}>{STUDENT_PASS_PRODUCT_ID}</Text>
              </GlassCard>
            </View>
          )}

          <Text style={styles.footer}>StoreKit price is loaded dynamically. The Youmi Lens backend remains the source of truth for access and quotas.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CurrentLimit({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.currentLimit}>
      <Text style={styles.currentLimitLabel}>{label}</Text>
      <Text style={styles.currentLimitValue}>{value}</Text>
    </View>
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

function accessMessageForStatus(status: PlanStatus): string {
  const studentStatus = getStudentBasicStatus(status, false);
  if (studentStatus === 'Active') return 'Student Basic access is active for this Youmi Lens account.';
  if (studentStatus === 'Expired') return 'Student Basic access for this Youmi Lens account has expired.';
  return 'No active Student Basic access is linked to this Youmi Lens account.';
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

function formatMinutes(value: number | null | undefined) {
  return value == null ? '—' : `${value} min`;
}

function formatCount(value: number | null | undefined) {
  return value == null ? '—' : String(value);
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingHorizontal: layout.workspacePadding, paddingVertical: 24 },
  content: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 20 },

  topBar: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  topTitle: { color: colors.ink, fontSize: 21, fontWeight: '800', letterSpacing: -0.3 },

  loading: { minHeight: 320, alignItems: 'center', justifyContent: 'center' },

  grid: { flexDirection: 'row', gap: 22, alignItems: 'flex-start' },
  leftColumn: { flex: 1.4, gap: 18 },

  // Hero
  hero: { paddingVertical: 4 },
  eyebrow: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },
  heroTitle: { color: colors.ink, fontSize: 27, lineHeight: 32, fontWeight: '800', letterSpacing: -0.5, marginTop: 7 },
  heroBody: { color: colors.textPrimary, fontSize: 15, fontWeight: '700', marginTop: 11 },
  heroFine: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 5 },
  heroPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 9, marginTop: 16 },
  heroPrice: { color: colors.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 },
  heroPriceTerm: { color: colors.textTertiary, fontSize: 12.5, fontWeight: '500' },

  // Status card
  statusTop: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  statusIcon: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  statusInfo: { flex: 1 },
  statusPlan: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  statusSub: { color: colors.textSecondary, fontSize: 12.5, marginTop: 2 },
  statusBadge: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted },
  statusBadgeActive: { backgroundColor: colors.successTint },
  statusBadgeText: { color: colors.textSecondary, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  statusBadgeTextActive: { color: colors.success },
  errorText: { color: colors.recordingRed, fontSize: 12.5, marginTop: 16 },
  statusProgress: { marginTop: 18 },
  accessEndsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16, paddingTop: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  accessEndsLabel: { color: colors.textSecondary, fontSize: 12.5 },
  accessEndsValue: { color: colors.ink, fontSize: 12.5, fontWeight: '700' },
  limitsBlock: { marginTop: 16, gap: 10 },
  limitsTitle: { color: colors.ink, fontSize: 12.5, fontWeight: '800' },
  limitsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  currentLimit: { width: '31.5%', minWidth: 120, padding: 11, borderRadius: 11, backgroundColor: colors.surfaceMuted },
  currentLimitLabel: { color: colors.textTertiary, fontSize: 10.5, fontWeight: '700' },
  currentLimitValue: { color: colors.ink, fontSize: 12.5, fontWeight: '800', marginTop: 4 },

  // Comparison card
  compareHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  compareTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  boostBadge: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted },
  boostBadgeText: { color: colors.accent, fontSize: 11, fontWeight: '700' },
  tableHeader: { flexDirection: 'row', marginTop: 16, paddingBottom: 10, borderBottomWidth: 1.5, borderBottomColor: colors.border },
  thCell: { flex: 1, color: colors.textTertiary, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', textAlign: 'center' },
  thFeature: { flex: 1.3, textAlign: 'left' },
  thPaid: { color: colors.accent, fontWeight: '800' },
  tableRow: { flexDirection: 'row', minHeight: 44, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tdCell: { flex: 1, fontSize: 13.5, textAlign: 'center' },
  tdFeature: { flex: 1.3, color: colors.ink, fontWeight: '600', textAlign: 'left' },
  tdFree: { color: colors.textTertiary },
  tdPaidWrap: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  tdPaid: { color: colors.ink, fontSize: 13.5, fontWeight: '800' },

  // Purchase card
  buyCard: { flex: 1 },
  buyGlow: { position: 'absolute', top: -70, right: -70, width: 200, height: 200, borderRadius: 100, backgroundColor: 'rgba(11, 31, 58, 0.025)' },
  buyIcon: { width: 54, height: 54, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy, shadowColor: colors.navy, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 3 },
  buyName: { color: colors.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 18 },
  buyPrice: { color: colors.ink, fontSize: 36, fontWeight: '800', letterSpacing: -0.8, marginTop: 6 },
  buyTerm: { color: colors.textSecondary, fontSize: 13, marginTop: 8 },
  feats: { marginTop: 20, marginBottom: 20, gap: 11 },
  feat: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  featCheck: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.successTint },
  featText: { color: colors.ink, fontSize: 13.5 },
  notice: { flexDirection: 'row', gap: 9, padding: 12, borderRadius: 12, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border, marginBottom: 10 },
  noticeText: { flex: 1, color: colors.textSecondary, fontSize: 11.5, lineHeight: 16 },
  noticeSuccess: { flexDirection: 'row', gap: 9, padding: 12, borderRadius: 12, backgroundColor: colors.successTint, marginBottom: 10 },
  noticeSuccessText: { flex: 1, color: colors.textSecondary, fontSize: 11.5, lineHeight: 16 },
  cta: { marginTop: 2 },
  refreshBtn: { marginTop: 10 },
  refreshMessage: { color: colors.textSecondary, fontSize: 11.5, lineHeight: 16, marginTop: 12 },
  fine: { color: colors.textTertiary, fontSize: 11.5, lineHeight: 17, textAlign: 'center', marginTop: 14 },
  sku: { color: colors.textTertiary, fontSize: 9.5, textAlign: 'center', marginTop: 12, fontFamily: 'ui-monospace', opacity: 0.7 },
  footer: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, textAlign: 'center' },
});
