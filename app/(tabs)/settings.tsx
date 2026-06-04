import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { ComponentProps, ReactNode, useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { RenameModal } from '@/components/RenameModal';
import { SecondaryButton } from '@/components/SecondaryButton';
import { StatusPill } from '@/components/StatusPill';
import { colors, fontSize, layout, radius, spacing } from '@/constants/theme';
import { deleteAccount } from '@/lib/account';
import { useAuth } from '@/lib/auth';
import { fetchPlanStatus, PlanStatus, safeAccessLabel } from '@/lib/planStatus';
import { purchaseService } from '@/lib/purchases';
import { useData } from '@/lib/store';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

/** A section heading + a frosted card wrapping its rows, with optional footer copy. */
function Section({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: string;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <GlassCard padding={spacing.xs}>{children}</GlassCard>
      {footer ? <Text style={styles.sectionFooter}>{footer}</Text> : null}
    </View>
  );
}

/**
 * A settings row: icon, label, trailing value. `readOnly` hides the chevron
 * for fixed V1 rows; a row with `onPress` stays tappable (e.g. to show an
 * info alert) and keeps press feedback.
 */
function Row({
  icon,
  label,
  value,
  last = false,
  onPress,
  readOnly = false,
  danger = false,
}: {
  icon: IoniconName;
  label: string;
  value?: string;
  last?: boolean;
  onPress?: () => void;
  readOnly?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, !last && styles.rowDivider, pressed && styles.rowPressed]}
    >
      <View style={[styles.rowIcon, danger && styles.rowIconDanger]}>
        <Ionicons name={icon} size={19} color={danger ? colors.recordingRed : colors.deepNavy} />
      </View>
      <Text style={[styles.rowLabel, danger && styles.rowLabelDanger]}>{label}</Text>
      <View style={styles.rowRight}>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
        {!readOnly ? (
          <Ionicons name="chevron-forward" size={17} color={danger ? colors.recordingRed : colors.textTertiary} />
        ) : null}
      </View>
    </Pressable>
  );
}

/** A label + value line inside the Plan card (e.g. "Today · 0 / 2 recordings used"). */
function PlanLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.planLine}>
      <Text style={styles.planLineLabel}>{label}</Text>
      <Text style={styles.planLineValue}>{value}</Text>
    </View>
  );
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

export default function SettingsScreen() {
  const router = useRouter();
  const { courses, lectures, clearAll } = useData();
  const { user, username, signOut, session, updateUsername, clearLocalSession, isGuest, exitGuest } =
    useAuth();

  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [usernameModalVisible, setUsernameModalVisible] = useState(false);
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [restoringPurchases, setRestoringPurchases] = useState(false);

  // Load the live plan from the backend. Any previously loaded plan stays
  // visible if a refresh fails, so Settings never blocks on a network error.
  const loadPlan = useCallback(async () => {
    const token = session?.access_token;
    if (!token) {
      setPlanStatus(null);
      setPlanError('Account status unavailable.');
      setPlanLoading(false);
      return;
    }
    setPlanLoading(true);
    setPlanError(null);
    try {
      setPlanStatus(await fetchPlanStatus(token));
    } catch {
      setPlanError('Account status unavailable.');
    } finally {
      setPlanLoading(false);
    }
  }, [session?.access_token]);

  // Refetch whenever the Settings tab regains focus — the plan may be changed
  // directly in the database, so it is never cached for the whole session.
  useFocusEffect(
    useCallback(() => {
      void loadPlan();
    }, [loadPlan]),
  );

  /**
   * V1 caption language is fixed to English — the live pipeline only has
   * English realtime ASR plus Chinese translation of English text. Tapping
   * the row explains that honestly rather than offering an unsupported choice.
   */
  const showCaptionLanguageInfo = () => {
    Alert.alert(
      'Caption Language',
      'English is the current supported lecture caption language. More caption languages are coming later.',
    );
  };

  const email = user?.email ?? 'Signed in';

  // Display name: username first, email second.
  const displayName = username ?? email;

  // Avatar initials: first letter(s) of username words, else first letter of
  // email, else 'U'.
  const initials = (() => {
    if (username) {
      const words = username.trim().split(/\s+/);
      if (words.length >= 2) {
        return (words[0][0] + words[1][0]).toUpperCase();
      }
      return words[0][0].toUpperCase();
    }
    if (user?.email) {
      return user.email[0].toUpperCase();
    }
    return 'U';
  })();

  const handleClearData = () => {
    Alert.alert(
      'Clear Local Data',
      'This permanently removes all local courses and lectures stored on this device. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => clearAll() },
      ],
    );
  };

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) {
      Alert.alert('Unable to sign out', error);
    }
  };

  const handleGuestSignIn = async () => {
    await exitGuest();
    router.replace('/auth');
  };

  const handleRestorePurchases = async () => {
    if (isGuest || !session?.access_token) {
      Alert.alert('Sign in required', 'Sign in to restore purchases.');
      return;
    }
    if (restoringPurchases) return;
    setRestoringPurchases(true);
    try {
      const result = await purchaseService.restoreStudentPass(session.access_token);
      await loadPlan();
      Alert.alert(result.ok ? 'Restore complete' : 'Restore result', result.message);
    } catch (err) {
      Alert.alert(
        'Restore failed',
        err instanceof Error ? err.message : 'Please try again with a network connection.',
      );
    } finally {
      setRestoringPurchases(false);
    }
  };

  const performAccountDeletion = async () => {
    if (deletingAccount) return;
    const token = session?.access_token;
    if (!token) {
      Alert.alert('Sign in required', 'Please sign in again before deleting your account.');
      return;
    }

    setDeletingAccount(true);
    try {
      await deleteAccount(token);
      await clearAll();
      const { error } = await signOut();
      if (error) {
        await clearLocalSession();
      }
      router.replace('/auth');
      Alert.alert('Account deleted', 'Your Youmi Lens account has been deleted.');
    } catch (err) {
      Alert.alert(
        'Could not delete account',
        err instanceof Error ? err.message : 'Please try again or contact support.',
      );
    } finally {
      setDeletingAccount(false);
    }
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      'Delete Account?',
      'This will permanently delete your Youmi Lens account and associated data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Confirm Deletion',
              'Are you absolutely sure? Your recordings, transcripts, summaries, and usage history may be deleted.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete Account',
                  style: 'destructive',
                  onPress: () => {
                    void performAccountDeletion();
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  const handleSaveUsername = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      Alert.alert('Username required', 'Username cannot be empty.');
      return;
    }
    if (trimmed.length < 2 || trimmed.length > 64) {
      Alert.alert('Username too short or long', 'Username must be 2–64 characters.');
      return;
    }

    setUsernameSaving(true);
    const { error } = await updateUsername(trimmed);
    setUsernameSaving(false);
    if (error) {
      Alert.alert('Unable to update username', error);
      return;
    }

    setUsernameModalVisible(false);
    Alert.alert('Username updated', 'Your profile name has been updated.');
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <Text style={styles.title}>Settings</Text>

          {/* Account — guest sees a sign-in invitation instead of account details */}
          {isGuest ? (
            <Section title="ACCOUNT" footer="Guest recordings are stored only on this device.">
              <View style={styles.storageNote}>
                <View style={styles.rowIcon}>
                  <Ionicons name="person-outline" size={19} color={colors.deepNavy} />
                </View>
                <Text style={styles.storageText}>
                  You’re using Youmi Lens without an account. Sign in to save and sync your lectures.
                </Text>
              </View>
              <SecondaryButton
                label="Sign In"
                icon="log-in-outline"
                onPress={handleGuestSignIn}
                style={styles.signOutButton}
              />
            </Section>
          ) : (
            <Section title="ACCOUNT">
              <View style={styles.account}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initials}</Text>
                </View>
                <View style={styles.accountText}>
                  <Text style={styles.accountName}>{displayName}</Text>
                  <Text style={styles.accountEmail}>{email}</Text>
                </View>
              </View>
              <Row
                icon="person-outline"
                label="Edit Username"
                value={username ?? 'Not set'}
                onPress={() => setUsernameModalVisible(true)}
              />
              <Row
                icon="trash-outline"
                label={deletingAccount ? 'Deleting Account…' : 'Delete Account'}
                onPress={deletingAccount ? undefined : confirmDeleteAccount}
                danger
              />
              <Text style={styles.deleteAccountHelp}>
                Permanently delete your Youmi Lens account and associated data.
              </Text>
              <SecondaryButton
                label="Sign Out"
                icon="log-out-outline"
                onPress={handleSignOut}
                danger
                style={styles.signOutButton}
              />
            </Section>
          )}

          {/* Account & Usage — account-only; guests have no backend usage. Live
              summary from the backend, followed by the entry row to the full
              Account & Usage screen. */}
          {!isGuest ? (
          <Section title="ACCOUNT & USAGE">
            {planStatus ? (
              <View style={styles.planBox}>
                <View style={styles.planTop}>
                  <View style={styles.planHeadText}>
                    <Text style={styles.planName}>
                      {safeAccessLabel(planStatus.planType, planStatus.displayName)}
                    </Text>
                    <Text style={styles.planSub}>Account status</Text>
                  </View>
                  {planStatus.status === 'suspended' ? (
                    <View style={styles.suspendedPill}>
                      <Text style={styles.suspendedPillText}>ON HOLD</Text>
                    </View>
                  ) : (
                    <StatusPill label="ACTIVE" variant="live" />
                  )}
                </View>

                {planStatus.unlimited ? (
                  <Text style={styles.planUsage}>Account active</Text>
                ) : (
                  <View style={styles.planLines}>
                    <PlanLine
                      label="Recordings today"
                      value={`${planStatus.recordingsUsedToday ?? 0}`}
                    />
                    <PlanLine
                      label="Recording length"
                      value={`${planStatus.maxRecordingMinutes ?? 0} min`}
                    />
                  </View>
                )}

                {planStatus.status === 'suspended' ? (
                  <Text style={styles.planHelper}>Contact support to continue.</Text>
                ) : null}
                <View style={styles.entitlementBox}>
                  <PlanLine
                    label="Student Pass"
                    value={planStatus.entitlement?.active ? 'Active' : 'Not active'}
                  />
                  <PlanLine
                    label="Expires"
                    value={formatDate(planStatus.entitlement?.expiresAt)}
                  />
                </View>
              </View>
            ) : planLoading ? (
              <View style={styles.planStateBox}>
                <ActivityIndicator color={colors.deepNavy} />
                <Text style={styles.planStateText}>Loading account…</Text>
              </View>
            ) : (
              <View style={styles.planStateBox}>
                <Text style={styles.planStateText}>{planError ?? 'Account status unavailable.'}</Text>
                <SecondaryButton
                  label="Retry"
                  icon="refresh-outline"
                  onPress={() => void loadPlan()}
                  style={styles.planRetry}
                />
              </View>
            )}
            <Row
              icon="information-circle-outline"
              label="Account & Usage"
              onPress={() => router.push('/plans')}
            />
            <Row
              icon="refresh-outline"
              label={restoringPurchases ? 'Restoring Purchases…' : 'Restore Purchases'}
              onPress={restoringPurchases ? undefined : handleRestorePurchases}
              last
            />
          </Section>
          ) : null}

          {/* Language — English captions + Chinese study support, fixed for V1 */}
          <Section
            title="LANGUAGE"
            footer="Youmi Lens is currently optimized for English lectures with Chinese study support. More caption languages are coming later."
          >
            <Row
              icon="mic-outline"
              label="Caption Language"
              value="English"
              onPress={showCaptionLanguageInfo}
              readOnly
            />
            <Row
              icon="language-outline"
              label="Translation Language"
              value="中文（简体）"
              readOnly
            />
            <Row
              icon="globe-outline"
              label="App Language"
              value="English"
              readOnly
              last
            />
          </Section>

          {/* Account Storage — account-only; honest, informational (no sync UI) */}
          {!isGuest ? (
            <Section
              title="ACCOUNT STORAGE"
              footer="Data is kept separate for each signed-in account."
            >
              <View style={styles.storageNote}>
                <View style={styles.rowIcon}>
                  <Ionicons name="folder-outline" size={19} color={colors.deepNavy} />
                </View>
                <Text style={styles.storageText}>
                  Your lectures, transcripts, summaries, and notes are saved to your Youmi Lens account.
                </Text>
              </View>
            </Section>
          ) : null}

          {/* Recently Deleted — recovery for deleted courses & lectures */}
          <Section
            title="RECENTLY DELETED"
            footer="Items in Recently Deleted can be restored or permanently deleted."
          >
            <Row
              icon="trash-outline"
              label="View deleted items"
              onPress={() => router.push('/recently-deleted')}
              last
            />
          </Section>

          {/* Developer — local testing tools */}
          <Section title="DEVELOPER">
            <View style={styles.devMetaWrap}>
              <Ionicons name="hardware-chip-outline" size={18} color={colors.mutedBlueGray} />
              <Text style={styles.devMeta}>
                {courses.length} {courses.length === 1 ? 'course' : 'courses'} ·{' '}
                {lectures.length} {lectures.length === 1 ? 'lecture' : 'lectures'} stored locally
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear local data"
              onPress={handleClearData}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.clearIcon}>
                <Ionicons name="trash-outline" size={19} color={colors.recordingRed} />
              </View>
              <Text style={styles.clearLabel}>Clear Local Data</Text>
              <Ionicons name="chevron-forward" size={17} color={colors.recordingRed} />
            </Pressable>
          </Section>

          <Text style={styles.footer}>Youmi Lens for iPad · Version 1.0.0</Text>
        </View>
      </ScrollView>
      <RenameModal
        visible={usernameModalVisible}
        title="Edit Username"
        label="Username"
        initialValue={username ?? ''}
        placeholder="Your username"
        onCancel={() => { if (!usernameSaving) setUsernameModalVisible(false); }}
        onSave={(value) => { void handleSaveUsername(value); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  content: {
    width: '100%',
    maxWidth: layout.content,
    alignSelf: 'center',
    gap: spacing.xl,
  },
  title: {
    fontSize: fontSize.display,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: colors.textTertiary,
    marginLeft: spacing.xs,
  },
  sectionFooter: {
    fontSize: fontSize.xs,
    lineHeight: fontSize.xs * 1.5,
    fontWeight: '500',
    color: colors.textTertiary,
    marginLeft: spacing.xs,
    marginTop: 2,
  },
  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.deepNavy,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.textOnNavy,
    fontSize: fontSize.xl,
    fontWeight: '700',
  },
  accountText: {
    gap: 2,
  },
  signOutButton: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  accountName: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  accountEmail: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.iceTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowIconDanger: {
    backgroundColor: colors.recordingTint,
  },
  rowLabel: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  rowLabelDanger: {
    color: colors.recordingRed,
  },
  deleteAccountHelp: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    marginTop: -spacing.xs,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.4,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowValue: {
    fontSize: fontSize.md,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  planBox: {
    padding: spacing.lg,
  },
  planTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  planName: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  planSub: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
    marginTop: 2,
  },
  planUsage: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  planHeadText: {
    flex: 1,
  },
  planLines: {
    gap: spacing.sm,
  },
  entitlementBox: {
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  planLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  planLineLabel: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '600',
  },
  planLineValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  planHelper: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '500',
    marginTop: spacing.md,
  },
  planStateBox: {
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.md,
  },
  planStateText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  planRetry: {
    alignSelf: 'center',
  },
  suspendedPill: {
    borderRadius: radius.pill,
    backgroundColor: colors.recordingTint,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  suspendedPillText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: '#C0392B',
  },
  storageNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  storageText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.5,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  devMetaWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  devMeta: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  clearIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.recordingTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearLabel: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.recordingRed,
  },
  footer: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    textAlign: 'center',
    fontWeight: '500',
    marginTop: spacing.sm,
  },
});
