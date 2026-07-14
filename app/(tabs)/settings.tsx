import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { ComponentProps, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { RenameModal } from '@/components/RenameModal';
import { PageHeading, ProgressBar } from '@/components/WorkspaceUI';
import { colors, layout, radius } from '@/constants/theme';
import { deleteAccount } from '@/lib/account';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { fetchPlanStatus, PlanStatus, safeAccessLabel } from '@/lib/planStatus';
import { purchaseService } from '@/lib/purchases';
import { useData } from '@/lib/store';
import { loadContentLanguagePreferences, saveSourceLanguage, saveTranslationLanguage } from '@/lib/contentLanguagePreferences';
import type { ContentLanguage } from '@/lib/models';

const contentLanguages: ContentLanguage[] = ['en', 'zh-Hans', 'ja', 'fr', 'es', 'ko'];

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
  const { t, language, setLanguage, languages } = useI18n();
  const [langModalVisible, setLangModalVisible] = useState(false);
  const [contentModal, setContentModal] = useState<'source' | 'translation' | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState<ContentLanguage>('en');
  const [translationLanguage, setTranslationLanguage] = useState<ContentLanguage>('zh-Hans');
  useEffect(() => { void loadContentLanguagePreferences().then((value) => {
    setSourceLanguage(value.sourceLanguage); setTranslationLanguage(value.translationLanguage);
  }); }, []);
  const contentLabel = (code: ContentLanguage) => t(`settings.language.content.${code}`);
  const selectContentLanguage = async (kind: 'source' | 'translation', option: ContentLanguage) => {
    if (kind === 'source') {
      await saveSourceLanguage(option);
      setSourceLanguage(option);
    } else {
      await saveTranslationLanguage(option);
      setTranslationLanguage(option);
    }
    setContentModal(null);
  };
  const currentLanguageLabel = languages.find((option) => option.code === language)?.nativeLabel ?? 'English';
  const localDataCountKey = courses.length === 1
    ? lectures.length === 1 ? 'settings.storage.clearDetail.oneOne' : 'settings.storage.clearDetail.oneOther'
    : lectures.length === 1 ? 'settings.storage.clearDetail.otherOne' : 'settings.storage.clearDetail';
  // App version read from config (never hardcoded); '' if unavailable.
  const appVersion = Constants.expoConfig?.version ?? '';
  // Map the neutral access label (from safeAccessLabel — an App-Store-safe UI
  // label, not raw backend data) to a translation key. Falls back to the label
  // itself, so purchase logic and tier meaning are never altered.
  const accessLabelKey: Record<string, string> = {
    'Developer': 'settings.plan.access.developer',
    'Extended Access': 'settings.plan.access.extended',
    'Student Basic': 'settings.plan.access.studentBasic',
    'Student Access': 'settings.plan.access.studentAccess',
  };
  const localizedAccessLabel = (raw: string) => (accessLabelKey[raw] ? t(accessLabelKey[raw]) : raw);
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
      setPlanError(t('settings.plan.statusUnavailable'));
    } finally {
      setPlanLoading(false);
    }
  }, [session?.access_token, t]);
  useFocusEffect(useCallback(() => { void loadPlan(); }, [loadPlan]));

  const email = user?.email ?? t('sidebar.signedIn');
  const displayName = username ?? email;
  const initials = (username ?? user?.email ?? 'U').split(/[\s@]+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const used = planStatus?.recordingsUsedToday ?? 0;
  const limit = planStatus?.maxRecordingsPerDay ?? 0;

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) Alert.alert(t('settings.alerts.signOutFailTitle'), error);
  };
  const handleGuestSignIn = async () => { await exitGuest(); router.replace('/auth'); };
  const handleRestorePurchases = async () => {
    if (!session?.access_token || isGuest) {
      Alert.alert(t('settings.alerts.signInRequiredTitle'), t('settings.alerts.refreshSignInBody'));
      return;
    }
    if (restoringPurchases) return;
    setRestoringPurchases(true);
    try {
      const result = await purchaseService.restoreStudentPass(session.access_token);
      await loadPlan();
      Alert.alert(result.ok ? t('settings.alerts.accessRefreshedTitle') : t('settings.alerts.accessStatusTitle'), result.message);
    } catch (error) {
      // Raw technical detail stays in logs; the user sees a localized generic message.
      console.warn('[settings] refresh access failed', error);
      Alert.alert(
        t('settings.alerts.accessRefreshFailTitle'),
        t('settings.alerts.accessRefreshFailBody'),
      );
    } finally {
      setRestoringPurchases(false);
    }
  };
  const handleClearData = () => Alert.alert(t('settings.alerts.clearTitle'), t('settings.alerts.clearBody'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('common.clear'), style: 'destructive', onPress: clearAll },
  ]);
  const performAccountDeletion = async () => {
    if (deletingAccount) return;
    const token = session?.access_token;
    if (!token) {
      Alert.alert(t('settings.alerts.signInRequiredTitle'), t('settings.alerts.deleteSignInBody'));
      return;
    }
    setDeletingAccount(true);
    try {
      await deleteAccount(token);
      await clearAll();
      const { error } = await signOut();
      if (error) await clearLocalSession();
      router.replace('/auth');
      Alert.alert(t('settings.alerts.accountDeletedTitle'), t('settings.alerts.accountDeletedBody'));
    } catch (error) {
      // Raw technical detail stays in logs; the user sees a localized generic message.
      console.warn('[settings] account deletion failed', error);
      Alert.alert(
        t('settings.alerts.deleteFailTitle'),
        t('settings.alerts.deleteFailBody'),
      );
    } finally {
      setDeletingAccount(false);
    }
  };
  const confirmDeleteAccount = () => {
    Alert.alert(
      t('settings.alerts.deleteConfirmTitle'),
      t('settings.alerts.deleteConfirmBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.continue'),
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              t('settings.alerts.deleteConfirm2Title'),
              t('settings.alerts.deleteConfirm2Body'),
              [
                { text: t('common.cancel'), style: 'cancel' },
                {
                  text: t('settings.alerts.deleteConfirmCta'),
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
    if (trimmed.length < 2 || trimmed.length > 64) return Alert.alert(t('settings.alerts.invalidUsernameTitle'), t('settings.alerts.invalidUsernameBody'));
    setUsernameSaving(true);
    const { error } = await updateUsername(trimmed);
    setUsernameSaving(false);
    if (error) return Alert.alert(t('settings.alerts.updateUsernameFailTitle'), error);
    setUsernameModalVisible(false);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <PageHeading eyebrow={t('settings.eyebrow')} title={t('settings.title')} />
          <View style={styles.grid}>
            <View style={styles.column}>
              <GlassCard padding={0}>
                {isGuest ? (
                  <>
                    <View style={styles.profile}>
                      <View style={styles.avatar}><Text style={styles.avatarText}>G</Text></View>
                      <View style={styles.profileText}>
                        <Text style={styles.profileName}>{t('settings.account.guestName')}</Text>
                        <Text style={styles.profileEmail}>{t('settings.account.guestSubtitle')}</Text>
                      </View>
                    </View>
                    <SettingRow icon="log-in-outline" label={t('settings.account.signIn')} detail={t('settings.account.signInDetail')} onPress={handleGuestSignIn} last />
                  </>
                ) : (
                  <>
                    <View style={styles.profile}>
                      <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
                      <View style={styles.profileText}>
                        <Text style={styles.profileName}>{displayName}</Text>
                        <Text style={styles.profileEmail}>{email}</Text>
                      </View>
                      <View style={styles.activeBadge}><Text style={styles.activeBadgeText}>{t('settings.account.activeBadge')}</Text></View>
                    </View>
                    <SettingRow icon="person-outline" label={t('settings.account.editUsername')} value={username ?? t('settings.account.notSet')} onPress={() => setUsernameModalVisible(true)} />
                    <SettingRow icon="log-out-outline" label={t('settings.account.signOut')} detail={t('settings.account.signOutDetail')} onPress={() => void handleSignOut()} last />
                  </>
                )}
              </GlassCard>

              {!isGuest ? (
                <GlassCard padding={0}>
                  <Text style={styles.cardHeading}>{t('settings.plan.heading')}</Text>
                  {planLoading && !planStatus ? (
                    <View style={styles.planLoading}><ActivityIndicator color={colors.navy} /></View>
                  ) : planStatus ? (
                    <View style={styles.usageBlock}>
                      <View style={styles.usageRow}>
                        <Text style={styles.usageLabel}>{t('settings.plan.recordingsToday')}</Text>
                        <Text style={styles.usageValue}>{used} / {limit || '—'}</Text>
                      </View>
                      <ProgressBar value={limit > 0 ? used / limit : 0} />
                      <View style={styles.usageRow}>
                        <Text style={styles.usageLabel}>{t('settings.plan.maxLength')}</Text>
                        <Text style={styles.usageValue}>{t('settings.plan.minutesValue', { minutes: planStatus.maxRecordingMinutes ?? '—' })}</Text>
                      </View>
                      <View style={styles.accessLine}>
                        <Text style={styles.accessName}>{localizedAccessLabel(safeAccessLabel(planStatus.planType, planStatus.displayName))}</Text>
                        <Text style={styles.accessStatus}>{planStatus.entitlement?.active ? t('settings.plan.activeAccess') : t('settings.plan.currentAccess')}</Text>
                      </View>
                      <View style={styles.accessLine}>
                        <Text style={styles.accessName}>{t('settings.plan.accessEnds')}</Text>
                        <Text style={styles.accessStatus}>{formatDate(planStatus.entitlement?.expiresAt, language) || '—'}</Text>
                      </View>
                    </View>
                  ) : (
                    <Pressable onPress={() => void loadPlan()} style={styles.planLoading}>
                      <Text style={styles.settingDetail}>{planError ?? t('settings.plan.statusUnavailable')} {t('settings.plan.tapToRetry')}</Text>
                    </Pressable>
                  )}
                  <SettingRow icon="sparkles-outline" label={t('settings.plan.studentBasicRow')} detail={t('settings.plan.studentBasicDetail')} value={planStatus?.entitlement?.active ? t('settings.plan.view') : t('settings.plan.explore')} onPress={() => router.push('/plans')} />
                  <SettingRow icon="refresh-outline" label={restoringPurchases ? t('settings.plan.refreshing') : t('settings.plan.refresh')} onPress={restoringPurchases ? undefined : () => void handleRestorePurchases()} last />
                </GlassCard>
              ) : null}
            </View>

            <View style={styles.column}>
              <GlassCard padding={0}>
                <Text style={styles.cardHeading}>{t('settings.language.heading')}</Text>
                <SettingRow icon="mic-outline" label={t('settings.language.caption')} value={contentLabel(sourceLanguage)} onPress={() => setContentModal('source')} />
                <SettingRow icon="language-outline" label={t('settings.language.translation')} value={contentLabel(translationLanguage)} onPress={() => setContentModal('translation')} />
                <SettingRow icon="globe-outline" label={t('settings.language.app')} value={currentLanguageLabel} onPress={() => setLangModalVisible(true)} last />
              </GlassCard>

              <GlassCard padding={0}>
                <Text style={styles.cardHeading}>{t('settings.storage.heading')}</Text>
                <SettingRow icon="cloud-outline" label={t('settings.storage.account')} detail={t('settings.storage.accountDetail')} />
                <SettingRow icon="trash-bin-outline" label={t('settings.storage.recentlyDeleted')} onPress={() => router.push('/recently-deleted')} />
                <SettingRow icon="folder-open-outline" label={t('settings.storage.clear')} detail={t(localDataCountKey, { courses: courses.length, lectures: lectures.length })} onPress={handleClearData} last />
              </GlassCard>

              {!isGuest ? (
                <GlassCard padding={0} style={styles.dangerCard}>
                  <SettingRow icon="trash-outline" label={deletingAccount ? t('settings.delete.deleting') : t('settings.delete.label')} detail={t('settings.delete.detail')} onPress={deletingAccount ? undefined : confirmDeleteAccount} danger last />
                </GlassCard>
              ) : null}
              <Text style={styles.footer}>{t('settings.footer', { version: appVersion || '1.0.0' })}</Text>
            </View>
          </View>
        </View>
      </ScrollView>
      <RenameModal
        visible={usernameModalVisible}
        title={t('settings.username.modalTitle')}
        label={t('settings.username.modalLabel')}
        initialValue={username ?? ''}
        placeholder={t('settings.username.modalPlaceholder')}
        onCancel={() => { if (!usernameSaving) setUsernameModalVisible(false); }}
        onSave={(value) => { void handleSaveUsername(value); }}
      />
      <Modal
        visible={langModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLangModalVisible(false)}
      >
        <Pressable style={styles.langOverlay} onPress={() => setLangModalVisible(false)}>
          <Pressable style={styles.langSheet} onPress={() => {}}>
            <View style={styles.langSheetHeader}>
              <Text style={styles.langSheetTitle}>{t('settings.language.selectTitle')}</Text>
              <Text style={styles.langSheetSubtitle}>{t('settings.language.selectSubtitle')}</Text>
            </View>
            {languages.map((option, index) => (
              <SettingRow
                key={option.code}
                icon={option.code === language ? 'checkmark-circle' : 'ellipse-outline'}
                label={option.nativeLabel}
                detail={option.label}
                onPress={() => { setLanguage(option.code); setLangModalVisible(false); }}
                last={index === languages.length - 1}
              />
            ))}
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={contentModal !== null} transparent animationType="fade" onRequestClose={() => setContentModal(null)}>
        <Pressable style={styles.langOverlay} onPress={() => setContentModal(null)}>
          <Pressable style={styles.langSheet} onPress={() => {}}>
            <View style={styles.langSheetHeader}>
              <Text style={styles.langSheetTitle}>{contentModal === 'source' ? t('settings.language.caption') : t('settings.language.translation')}</Text>
            </View>
            {contentLanguages.map((option, index) => {
              const selected = contentModal === 'source' ? sourceLanguage === option : translationLanguage === option;
              return <SettingRow key={option} icon={selected ? 'checkmark-circle' : 'ellipse-outline'} label={contentLabel(option)} onPress={() => {
                if (contentModal) void selectContentLanguage(contentModal, option);
              }} last={index === contentLanguages.length - 1} />;
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  scroll: { paddingHorizontal: layout.workspacePadding, paddingTop: 28, paddingBottom: 40 },
  content: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 22 },
  grid: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  column: { flex: 1, gap: 16 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy },
  avatarText: { color: colors.pearlWhite, fontSize: 16, fontWeight: '800' },
  profileText: { flex: 1 },
  profileName: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  profileEmail: { color: colors.textTertiary, fontSize: 11.5, marginTop: 3 },
  activeBadge: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.successTint },
  activeBadgeText: { color: colors.success, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  cardHeading: { color: colors.ink, fontSize: 15, fontWeight: '800', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10 },
  settingRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 20, paddingVertical: 10 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  settingIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
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
  accessStatus: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  planLoading: { minHeight: 72, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  dangerCard: { borderColor: colors.borderStrong },
  footer: { color: colors.textTertiary, fontSize: 11.5, textAlign: 'center', marginTop: 2 },
  pressed: { opacity: 0.68 },
  langOverlay: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.35)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  langSheet: { width: '100%', maxWidth: 420, backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  langSheetHeader: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
  langSheetTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  langSheetSubtitle: { color: colors.textTertiary, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
});
