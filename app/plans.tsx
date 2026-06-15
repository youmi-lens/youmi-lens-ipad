import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackground } from '@/components/AppBackground';
import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { GlassIconButton, IconTile, PageHeading, Pill, ProgressBar, SectionLabel } from '@/components/WorkspaceUI';
import { colors, layout, radius, spacing } from '@/constants/theme';
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
            <Pill accent>30-DAY ACCESS</Pill>
          </View>

          <View style={styles.hero}>
            <View style={styles.heroCopy}>
              <PageHeading eyebrow="Student access" title="Student Basic" />
              <Text style={styles.heroBody}>30 days of premium lecture support</Text>
              <Text style={styles.heroFine}>One-time payment. Does not renew automatically.</Text>
              <View style={styles.heroBenefits}>
                {['Longer lecture capture', 'More daily recordings', 'Higher processing capacity'].map((item) => (
                  <View key={item} style={styles.heroBenefit}>
                    <Ionicons name="checkmark-circle" size={17} color={colors.accentBright} />
                    <Text style={styles.heroBenefitText}>{item}</Text>
                  </View>
                ))}
              </View>
            </View>
            <GlassCard elevated style={styles.heroVisual}>
              <View style={styles.heroIcon}><Ionicons name="sparkles" size={34} color={colors.accentBright} /></View>
              <Text style={styles.heroProduct}>Student Basic – 30 Days</Text>
              <Text style={styles.heroPrice}>{productLoading ? 'Loading price…' : product?.displayPrice ?? 'App Store unavailable'}</Text>
              <Text style={styles.heroProductType}>One payment adds 30 days after verification</Text>
            </GlassCard>
          </View>

          {statusLoading && !currentStatus ? (
            <View style={styles.loading}><ActivityIndicator color={colors.accentBright} /></View>
          ) : (
            <View style={styles.mainGrid}>
              <View style={styles.leftColumn}>
                <GlassCard elevated>
                  <View style={styles.statusHeader}>
                    <View>
                      <SectionLabel>Current access</SectionLabel>
                      <Text style={styles.currentPlan}>{currentPlan}</Text>
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
                      <View style={styles.statusStats}>
                        <View style={styles.statusStat}>
                          <Text style={styles.statusLabel}>Student Basic</Text>
                          <Text style={styles.statusValue}>{studentBasicStatus}</Text>
                        </View>
                        <View style={styles.statusStat}>
                          <Text style={styles.statusLabel}>Access ends</Text>
                          <Text style={styles.statusValue}>{formatDate(activeEntitlement?.expiresAt)}</Text>
                        </View>
                      </View>
                      <View style={styles.usageRow}>
                        <Text style={styles.usageLabel}>Recordings remaining today</Text>
                        <Text style={styles.usageValue}>
                          {recordingsRemaining == null ? '—' : `${recordingsRemaining} of ${limit || '—'}`}
                        </Text>
                      </View>
                      <ProgressBar value={limit > 0 && recordingsRemaining != null ? recordingsRemaining / limit : 0} />
                      <View style={styles.currentLimits}>
                        <Text style={styles.currentLimitsTitle}>Current backend limits</Text>
                        <View style={styles.currentLimitsGrid}>
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
                  <View style={styles.comparisonHeader}>
                    <View>
                      <SectionLabel>Access comparison</SectionLabel>
                      <Text style={styles.comparisonTitle}>Free and Student Basic</Text>
                    </View>
                    <Pill accent>Paid benefits emphasized</Pill>
                  </View>
                  <Text style={styles.comparisonNote}>
                    Server-provided quota limits determine current access. The values below are a plan reference comparison.
                  </Text>
                  <View style={styles.tableHeader}>
                    <Text style={[styles.tableCell, styles.tableFeature]}>Quota</Text>
                    <Text style={styles.tableCell}>Free</Text>
                    <Text style={[styles.tableCell, styles.tablePaid]}>Student Basic</Text>
                  </View>
                  {QUOTAS.map(([label, free, paid]) => (
                    <View key={label} style={styles.tableRow}>
                      <Text style={[styles.tableCell, styles.tableFeature]}>{label}</Text>
                      <Text style={styles.tableCell}>{free}</Text>
                      <View style={[styles.tableCell, styles.paidCell]}>
                        <Ionicons name="checkmark" size={13} color={colors.accentBright} />
                        <Text style={styles.paidValue}>{paid}</Text>
                      </View>
                    </View>
                  ))}
                </GlassCard>
              </View>

              <GlassCard elevated style={styles.purchaseCard}>
                <IconTile icon="card-outline" size={48} />
                <Text style={styles.purchaseTitle}>{product?.displayName ?? 'Student Basic – 30 Days'}</Text>
                <Text style={styles.purchasePrice}>{productLoading ? 'Loading…' : product?.displayPrice ?? 'Unavailable'}</Text>
                <Text style={styles.purchaseDescription}>A one-time purchase that adds 30 days of Student Basic access after backend verification.</Text>

                {activeEntitlement ? (
                  <View style={styles.noticeSuccess}>
                    <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                    <Text style={styles.noticeSuccessText}>Your active access remains visible even when new purchases are closed.</Text>
                  </View>
                ) : null}
                {isGuest || !accessToken ? (
                  <View style={styles.notice}><Ionicons name="lock-closed-outline" size={18} color={colors.accentBright} /><Text style={styles.noticeText}>Sign in before purchasing Student Basic.</Text></View>
                ) : null}
                {currentStatus?.studentPass?.isPurchasable === false ? (
                  <View style={styles.notice}><Ionicons name="pause-circle-outline" size={18} color={colors.accentBright} /><Text style={styles.noticeText}>New Student Basic purchases are currently unavailable.</Text></View>
                ) : null}
                {!productLoading && !product ? (
                  <View style={styles.notice}><Ionicons name="alert-circle-outline" size={18} color={colors.accentBright} /><Text style={styles.noticeText}>Student Basic could not be fetched from the App Store.</Text></View>
                ) : null}

                {purchaseVisible ? (
                  <PrimaryButton label="Purchase Student Basic" icon="card-outline" onPress={() => void handlePurchase()} disabled={purchaseDisabled} loading={busy === 'purchase'} />
                ) : null}
                <SecondaryButton label={busy === 'refresh' ? 'Refreshing Access…' : 'Refresh Access'} icon="refresh-outline" onPress={() => void handleRefreshAccess()} disabled={busy !== null || isGuest || !accessToken} />
                {isGuest ? <SecondaryButton label="Sign in" icon="log-in-outline" onPress={() => void handleSignIn()} /> : null}
                {accessRefreshMessage ? <Text style={styles.restoreText}>{accessRefreshMessage}</Text> : null}
                <Text style={styles.productId}>{STUDENT_PASS_PRODUCT_ID}</Text>
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
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hero: { flexDirection: 'row', gap: 18, alignItems: 'stretch' },
  heroCopy: { flex: 1.3, paddingVertical: 16 },
  heroBody: { color: colors.textPrimary, fontSize: 17, lineHeight: 24, fontWeight: '700', marginTop: 14 },
  heroFine: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 5 },
  heroBenefits: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 20 },
  heroBenefit: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroBenefitText: { color: colors.textSecondary, fontSize: 12.5, fontWeight: '600' },
  heroVisual: { flex: 0.7, alignItems: 'center', justifyContent: 'center' },
  heroIcon: { width: 68, height: 68, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.iceTint, borderWidth: 1, borderColor: colors.border },
  heroProduct: { color: colors.ink, fontSize: 17, fontWeight: '800', marginTop: 16, textAlign: 'center' },
  heroPrice: { color: colors.textPrimary, fontSize: 28, fontWeight: '800', marginTop: 8 },
  heroProductType: { color: colors.textTertiary, fontSize: 11.5, marginTop: 6, textAlign: 'center' },
  loading: { minHeight: 320, alignItems: 'center', justifyContent: 'center' },
  mainGrid: { flexDirection: 'row', gap: 18, alignItems: 'flex-start' },
  leftColumn: { flex: 1.35, gap: 18 },
  purchaseCard: { flex: 0.65, gap: 14 },
  statusHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  currentPlan: { color: colors.ink, fontSize: 22, fontWeight: '800', marginTop: 8 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted },
  statusBadgeActive: { backgroundColor: colors.successTint },
  statusBadgeText: { color: colors.textSecondary, fontSize: 10, fontWeight: '800' },
  statusBadgeTextActive: { color: colors.success },
  statusStats: { flexDirection: 'row', gap: 12, marginTop: 20 },
  statusStat: { flex: 1, padding: 14, borderRadius: 13, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  statusLabel: { color: colors.textTertiary, fontSize: 10.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.7 },
  statusValue: { color: colors.ink, fontSize: 13.5, fontWeight: '700', marginTop: 5 },
  usageRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 18, marginBottom: 7 },
  usageLabel: { color: colors.textSecondary, fontSize: 12.5 },
  usageValue: { color: colors.ink, fontSize: 12.5, fontWeight: '700' },
  currentLimits: { marginTop: 18, gap: 10 },
  currentLimitsTitle: { color: colors.ink, fontSize: 12.5, fontWeight: '800' },
  currentLimitsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  currentLimit: { width: '31%', minWidth: 130, padding: 10, borderRadius: 10, backgroundColor: colors.surfaceMuted },
  currentLimitLabel: { color: colors.textTertiary, fontSize: 10.5, fontWeight: '700' },
  currentLimitValue: { color: colors.ink, fontSize: 12.5, fontWeight: '800', marginTop: 4 },
  comparisonHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  comparisonTitle: { color: colors.ink, fontSize: 18, fontWeight: '800', marginTop: 6 },
  comparisonNote: { color: colors.textTertiary, fontSize: 11.5, lineHeight: 16, marginTop: 10 },
  tableHeader: { flexDirection: 'row', marginTop: 18, paddingBottom: 9, borderBottomWidth: 1, borderBottomColor: colors.border },
  tableRow: { flexDirection: 'row', minHeight: 43, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tableCell: { flex: 1, color: colors.textSecondary, fontSize: 12.5, textAlign: 'center' },
  tableFeature: { flex: 1.35, color: colors.textPrimary, textAlign: 'left', fontWeight: '600' },
  tablePaid: { color: colors.accentBright, fontWeight: '800' },
  paidCell: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  paidValue: { color: colors.textPrimary, fontSize: 12.5, fontWeight: '800' },
  purchaseTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  purchasePrice: { color: colors.textPrimary, fontSize: 30, fontWeight: '800' },
  purchaseDescription: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 18 },
  notice: { flexDirection: 'row', gap: 9, padding: 12, borderRadius: 12, backgroundColor: colors.iceTint, borderWidth: 1, borderColor: colors.border },
  noticeText: { flex: 1, color: colors.textSecondary, fontSize: 11.5, lineHeight: 16 },
  noticeSuccess: { flexDirection: 'row', gap: 9, padding: 12, borderRadius: 12, backgroundColor: colors.successTint },
  noticeSuccessText: { flex: 1, color: colors.textSecondary, fontSize: 11.5, lineHeight: 16 },
  restoreText: { color: colors.textSecondary, fontSize: 11.5, lineHeight: 16 },
  productId: { color: colors.textTertiary, fontSize: 9.5, textAlign: 'center' },
  errorText: { color: colors.recordingRed, fontSize: 12.5, marginTop: 16 },
  footer: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, textAlign: 'center' },
});
