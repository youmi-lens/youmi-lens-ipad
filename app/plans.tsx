import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  type RestoreResult,
  type StudentPassProduct,
} from '@/lib/purchases';

type BusyAction = 'purchase' | 'restore' | null;

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
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Account status is unavailable.');
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
  useFocusEffect(useCallback(() => { void loadStatus(); }, [loadStatus]));

  const activeEntitlement = planStatus?.entitlement?.active ? planStatus.entitlement : null;
  const purchaseVisible = shouldShowPurchaseEntry(planStatus);
  const purchaseDisabled = isGuest || !accessToken || !purchaseVisible || productLoading || !product || busy !== null;
  const currentPlan = safeAccessLabel(planStatus?.planType, planStatus?.displayName);
  const recordingsRemaining = planStatus?.recordingsRemainingToday;
  const limit = planStatus?.maxRecordingsPerDay ?? 0;

  const handlePurchase = async () => {
    if (isGuest || !accessToken) return Alert.alert('Sign in required', 'Sign in before purchasing Student Basic.');
    setBusy('purchase');
    setRestoreResult(null);
    try {
      const result = await purchaseService.purchaseStudentPass(accessToken);
      await loadStatus();
      Alert.alert(result.ok ? 'Student Basic active' : 'Purchase not completed', result.message);
    } finally {
      setBusy(null);
    }
  };
  const handleRestore = async () => {
    if (isGuest || !accessToken) return Alert.alert('Sign in required', 'Sign in to refresh your purchase status.');
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
              <PageHeading eyebrow="Student access" title="More room for serious lecture weeks" />
              <Text style={styles.heroBody}>30 days of Student Basic access.</Text>
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
              <Text style={styles.heroProductType}>Apple consumable · backend-verified access</Text>
            </GlassCard>
          </View>

          {statusLoading && !planStatus ? (
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
                    <View style={[styles.statusBadge, activeEntitlement && styles.statusBadgeActive]}>
                      <Text style={[styles.statusBadgeText, activeEntitlement && styles.statusBadgeTextActive]}>
                        {activeEntitlement ? '● ACTIVE' : '● CURRENT'}
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
                          <Text style={styles.statusValue}>{activeEntitlement ? 'Active' : 'Not active'}</Text>
                        </View>
                        <View style={styles.statusStat}>
                          <Text style={styles.statusLabel}>Access ends</Text>
                          <Text style={styles.statusValue}>{formatDate(activeEntitlement?.expiresAt)}</Text>
                        </View>
                      </View>
                      <View style={styles.usageRow}>
                        <Text style={styles.usageLabel}>Current Free plan usage remaining</Text>
                        <Text style={styles.usageValue}>
                          {recordingsRemaining == null ? '—' : `${recordingsRemaining} of ${limit || '—'}`}
                        </Text>
                      </View>
                      <ProgressBar value={limit > 0 && recordingsRemaining != null ? recordingsRemaining / limit : 0} />
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
                {!purchaseVisible ? (
                  <View style={styles.notice}><Ionicons name="pause-circle-outline" size={18} color={colors.accentBright} /><Text style={styles.noticeText}>New Student Basic purchases are unavailable.</Text></View>
                ) : null}
                {!productLoading && !product ? (
                  <View style={styles.notice}><Ionicons name="alert-circle-outline" size={18} color={colors.accentBright} /><Text style={styles.noticeText}>Student Basic could not be fetched from the App Store.</Text></View>
                ) : null}

                {purchaseVisible ? (
                  <PrimaryButton label={busy === 'purchase' ? 'Purchasing…' : `Purchase ${product?.displayPrice ?? ''}`.trim()} icon="card-outline" onPress={() => void handlePurchase()} disabled={purchaseDisabled} />
                ) : null}
                <SecondaryButton label={busy === 'restore' ? 'Refreshing Access…' : 'Refresh Access'} icon="refresh-outline" onPress={() => void handleRestore()} disabled={busy !== null || isGuest || !accessToken} />
                {isGuest ? <SecondaryButton label="Sign in" icon="log-in-outline" onPress={() => void handleSignIn()} /> : null}
                {restoreResult ? <Text style={styles.restoreText}>{restoreResult.message || restoreMessageForCode(restoreResult.code)}</Text> : null}
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
