/**
 * Access & Usage screen (route: /plans).
 *
 * Youmi Lens is free for students. This screen shows the user's current
 * access tier, monthly + daily minute budgets, recordings used today, and
 * per-recording / per-live-session caps. All numbers come from the backend
 * `/api/quota/status` — the same endpoint the Settings Plan card uses, and
 * the same backend the Mac client reads from. Quota is account-level
 * (Supabase user_id), so usage on iPad and Mac shares the same numbers.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
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
import { fetchPlanStatus, PlanStatus } from '@/lib/planStatus';

const CONTACT_EMAIL = 'youmilens@gmail.com';

export default function PlansScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;

  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!accessToken) {
      setPlanStatus(null);
      setLoading(false);
      setError('Sign in to view your access.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setPlanStatus(await fetchPlanStatus(accessToken));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Access information is unavailable.');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  // Refetch every time the screen regains focus — keeps the numbers in
  // sync with Mac-side usage, which is the whole point of this page.
  useFocusEffect(
    useCallback(() => {
      void loadStatus();
    }, [loadStatus]),
  );

  const openMailto = useCallback(() => {
    Linking.openURL(`mailto:${CONTACT_EMAIL}?subject=Youmi%20Lens%20access`).catch(() => {
      Alert.alert('Could not open mail', `Please email ${CONTACT_EMAIL} manually.`);
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
        <Text style={styles.headerTitle}>Access & Usage</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.heroBlock}>
            <Text style={styles.heroTitle}>Youmi Lens is free for students.</Text>
            <Text style={styles.heroSubtitle}>
              Daily and monthly limits help keep the service stable for students. Your usage is
              shared across iPad and Mac.
            </Text>
          </View>

          {loading && !planStatus ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.deepNavy} />
            </View>
          ) : !planStatus ? (
            <ErrorCard
              message={error ?? 'Access information is unavailable.'}
              onRetry={() => void loadStatus()}
            />
          ) : (
            <AccessCards status={planStatus} />
          )}

          <GlassCard style={styles.contactCard}>
            <View style={styles.contactRow}>
              <View style={styles.contactIcon}>
                <Ionicons name="mail-outline" size={20} color={colors.deepNavy} />
              </View>
              <View style={styles.contactText}>
                <Text style={styles.contactTitle}>Need extended access?</Text>
                <Text style={styles.contactBody}>
                  If you need more capacity for coursework, contact us.
                </Text>
              </View>
            </View>
            <SecondaryButton
              label={CONTACT_EMAIL}
              icon="mail-outline"
              onPress={openMailto}
              style={styles.contactButton}
            />
          </GlassCard>

          <Text style={styles.footerNote}>
            Youmi Lens is available with free student access. Usage limits help keep the service
            stable.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function AccessCards({ status }: { status: PlanStatus }) {
  if (status.status === 'suspended') {
    return (
      <GlassCard style={styles.tierCard}>
        <View style={styles.tierHeader}>
          <Text style={styles.tierName}>{status.displayName}</Text>
          <View style={styles.suspendedPill}>
            <Text style={styles.suspendedPillText}>ON HOLD</Text>
          </View>
        </View>
        <Text style={styles.tierBlurb}>
          Your account is currently on hold. Please contact support for help.
        </Text>
      </GlassCard>
    );
  }

  if (status.unlimited) {
    return (
      <GlassCard style={styles.tierCard}>
        <View style={styles.tierHeader}>
          <Text style={styles.tierName}>{status.displayName}</Text>
          <View style={styles.activePill}>
            <Ionicons name="checkmark" size={12} color="#157A58" />
            <Text style={styles.activePillText}>UNLIMITED</Text>
          </View>
        </View>
        <Text style={styles.tierBlurb}>Usage limits are bypassed for this account.</Text>
      </GlassCard>
    );
  }

  return (
    <View style={styles.cards}>
      <GlassCard style={styles.tierCard}>
        <View style={styles.tierHeader}>
          <Text style={styles.tierName}>{status.displayName}</Text>
          <View style={styles.activePill}>
            <Ionicons name="checkmark" size={12} color="#157A58" />
            <Text style={styles.activePillText}>ACTIVE</Text>
          </View>
        </View>
        <Text style={styles.tierBlurb}>
          {tierBlurbFor(status.planType)}
        </Text>
      </GlassCard>

      <UsageCard
        title="Monthly minutes"
        used={status.minutesUsed}
        limit={status.minutesLimit}
        remaining={status.minutesRemaining}
        unit="min"
      />
      <UsageCard
        title="Daily minutes"
        used={status.dailyMinutesUsed}
        limit={status.dailyMinutesLimit}
        remaining={status.dailyMinutesRemaining}
        unit="min"
      />
      <UsageCard
        title="Recordings today"
        used={status.recordingsUsedToday}
        limit={status.maxRecordingsPerDay}
        remaining={status.recordingsRemainingToday}
        unit="recordings"
      />

      <GlassCard style={styles.limitsCard}>
        <Text style={styles.limitsTitle}>Per-session limits</Text>
        <LimitLine
          label="Max recording length"
          value={formatMinutes(status.maxRecordingMinutes)}
        />
        <LimitLine
          label="Max live session length"
          value={formatMinutes(status.maxLiveSessionMinutes)}
        />
      </GlassCard>
    </View>
  );
}

function UsageCard({
  title,
  used,
  limit,
  remaining,
  unit,
}: {
  title: string;
  used?: number;
  limit?: number | null;
  remaining?: number | null;
  unit: string;
}) {
  const usedDisplay = used == null ? '—' : Math.round(used).toString();
  const limitDisplay = limit == null ? '—' : Math.round(limit).toString();
  const remainingDisplay =
    remaining == null ? null : Math.max(0, Math.round(remaining)).toString();
  const exhausted = remaining != null && Number(remaining) <= 0;

  return (
    <GlassCard style={styles.usageCard}>
      <View style={styles.usageHeader}>
        <Text style={styles.usageTitle}>{title}</Text>
        {exhausted ? (
          <View style={styles.warningPill}>
            <Text style={styles.warningPillText}>LIMIT REACHED</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.usageMain}>
        <Text style={styles.usageMainUsed}>{usedDisplay}</Text>
        <Text style={styles.usageMainSep}> / </Text>
        <Text style={styles.usageMainLimit}>{limitDisplay} </Text>
        <Text style={styles.usageMainUnit}>{unit}</Text>
      </Text>
      {remainingDisplay ? (
        <Text style={styles.usageRemaining}>{remainingDisplay} remaining</Text>
      ) : null}
    </GlassCard>
  );
}

function LimitLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.limitsLine}>
      <Text style={styles.limitsLineLabel}>{label}</Text>
      <Text style={styles.limitsLineValue}>{value}</Text>
    </View>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <GlassCard style={styles.tierCard}>
      <Text style={styles.tierName}>Access unavailable</Text>
      <Text style={styles.tierBlurb}>{message}</Text>
      <SecondaryButton
        label="Retry"
        icon="refresh-outline"
        onPress={onRetry}
        style={styles.contactButton}
      />
    </GlassCard>
  );
}

function tierBlurbFor(planType: string): string {
  switch (planType) {
    case 'public_trial':
      return 'Free student access. Usage limits help keep the service stable.';
    case 'core_tester':
      return 'Extended access for active users.';
    case 'admin':
    case 'developer':
      return 'Developer account — limits are bypassed.';
    default:
      return 'Free access. Usage limits help keep the service stable.';
  }
}

function formatMinutes(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Math.round(Number(value))} min`;
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

  // Hero
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

  // States
  loading: { paddingVertical: spacing.xxxl, alignItems: 'center' },

  // Card list
  cards: { gap: spacing.lg },

  // Tier card
  tierCard: { gap: spacing.md },
  tierHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  tierName: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  tierBlurb: {
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.5,
    color: colors.textSecondary,
    fontWeight: '500',
  },
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
  suspendedPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: '#FCE4E0',
  },
  suspendedPillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    color: '#C0392B',
  },

  // Usage card
  usageCard: { gap: spacing.xs },
  usageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  usageTitle: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: colors.textTertiary,
  },
  warningPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: '#FCE4E0',
  },
  warningPillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    color: '#C0392B',
  },
  usageMain: { color: colors.textPrimary },
  usageMainUsed: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.textPrimary },
  usageMainSep: { fontSize: fontSize.lg, fontWeight: '600', color: colors.textTertiary },
  usageMainLimit: { fontSize: fontSize.lg, fontWeight: '700', color: colors.textSecondary },
  usageMainUnit: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textTertiary },
  usageRemaining: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textSecondary },

  // Limits card
  limitsCard: { gap: spacing.sm },
  limitsTitle: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: colors.textTertiary,
  },
  limitsLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  limitsLineLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  limitsLineValue: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '700',
  },

  // Contact
  contactCard: { gap: spacing.md },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  contactIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.iceTint,
    borderWidth: 1,
    borderColor: colors.iceBlue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactText: { flex: 1, gap: 2 },
  contactTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary },
  contactBody: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '500' },
  contactButton: { alignSelf: 'stretch' },

  footerNote: {
    fontSize: fontSize.xs,
    lineHeight: fontSize.xs * 1.5,
    color: colors.textTertiary,
    fontWeight: '500',
    textAlign: 'center',
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
});
