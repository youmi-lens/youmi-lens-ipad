import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { ComponentProps, useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ContentReveal } from '@/components/ContentReveal';
import { SkeletonBlock } from '@/components/ContentSkeleton';
import { GlassCard } from '@/components/GlassCard';
import { PageShellTransition } from '@/components/PageShellTransition';
import { PressableScale } from '@/components/PressableScale';
import { RenameModal } from '@/components/RenameModal';
import { PageHeading, ProgressBar } from '@/components/WorkspaceUI';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors, layout, radius } from '@/constants/theme';
import { deleteAccount } from '@/lib/account';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { ensureGuestIapIdentity, hasGuestIapIdentity } from '@/lib/guestIap';
import { useI18n } from '@/lib/i18n';
import { fetchPlanStatus, PlanStatus, safeAccessLabel } from '@/lib/planStatus';
import { subscriptionService } from '@/lib/subscriptions';
import { boundedPaymentTask, PAYMENT_UI_WAIT_TIMEOUT_MS } from '@/lib/boundedPaymentTask';
import { logDiag } from '@/lib/iapDiag';
import { useData } from '@/lib/store';
import { useTutorial } from '@/lib/tutorial';
import { useTutorialTour } from '@/lib/tutorialTour';
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
  roomy = false,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  last?: boolean;
  roomy?: boolean;
}) {
  const color = danger ? colors.recordingRed : colors.textPrimary;
  return (
    <PressableScale
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label}
      onPress={onPress}
      disabled={!onPress}
      scaleTo={0.995}
      pressedStyle={styles.rowPressed}
      style={[styles.settingRow, roomy && styles.settingRowRoomy, !last && styles.rowDivider]}
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
    </PressableScale>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const isCompact = useIsCompactWidth();
  const { courses, lectures, clearAll } = useData();
  const { user, username, signOut, session, updateUsername, clearLocalSession, isGuest, exitGuest } = useAuth();
  const { t, language, setLanguage, languages } = useI18n();
  const { openTutorial } = useTutorial();
  const { reopenTour } = useTutorialTour();
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
  // App Review 5.1.1(v): a Guest's Student Basic row must not read "Explore"
  // forever after a real purchase — this mirrors app/plans.tsx's read-only
  // guest status check (lib/guestIap.ts), reusing an EXISTING guest-IAP
  // identity if one is already on this device and never minting a new one
  // just from viewing Settings.
  const [guestPlanStatus, setGuestPlanStatus] = useState<PlanStatus | null>(null);
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
      const status = await boundedPaymentTask(() => fetchPlanStatus(session.access_token), PAYMENT_UI_WAIT_TIMEOUT_MS, 'plan_status');
      setPlanStatus(status);
      return status;
    } catch {
      setPlanError(t('settings.plan.statusUnavailable'));
      return null;
    } finally {
      setPlanLoading(false);
    }
  }, [session?.access_token, t]);
  const loadGuestPlan = useCallback(async () => {
    if (!(await hasGuestIapIdentity())) {
      setGuestPlanStatus(null);
      return;
    }
    const identity = await ensureGuestIapIdentity();
    if (!identity) {
      setGuestPlanStatus(null);
      return;
    }
    try {
      setGuestPlanStatus(await fetchPlanStatus(identity.accessToken));
    } catch {
      // Silent: this row falls back to "Explore" on failure, same as a
      // never-purchased guest — never a blocking error for a read-only check.
    }
  }, []);
  // Bumped once per tab focus, never by plan/account data — the page
  // heading's entrance below keys on this alone.
  const [focusKey, setFocusKey] = useState(0);
  useFocusEffect(useCallback(() => {
    setFocusKey((key) => key + 1);
    if (isGuest) void loadGuestPlan();
    else void loadPlan();
  }, [isGuest, loadGuestPlan, loadPlan]));

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
    // App Review 5.1.1(v): Apple purchase restoration must never require a
    // Youmi sign-in. This card is already hidden for Guests (see the isGuest
    // branch above, which routes to Plans — where Restore Purchases works
    // fully without sign-in), so this branch only guards a future entry
    // point; it must redirect, never claim sign-in is required.
    if (isGuest) {
      router.push('/plans');
      return;
    }
    if (!session?.access_token) {
      Alert.alert(t('settings.alerts.signInRequiredTitle'), t('settings.alerts.refreshSignInBody'));
      return;
    }
    if (restoringPurchases) return;
    setRestoringPurchases(true);
    try {
      const result = await subscriptionService.restore(session.access_token);
      logDiag('entitlement_refresh_started');
      const refreshedStatus = await boundedPaymentTask(loadPlan, PAYMENT_UI_WAIT_TIMEOUT_MS, 'entitlement_refresh');
      logDiag(refreshedStatus ? 'entitlement_refresh_succeeded' : 'entitlement_refresh_failed');
      if (!refreshedStatus && result.ok) {
        Alert.alert(t('settings.alerts.accessRefreshFailTitle'), t('settings.alerts.accessRefreshFailBody'));
        return;
      }
      Alert.alert(result.ok ? t('settings.alerts.accessRefreshedTitle') : t('settings.alerts.accessStatusTitle'), result.message);
    } catch (error) {
      logDiag('entitlement_refresh_failed');
      // Raw technical detail stays in logs; the user sees a localized generic message.
      console.warn('[settings] refresh access failed', error);
      Alert.alert(
        t('settings.alerts.accessRefreshFailTitle'),
        t('settings.alerts.accessRefreshFailBody'),
      );
    } finally {
      setRestoringPurchases(false);
      logDiag('restore_busy_cleared');
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
      <ScrollView contentContainerStyle={[styles.scroll, isCompact && styles.scrollCompact]} showsVerticalScrollIndicator={false}>
        {/* Whole shell — heading and the settings cards below it — settles
            together as one translate-only movement keyed to tab focus. */}
        <PageShellTransition style={styles.content} revealKey={focusKey}>
          <ContentReveal revealKey={focusKey}>
            <PageHeading eyebrow={t('settings.eyebrow')} title={t('settings.title')} />
          </ContentReveal>
          <View style={[styles.grid, isCompact ? styles.gridCompact : styles.gridWide]}>
            <View style={[styles.column, isCompact ? styles.columnCompact : styles.primaryColumn]}>
              <GlassCard padding={0} style={!isCompact ? styles.accountCardWide : undefined}>
                {isGuest ? (
                  <>
                    <View style={[styles.profile, !isCompact && styles.profileWide]}>
                      <View style={styles.avatar}><Text style={styles.avatarText}>G</Text></View>
                      <View style={styles.profileText}>
                        <Text style={styles.profileName}>{t('settings.account.guestName')}</Text>
                        <Text style={styles.profileEmail}>{t('settings.account.guestSubtitle')}</Text>
                      </View>
                    </View>
                    <SettingRow icon="sparkles-outline" label={t('settings.plan.studentBasicRow')} detail={t('settings.plan.studentBasicDetail')} value={guestPlanStatus?.entitlement?.active ? t('settings.plan.view') : t('settings.plan.explore')} onPress={() => router.push('/plans')} />
                    <SettingRow icon="log-in-outline" label={t('settings.account.signIn')} detail={t('settings.account.signInDetail')} onPress={handleGuestSignIn} roomy={!isCompact} last />
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
                    // Shaped like the usage block it becomes, so the card does
                    // not resize when the remote plan status lands. The rest of
                    // Settings has already painted from local state — only this
                    // one region waits on the network.
                    <View
                      style={styles.usageBlock}
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      <View style={styles.usageRow}>
                        <SkeletonBlock width="42%" height={13} />
                        <SkeletonBlock width="18%" height={13} />
                      </View>
                      <ProgressBar value={0} />
                      <View style={styles.usageRow}>
                        <SkeletonBlock width="34%" height={13} />
                        <SkeletonBlock width="22%" height={13} />
                      </View>
                      <View style={styles.accessLine}>
                        <SkeletonBlock width="38%" height={13} />
                        <SkeletonBlock width="26%" height={13} />
                      </View>
                    </View>
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
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel={t('settings.plan.tapToRetry')}
                      onPress={() => void loadPlan()}
                      style={styles.planLoading}
                    >
                      <Text style={styles.settingDetail}>{planError ?? t('settings.plan.statusUnavailable')} {t('settings.plan.tapToRetry')}</Text>
                    </PressableScale>
                  )}
                  <SettingRow icon="sparkles-outline" label={t('settings.plan.studentBasicRow')} detail={t('settings.plan.studentBasicDetail')} value={planStatus?.entitlement?.active ? t('settings.plan.view') : t('settings.plan.explore')} onPress={() => router.push('/plans')} />
                  <SettingRow icon="refresh-outline" label={restoringPurchases ? t('settings.plan.refreshing') : t('settings.plan.refresh')} onPress={restoringPurchases ? undefined : () => void handleRestorePurchases()} last />
                </GlassCard>
              ) : null}
            </View>

            <View style={[styles.column, isCompact ? styles.columnCompact : styles.secondaryColumn]}>
              <GlassCard padding={0}>
                <Text style={styles.cardHeading}>{t('settings.language.heading')}</Text>
                <SettingRow icon="mic-outline" label={t('settings.language.caption')} value={contentLabel(sourceLanguage)} onPress={() => setContentModal('source')} />
                <SettingRow icon="language-outline" label={t('settings.language.translation')} value={contentLabel(translationLanguage)} onPress={() => setContentModal('translation')} />
                <SettingRow icon="globe-outline" label={t('settings.language.app')} value={currentLanguageLabel} onPress={() => setLangModalVisible(true)} last />
              </GlassCard>

              <GlassCard padding={0}>
                <Text style={styles.cardHeading}>{t('settings.help.heading')}</Text>
                <SettingRow icon="sparkles-outline" label={t('settings.help.tutorial')} detail={t('settings.help.tutorialDetail')} onPress={reopenTour} />
                <SettingRow icon="school-outline" label={t('settings.help.quickOverview')} detail={t('settings.help.quickOverviewDetail')} onPress={openTutorial} last />
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
        </PageShellTransition>
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
  // Extra bottom clearance: on phone this screen sits above the collapsed
  // bottom tab bar (YLSidebar's BottomTabFrame), which the ScrollView's own
  // padding otherwise doesn't know about.
  scrollCompact: { paddingHorizontal: 18, paddingBottom: 100 },
  content: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 22 },
  grid: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  // Wide iPad remains a calm two-column settings page, but the account/plan
  // column has the slight priority its denser content needs. This prevents an
  // arbitrary equal-card desktop feel without widening reading lines.
  gridWide: { gap: 24 },
  // Compact stacking needs explicit full-width, content-height rules instead
  // of inheriting either of the wide columns' horizontal sizing contracts.
  gridCompact: { flexDirection: 'column', alignItems: 'stretch' },
  column: { gap: 16 },
  primaryColumn: { width: 340, minWidth: 340, maxWidth: 340, gap: 20 },
  secondaryColumn: { flexGrow: 1, flexShrink: 1, flexBasis: 0, width: 0, minWidth: 0, gap: 20 },
  columnCompact: { width: '100%', minWidth: 0, gap: 16 },
  accountCardWide: { width: 340, maxWidth: '100%', alignSelf: 'stretch' },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  profileWide: { gap: 15, paddingHorizontal: 24, paddingVertical: 24 },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy },
  avatarText: { color: colors.pearlWhite, fontSize: 16, fontWeight: '800' },
  profileText: { flex: 1, minWidth: 0 },
  profileName: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  profileEmail: { color: colors.textTertiary, fontSize: 11.5, marginTop: 3 },
  activeBadge: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.successTint },
  activeBadgeText: { color: colors.success, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  cardHeading: { color: colors.ink, fontSize: 15, fontWeight: '800', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10 },
  settingRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 20, paddingVertical: 10 },
  settingRowRoomy: { minHeight: 82, gap: 14, paddingHorizontal: 24, paddingVertical: 16 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  settingIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  settingIconDanger: { backgroundColor: colors.recordingTint },
  settingText: { flex: 1, minWidth: 0 },
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
  // Flat settings rows get the same background tint as other list rows; the
  // scale alone would read as the whole card flexing.
  rowPressed: { backgroundColor: colors.surfaceMuted },
  langOverlay: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.35)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  langSheet: { width: '100%', maxWidth: 420, backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  langSheetHeader: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
  langSheetTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  langSheetSubtitle: { color: colors.textTertiary, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
});
