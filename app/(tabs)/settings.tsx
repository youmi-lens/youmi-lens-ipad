import { Ionicons } from '@expo/vector-icons';
import { ComponentProps, ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { SecondaryButton } from '@/components/SecondaryButton';
import { StatusPill } from '@/components/StatusPill';
import { colors, fontSize, layout, radius, spacing } from '@/constants/theme';
import { plan } from '@/data/mockData';
import { useAuth } from '@/lib/auth';
import { useData } from '@/lib/store';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

/** A section heading + a frosted card wrapping its rows. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <GlassCard padding={spacing.xs}>{children}</GlassCard>
    </View>
  );
}

/** A single tappable settings row: icon, label, trailing value, chevron. */
function Row({
  icon,
  label,
  value,
  last = false,
}: {
  icon: IoniconName;
  label: string;
  value?: string;
  last?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, !last && styles.rowDivider, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={19} color={colors.deepNavy} />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowRight}>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
        <Ionicons name="chevron-forward" size={17} color={colors.textTertiary} />
      </View>
    </Pressable>
  );
}

export default function SettingsScreen() {
  const { courses, lectures, clearAll } = useData();
  const { user, username, signOut } = useAuth();

  const email = user?.email ?? 'Signed in';
  const initials = email.slice(0, 2).toUpperCase();

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

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <Text style={styles.title}>Settings</Text>

          {/* Account */}
          <Section title="ACCOUNT">
            <View style={styles.account}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials}</Text>
              </View>
              <View style={styles.accountText}>
                <Text style={styles.accountName}>{username ?? 'No username set'}</Text>
                <Text style={styles.accountEmail}>{email}</Text>
              </View>
            </View>
            <SecondaryButton
              label="Sign Out"
              icon="log-out-outline"
              onPress={handleSignOut}
              danger
              style={styles.signOutButton}
            />
          </Section>

          {/* Plan */}
          <Section title="PLAN">
            <View style={styles.planBox}>
              <View style={styles.planTop}>
                <View>
                  <Text style={styles.planName}>Youmi Plan · {plan.name}</Text>
                  <Text style={styles.planSub}>{plan.renewLabel}</Text>
                </View>
                <StatusPill label="ACTIVE" variant="live" />
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${plan.progress * 100}%` }]} />
              </View>
              <Text style={styles.planUsage}>
                {plan.usedMinutes.toLocaleString()} minutes used · {plan.totalLabel} remaining
              </Text>
              <SecondaryButton
                label="Upgrade Plan"
                tone="ice"
                icon="arrow-up-circle-outline"
                style={styles.planButton}
              />
            </View>
          </Section>

          {/* Language */}
          <Section title="LANGUAGE">
            <Row icon="mic-outline" label="Caption Language" value="English" />
            <Row icon="language-outline" label="Translation Language" value="中文 (简体)" />
            <Row icon="globe-outline" label="App Language" value="English" last />
          </Section>

          {/* Sync */}
          <Section title="SYNC">
            <View style={styles.syncBox}>
              <View style={styles.syncTop}>
                <View style={styles.rowIcon}>
                  <Ionicons name="cloud-done-outline" size={19} color={colors.deepNavy} />
                </View>
                <View style={styles.syncText}>
                  <Text style={styles.rowLabel}>iCloud Sync</Text>
                  <Text style={styles.syncMeta}>Last synced 2 minutes ago</Text>
                </View>
                <StatusPill label="SYNCED" variant="synced" />
              </View>
              <SecondaryButton label="Sync Now" icon="sync-outline" style={styles.planButton} />
            </View>
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
  rowLabel: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textPrimary,
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
  progressTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.deepNavy,
  },
  planUsage: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '500',
    marginTop: spacing.sm,
  },
  planButton: {
    marginTop: spacing.lg,
  },
  syncBox: {
    padding: spacing.lg,
  },
  syncTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  syncText: {
    flex: 1,
    gap: 2,
  },
  syncMeta: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
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
