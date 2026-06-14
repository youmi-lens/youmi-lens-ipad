import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { ComponentProps, useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { RenameModal } from '@/components/RenameModal';
import { PageHeading, ProgressBar } from '@/components/WorkspaceUI';
import { colors, layout, radius } from '@/constants/theme';
import { deleteAccount } from '@/lib/account';
import { useAuth } from '@/lib/auth';
import { fetchPlanStatus, PlanStatus, safeAccessLabel } from '@/lib/planStatus';
import { purchaseService } from '@/lib/purchases';
import { useData } from '@/lib/store';

type IconName = ComponentProps<typeof Ionicons>['name'];

function SettingRow({
  icon,
  label,
  detail,
  value,
  onPress,
  danger = false,
  last = false,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  last?: boolean;
}) {
  const color = danger ? colors.recordingRed : colors.textPrimary;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.settingRow, !last && styles.rowDivider, pressed && styles.pressed]}
    >
      <View style={[styles.settingIcon, danger && styles.settingIconDanger]}>
        <Ionicons name={icon} size={17} color={danger ? colors.recordingRed : colors.accentBright} />
      </View>
      <View style={styles.settingText}>
        <Text style={[styles.settingLabel, { color }]}>{label}</Text>
        {detail ? <Text style={styles.settingDetail}>{detail}</Text> : null}
      </View>
      {value ? <Text style={[styles.settingValue, danger && { color }]}>{value}</Text> : null}
      {onPress ? <Ionicons name="chevron-forward" size={17} color={danger ? colors.recordingRed : colors.textTertiary} /> : null}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const { courses, lectures, clearAll } = useData();
  const { user, username, signOut, session, updateUsername, clearLocalSession, isGuest, exitGuest } = useAuth();
  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [usernameModalVisible, setUsernameModalVisible] = useState(false);
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [restoringPurchases, setRestoringPurchases] = useState(false);

  const loadPlan = useCallback(async () => {
    if (!session?.access_token) {
      setPlanStatus(null);
      setPlanLoading(false);
      return;
    }
    setPlanLoading(true);
    setPlanError(null);
    try {
      setPlanStatus(await fetchPlanStatus(session.access_token));
    } catch {
      setPlanError('Account status unavailable.');
    } finally {
      setPlanLoading(false);
    }
  }, [session?.access_token]);
  useFocusEffect(useCallback(() => { void loadPlan(); }, [loadPlan]));

  const email = user?.email ?? 'Signed in';
  const displayName = username ?? email;
  const initials = (username ?? user?.email ?? 'U').split(/[\s@]+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const used = planStatus?.recordingsUsedToday ?? 0;
  const limit = planStatus?.maxRecordingsPerDay ?? 0;

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) Alert.alert('Unable to sign out', error);
  };
  const handleGuestSignIn = async () => { await exitGuest(); router.replace('/auth'); };
  const handleRestorePurchases = async () => {
    if (!session?.access_token || isGuest) {
      Alert.alert('Sign in required', 'Sign in to refresh your purchase status.');
      return;
    }
    if (restoringPurchases) return;
    setRestoringPurchases(true);
    try {
      const result = await purchaseService.restoreStudentPass(session.access_token);
      await loadPlan();
      Alert.alert(result.ok ? 'Access refreshed' : 'Access status', result.message);
    } catch (error) {
      Alert.alert(
        'Access refresh failed',
        error instanceof Error ? error.message : 'Please try again with a network connection.',
      );
    } finally {
      setRestoringPurchases(false);
    }
  };
  const handleClearData = () => Alert.alert('Clear Local Data', 'Permanently remove local courses and lectures from this device?', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear', style: 'destructive', onPress: clearAll },
  ]);
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
      if (error) await clearLocalSession();
      router.replace('/auth');
      Alert.alert('Account deleted', 'Your Youmi Lens account has been deleted.');
    } catch (error) {
      Alert.alert(
        'Could not delete account',
        error instanceof Error ? error.message : 'Please try again or contact support.',
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
                  onPress: () => void performAccountDeletion(),
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
    if (trimmed.length < 2 || trimmed.length > 64) return Alert.alert('Invalid username', 'Username must be 2–64 characters.');
    setUsernameSaving(true);
    const { error } = await updateUsername(trimmed);
    setUsernameSaving(false);
    if (error) return Alert.alert('Unable to update username', error);
    setUsernameModalVisible(false);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <PageHeading eyebrow="Preferences" title="Settings" />
          <View style={styles.grid}>
            <View style={styles.column}>
              <GlassCard padding={0}>
                {isGuest ? (
                  <>
                    <View style={styles.profile}>
                      <View style={styles.avatar}><Text style={styles.avatarText}>G</Text></View>
                      <View style={styles.profileText}>
                        <Text style={styles.profileName}>Guest</Text>
                        <Text style={styles.profileEmail}>Recordings stay on this device</Text>
                      </View>
                    </View>
                    <SettingRow icon="log-in-outline" label="Sign in" detail="Save and sync your lecture workspace." onPress={handleGuestSignIn} last />
                  </>
                ) : (
                  <>
                    <View style={styles.profile}>
                      <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
                      <View style={styles.profileText}>
                        <Text style={styles.profileName}>{displayName}</Text>
                        <Text style={styles.profileEmail}>{email}</Text>
                      </View>
                      <View style={styles.activeBadge}><Text style={styles.activeBadgeText}>● ACTIVE</Text></View>
                    </View>
                    <SettingRow icon="person-outline" label="Edit username" value={username ?? 'Not set'} onPress={() => setUsernameModalVisible(true)} />
                    <SettingRow icon="log-out-outline" label="Sign out" detail="You can sign back in anytime." onPress={() => void handleSignOut()} last />
                  </>
                )}
              </GlassCard>

              {!isGuest ? (
                <GlassCard padding={0}>
                  <Text style={styles.cardHeading}>Plan & usage</Text>
                  {planLoading && !planStatus ? (
                    <View style={styles.planLoading}><ActivityIndicator color={colors.accentBright} /></View>
                  ) : planStatus ? (
                    <View style={styles.usageBlock}>
                      <View style={styles.usageRow}>
                        <Text style={styles.usageLabel}>Recordings today</Text>
                        <Text style={styles.usageValue}>{used} / {limit || '—'}</Text>
                      </View>
                      <ProgressBar value={limit > 0 ? used / limit : 0} />
                      <View style={styles.usageRow}>
                        <Text style={styles.usageLabel}>Max length</Text>
                        <Text style={styles.usageValue}>{planStatus.maxRecordingMinutes ?? '—'} min</Text>
                      </View>
                      <View style={styles.accessLine}>
                        <Text style={styles.accessName}>{safeAccessLabel(planStatus.planType, planStatus.displayName)}</Text>
                        <Text style={styles.accessStatus}>{planStatus.entitlement?.active ? 'Active access' : 'Current access'}</Text>
                      </View>
                      <View style={styles.accessLine}>
                        <Text style={styles.accessName}>Access ends</Text>
                        <Text style={styles.accessStatus}>{formatDate(planStatus.entitlement?.expiresAt)}</Text>
                      </View>
                    </View>
                  ) : (
                    <Pressable onPress={() => void loadPlan()} style={styles.planLoading}>
                      <Text style={styles.settingDetail}>{planError ?? 'Account status unavailable.'} Tap to retry.</Text>
                    </Pressable>
                  )}
                  <SettingRow icon="sparkles-outline" label="Student Basic" detail="Compare access and 30-day quotas." value={planStatus?.entitlement?.active ? 'View' : 'Explore'} onPress={() => router.push('/plans')} />
                  <SettingRow icon="refresh-outline" label={restoringPurchases ? 'Refreshing Purchase Access…' : 'Refresh Purchase Access'} onPress={restoringPurchases ? undefined : () => void handleRestorePurchases()} last />
                </GlassCard>
              ) : null}
            </View>

            <View style={styles.column}>
              <GlassCard padding={0}>
                <Text style={styles.cardHeading}>Language</Text>
                <SettingRow icon="mic-outline" label="Caption language" value="English" onPress={() => Alert.alert('Caption Language', 'English is currently supported for live captions.')} />
                <SettingRow icon="language-outline" label="Translation language" value="中文（简体）" />
                <SettingRow icon="globe-outline" label="App language" value="English" last />
              </GlassCard>

              <GlassCard padding={0}>
                <Text style={styles.cardHeading}>Storage</Text>
                <SettingRow icon="cloud-outline" label="Account storage" detail="Lectures, transcripts and notes stay linked to your account." />
                <SettingRow icon="trash-bin-outline" label="Recently deleted" onPress={() => router.push('/recently-deleted')} />
                <SettingRow icon="folder-open-outline" label="Clear local data" detail={`${courses.length} courses · ${lectures.length} lectures on this device`} onPress={handleClearData} last />
              </GlassCard>

              {!isGuest ? (
                <GlassCard padding={0} style={styles.dangerCard}>
                  <SettingRow icon="trash-outline" label={deletingAccount ? 'Deleting account…' : 'Delete account'} detail="Permanently removes your account and associated data." onPress={deletingAccount ? undefined : confirmDeleteAccount} danger last />
                </GlassCard>
              ) : null}
              <Text style={styles.footer}>Youmi Lens for iPad · Version 1.0.0</Text>
            </View>
          </View>
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

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  scroll: { paddingHorizontal: layout.workspacePadding, paddingTop: 28, paddingBottom: 40 },
  content: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 22 },
  grid: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  column: { flex: 1, gap: 16 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  avatarText: { color: colors.pearlWhite, fontSize: 16, fontWeight: '800' },
  profileText: { flex: 1 },
  profileName: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  profileEmail: { color: colors.textTertiary, fontSize: 11.5, marginTop: 3 },
  activeBadge: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.successTint },
  activeBadgeText: { color: colors.success, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  cardHeading: { color: colors.ink, fontSize: 15, fontWeight: '800', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10 },
  settingRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 20, paddingVertical: 10 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  settingIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.iceTint },
  settingIconDanger: { backgroundColor: colors.recordingTint },
  settingText: { flex: 1 },
  settingLabel: { fontSize: 13.5, fontWeight: '700' },
  settingDetail: { color: colors.textTertiary, fontSize: 11.5, lineHeight: 16, marginTop: 2 },
  settingValue: { color: colors.textSecondary, fontSize: 12.5 },
  usageBlock: { paddingHorizontal: 20, paddingBottom: 12 },
  usageRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, marginBottom: 6 },
  usageLabel: { color: colors.textSecondary, fontSize: 13 },
  usageValue: { color: colors.ink, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  accessLine: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  accessName: { color: colors.ink, fontSize: 12.5, fontWeight: '700' },
  accessStatus: { color: colors.accentBright, fontSize: 12, fontWeight: '700' },
  planLoading: { minHeight: 72, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  dangerCard: { borderColor: colors.borderStrong },
  footer: { color: colors.textTertiary, fontSize: 11.5, textAlign: 'center', marginTop: 2 },
  pressed: { opacity: 0.68 },
});
