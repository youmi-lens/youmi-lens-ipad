/**
 * Recently Deleted — recovery for soft-deleted courses and lectures.
 *
 * Deleting a course or lecture elsewhere in the app moves it here (sets
 * deletedAt) rather than destroying it. From here the user can Restore an
 * item or, with confirmation, Delete Permanently.
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ComponentProps } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { colors, fontSize, layout, radius, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/format';
import { useI18n, useT, localizeSystemDefaultTitle } from '@/lib/i18n';
import { useData } from '@/lib/store';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

function DeletedItem({
  icon,
  title,
  typeLabel,
  deletedAt,
  deletionSyncState,
  onRestore,
  onRetryDeletion,
  onPermanentDelete,
}: {
  icon: IoniconName;
  title: string;
  typeLabel: string;
  deletedAt: string | null;
  deletionSyncState?: 'pending' | 'failed';
  onRestore: () => void;
  onRetryDeletion?: () => void;
  onPermanentDelete: () => void;
}) {
  const { t, language } = useI18n();
  return (
    <GlassCard style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <View style={styles.itemIcon}>
          <Ionicons name={icon} size={20} color={colors.deepNavy} />
        </View>
        <View style={styles.itemText}>
          <Text style={styles.itemTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.itemMeta}>
            {typeLabel}
            {deletedAt ? ` · ${t('deleted.deletedOn', { date: formatShortDate(deletedAt, language) })}` : ''}
          </Text>
        </View>
      </View>
      {deletionSyncState === 'failed' ? (
        <Text style={styles.syncError}>Cloud deletion was not confirmed. Retry before treating this as deleted on other devices.</Text>
      ) : deletionSyncState === 'pending' ? (
        <Text style={styles.syncPending}>Confirming deletion across your devices…</Text>
      ) : null}
      <View style={styles.itemActions}>
        {deletionSyncState === 'failed' && onRetryDeletion ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Retry cloud deletion for ${title}`}
            onPress={onRetryDeletion}
            style={({ pressed }) => [styles.actionBtn, styles.retryBtn, pressed && styles.pressed]}
          >
            <Ionicons name="refresh-outline" size={16} color={colors.deepNavy} />
            <Text style={styles.restoreLabel}>Retry sync</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('deleted.restoreItem', { title })}
          onPress={onRestore}
          style={({ pressed }) => [styles.actionBtn, styles.restoreBtn, pressed && styles.pressed]}
        >
          <Ionicons name="arrow-undo-outline" size={16} color={colors.deepNavy} />
          <Text style={styles.restoreLabel}>{t('deleted.restore')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('deleted.deleteItem', { title })}
          onPress={onPermanentDelete}
          style={({ pressed }) => [styles.actionBtn, styles.deleteBtn, pressed && styles.pressed]}
        >
          <Ionicons name="trash-outline" size={16} color={colors.recordingRed} />
          <Text style={styles.deleteLabel}>{t('deleted.deletePermanently')}</Text>
        </Pressable>
      </View>
    </GlassCard>
  );
}

export default function RecentlyDeletedScreen() {
  const t = useT();
  const router = useRouter();
  const {
    deletedCourses,
    deletedLectures,
    restoreCourse,
    restoreLecture,
    retryLectureDeletion,
    permanentlyDeleteCourse,
    permanentlyDeleteLecture,
  } = useData();

  const isEmpty = deletedCourses.length === 0 && deletedLectures.length === 0;

  // Newest deletions first.
  const sortedCourses = [...deletedCourses].sort((a, b) =>
    (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''),
  );
  const sortedLectures = [...deletedLectures].sort((a, b) =>
    (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''),
  );

  const confirmPermanentDelete = (kind: 'course' | 'lecture', id: string, title: string) => {
    Alert.alert(
      t('deleted.confirmTitle'),
      t('deleted.confirmBody', { title }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('deleted.deletePermanently'),
          style: 'destructive',
          onPress: () => {
            if (kind === 'course') permanentlyDeleteCourse(id);
            else permanentlyDeleteLecture(id);
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={24} color={colors.deepNavy} />
        </Pressable>
        <Text style={styles.headerTitle}>{t('deleted.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          {isEmpty ? (
            <GlassCard style={styles.emptyCard}>
              <View style={styles.emptyIcon}>
                <Ionicons name="trash-outline" size={30} color={colors.deepNavy} />
              </View>
              <Text style={styles.emptyTitle}>{t('deleted.empty')}</Text>
              <Text style={styles.emptyBody}>
                {t('deleted.emptyBody')}
              </Text>
            </GlassCard>
          ) : (
            <>
              <Text style={styles.retentionNote}>
                {t('deleted.retentionNote')}
              </Text>

              {sortedCourses.length > 0 ? (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>{t('deleted.courses')}</Text>
                  {sortedCourses.map((course) => (
                    <DeletedItem
                      key={course.id}
                      icon="library-outline"
                      title={localizeSystemDefaultTitle(t, course.name)}
                      typeLabel="Course"
                      deletedAt={course.deletedAt ?? null}
                      onRestore={() => restoreCourse(course.id)}
                      onPermanentDelete={() =>
                        confirmPermanentDelete('course', course.id, course.name)
                      }
                    />
                  ))}
                </View>
              ) : null}

              {sortedLectures.length > 0 ? (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>{t('deleted.lectures')}</Text>
                  {sortedLectures.map((lecture) => (
                    <DeletedItem
                      key={lecture.id}
                      icon="document-text-outline"
                      title={localizeSystemDefaultTitle(t, lecture.title)}
                      typeLabel="Lecture"
                      deletedAt={lecture.deletedAt ?? null}
                      deletionSyncState={lecture.deletionSyncState}
                      onRestore={() => restoreLecture(lecture.id)}
                      onRetryDeletion={() => retryLectureDeletion(lecture.id)}
                      onPermanentDelete={() =>
                        confirmPermanentDelete('lecture', lecture.id, lecture.title)
                      }
                    />
                  ))}
                </View>
              ) : null}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
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
  retentionNote: {
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.5,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  section: { gap: spacing.md },
  sectionTitle: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: colors.textTertiary,
    marginLeft: spacing.xs,
  },
  itemCard: { gap: spacing.lg },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  itemIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.iceTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemText: { flex: 1, gap: 2 },
  itemTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.textPrimary },
  itemMeta: { fontSize: fontSize.sm, color: colors.textTertiary, fontWeight: '500' },
  itemActions: { flexDirection: 'row', gap: spacing.md },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  restoreBtn: { backgroundColor: colors.surface, borderColor: colors.borderStrong },
  retryBtn: { backgroundColor: colors.iceTint, borderColor: colors.iceBlue },
  restoreLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.deepNavy },
  deleteBtn: { backgroundColor: colors.recordingTint, borderColor: colors.recordingTint },
  deleteLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.recordingRed },
  syncError: { fontSize: fontSize.sm, lineHeight: fontSize.sm * 1.4, color: colors.recordingRed, fontWeight: '600' },
  syncPending: { fontSize: fontSize.sm, lineHeight: fontSize.sm * 1.4, color: colors.textSecondary, fontWeight: '600' },
  emptyCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: radius.xl,
    backgroundColor: colors.iceTint,
    borderWidth: 1,
    borderColor: colors.iceBlue,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  emptyBody: {
    marginTop: spacing.sm,
    maxWidth: 320,
    textAlign: 'center',
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.5,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
});
