import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ComponentProps, useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { RenameModal } from '@/components/RenameModal';
import { SecondaryButton } from '@/components/SecondaryButton';
import { StatusPill, StatusVariant } from '@/components/StatusPill';
import { SwipeDeleteRow } from '@/components/SwipeDeleteRow';
import { colors, fontSize, layout, radius, spacing } from '@/constants/theme';
import { formatDate, formatDuration, formatShortDate } from '@/lib/format';
import { pickAndImportPdf } from '@/lib/importMaterial';
import { useI18n, localizeSystemDefaultTitle } from '@/lib/i18n';
import type { CourseMaterial, Lecture } from '@/lib/models';
import { useData } from '@/lib/store';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type LectureStatusDisplay = {
  label: string;
  variant: StatusVariant;
};

function lectureStatus(lecture: Lecture, t: (key: string) => string): LectureStatusDisplay {
  if (lecture.status === 'in_progress') return { label: t('status.inProgress'), variant: 'recording' };
  if (lecture.processingStatus === 'ready' || (lecture.transcript && (lecture.summaryEn || lecture.summaryZh))) {
    return { label: t('status.ready'), variant: 'done' };
  }
  if (lecture.processingStatus === 'processing') return { label: t('status.processing'), variant: 'processing' };
  if (lecture.processingStatus === 'failed') return { label: t('status.failed'), variant: 'idle' };
  if (lecture.uploadStatus === 'uploaded') return { label: t('status.uploaded'), variant: 'synced' };
  if (lecture.uploadStatus === 'uploading') return { label: t('status.uploading'), variant: 'processing' };
  if (lecture.uploadStatus === 'upload_failed') return { label: t('status.uploadFailed'), variant: 'idle' };
  return { label: t('status.recorded'), variant: 'idle' };
}

export default function CourseDetailScreen() {
  const { t, language } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const {
    getCourse,
    lecturesForCourse,
    setSelectedCourseId,
    deleteLecture,
    deleteLectures,
    renameCourse,
    renameLecture,
    currentUserId,
    materialsForCourse,
    addMaterial,
    renameMaterial,
    deleteMaterial,
    countAnnotationsForMaterial,
  } = useData();

  const course = getCourse(params.id);
  const lectures = course
    ? [...lecturesForCourse(course.id)].sort((a, b) => b.date.localeCompare(a.date))
    : [];
  const materials = course ? materialsForCourse(course.id) : [];
  const latestLecture = lectures[0];
  const [openLectureId, setOpenLectureId] = useState<string | null>(null);

  // Rename course modal
  const [courseRenameVisible, setCourseRenameVisible] = useState(false);

  // Rename lecture modal
  const [renameLectureTarget, setRenameLectureTarget] = useState<Lecture | null>(null);

  // Materials state
  const [importing, setImporting] = useState(false);
  const [openMaterialId, setOpenMaterialId] = useState<string | null>(null);
  const [renameMaterialTarget, setRenameMaterialTarget] = useState<CourseMaterial | null>(null);

  // ── Multi-select lecture delete (selection mode) ──
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const exitSelectionMode = useCallback(() => {
    setSelecting(false);
    setSelectedIds(new Set());
  }, []);

  // Navigate-away safety: selection is local to this screen. Leaving it (back
  // gesture / push a stack route) must always clear the mode and the set.
  useFocusEffect(
    useCallback(() => {
      return () => exitSelectionMode();
    }, [exitSelectionMode]),
  );

  const handleImportMaterial = async () => {
    if (!course || importing) return;
    setImporting(true);
    const result = await pickAndImportPdf({ courseId: course.id, userId: currentUserId });
    setImporting(false);
    if (result.ok) {
      addMaterial(result.material);
      return;
    }
    if (result.canceled) return; // user dismissed picker — no alert
    Alert.alert(t('course.importFail'), result.reason);
  };

  const confirmDeleteMaterial = (materialId: string) => {
    Alert.alert(
      t('course.deleteMaterialTitle'), t('course.deleteMaterialBody'),
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => setOpenMaterialId(null) },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteMaterial(materialId);
            setOpenMaterialId(null);
          },
        },
      ],
    );
  };

  const openMaterial = (materialId: string) => {
    setOpenMaterialId(null);
    router.push({
      pathname: '/lecture-material/[lectureId]/[materialId]',
      params: { lectureId: '__material_review__', materialId },
    });
  };

  const formatBytes = (bytes?: number): string => {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
  };

  if (!course) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.notFound}>
          <Ionicons name="library-outline" size={36} color={colors.mutedBlueGray} />
          <Text style={styles.notFoundTitle}>{t('course.notFound')}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/courses')}
            style={({ pressed }) => [styles.softButton, pressed && styles.pressed]}
          >
            <Text style={styles.softButtonLabel}>{t('course.back')}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const startLecture = () => {
    setSelectedCourseId(course.id);
    router.push({ pathname: '/recording', params: { courseId: course.id, lectureTitle: '' } });
  };

  const openLecture = (lectureId: string) => {
    setOpenLectureId(null);
    // In-progress lectures reopen into the recording screen to continue; others
    // open their detail page.
    const lecture = lectures.find((l) => l.id === lectureId);
    if (lecture?.status === 'in_progress') {
      router.push({ pathname: '/recording', params: { lectureId } });
      return;
    }
    router.push({ pathname: '/lecture/[id]', params: { id: lectureId } });
  };

  const confirmDeleteLecture = (lectureId: string) => {
    Alert.alert(
      t('course.deleteLectureTitle'), t('course.deleteLectureBody'),
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => setOpenLectureId(null) },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteLecture(lectureId);
            setOpenLectureId(null);
          },
        },
      ],
    );
  };

  const toggleSelection = (lectureId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(lectureId)) next.delete(lectureId);
      else next.add(lectureId);
      return next;
    });
  };

  // One batch confirmation, then a single local-first soft delete of the
  // snapshotted UUIDs. Selected cards disappear because the store's
  // `deleteLectures` stamps `deletedAt` (active views hide them), never because
  // the UI filters them away — that distinction is what keeps the soft-delete
  // contract (and Recently Deleted restore) intact.
  const confirmBatchDelete = () => {
    if (selectedIds.size === 0) return;
    Alert.alert(
      t('course.deleteLecturesTitle'), t('course.deleteLecturesBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            const ids = Array.from(selectedIds);
            deleteLectures(ids);
            exitSelectionMode();
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
        <Text style={styles.headerTitle} numberOfLines={1}>{t('course.detail')}</Text>
        {selecting ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
            onPress={exitSelectionMode}
            hitSlop={10}
            style={({ pressed }) => [styles.selectButton, pressed && styles.pressed]}
          >
            <Text style={styles.selectButtonLabel}>{t('common.cancel')}</Text>
          </Pressable>
        ) : (
          <View style={styles.headerActions}>
            {lectures.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('course.select')}
                onPress={() => {
                  setOpenLectureId(null);
                  setSelecting(true);
                }}
                hitSlop={10}
                style={({ pressed }) => [styles.selectButton, pressed && styles.pressed]}
              >
                <Text style={styles.selectButtonLabel}>{t('course.select')}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('course.rename')}
              onPress={() => setCourseRenameVisible(true)}
              hitSlop={10}
              style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}
            >
              <Ionicons name="pencil-outline" size={20} color={colors.deepNavy} />
            </Pressable>
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => setOpenLectureId(null)}
      >
        <View style={styles.content}>
          <GlassCard>
            <View style={styles.heroHeader}>
              <View style={[styles.courseTile, { backgroundColor: course.tint }]}>
                <Ionicons name={course.icon as IoniconName} size={28} color={course.accent} />
              </View>
              <View style={styles.heroText}>
                <Text style={styles.courseName}>{localizeSystemDefaultTitle(t, course.name)}</Text>
                <View style={styles.metaRow}>
                  <Text style={styles.metaText}>
                    {t(lectures.length === 1 ? 'course.lectureCount' : 'course.lectureCountOther', { count: lectures.length })}
                  </Text>
                  <View style={styles.metaDot} />
                  <Text style={styles.metaText}>
                    {latestLecture ? t('course.lastRecorded', { date: formatShortDate(latestLecture.date, language) }) : t('course.noRecordings')}
                  </Text>
                </View>
              </View>
            </View>
            <PrimaryButton label={t('course.start')} icon="mic" onPress={startLecture} style={styles.startButton} />
          </GlassCard>

          {/* ───── Course Materials (Build 7 V1.1, local-only) ───── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t('course.materials')}</Text>
            <Text style={styles.sectionMeta}>
              {t(materials.length === 1 ? 'course.itemCount' : 'course.itemCountOther', { count: materials.length })}
            </Text>
          </View>

          <GlassCard style={styles.materialsCard}>
            <Text style={styles.materialsBanner}>
              {t('course.materialsLocal')}
            </Text>
            {materials.length === 0 ? (
              <View style={styles.materialsEmpty}>
                <View style={styles.materialsEmptyIcon}>
                  <Ionicons name="document-attach-outline" size={26} color={colors.deepNavy} />
                </View>
                <Text style={styles.materialsEmptyTitle}>{t('course.noMaterials')}</Text>
                <Text style={styles.materialsEmptyBody}>
                  {t('course.materialsEmptyDetail')}
                </Text>
              </View>
            ) : (
              <View style={styles.materialList}>
                {materials.map((material, index) => {
                  const annotationCount = countAnnotationsForMaterial(material.id);
                  return (
                  <SwipeDeleteRow
                    key={material.id}
                    open={openMaterialId === material.id}
                    onOpen={() => setOpenMaterialId(material.id)}
                    onClose={() => setOpenMaterialId(null)}
                    onDelete={() => confirmDeleteMaterial(material.id)}
                    style={index < materials.length - 1 ? styles.materialDivider : undefined}
                  >
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => openMaterial(material.id)}
                      style={({ pressed }) => [styles.materialRow, pressed && styles.lecturePressed]}
                    >
                      <View style={[styles.materialIcon, { backgroundColor: course.tint }]}>
                        <Ionicons name="document-text-outline" size={20} color={course.accent} />
                      </View>
                      <View style={styles.materialBody}>
                        <Text style={styles.materialTitle} numberOfLines={1}>{localizeSystemDefaultTitle(t, material.title)}</Text>
                        <View style={styles.materialMetaRow}>
                          <Text style={styles.lectureMeta}>PDF</Text>
                          {material.pageCount ? (
                            <>
                              <View style={styles.metaDot} />
                              <Text style={styles.lectureMeta}>
                                {t(material.pageCount === 1 ? 'course.pageCountOne' : 'course.pageCount', { count: material.pageCount })}
                              </Text>
                            </>
                          ) : null}
                          {formatBytes(material.fileSize) ? (
                            <>
                              <View style={styles.metaDot} />
                              <Text style={styles.lectureMeta}>{formatBytes(material.fileSize)}</Text>
                            </>
                          ) : null}
                          {material.lastOpenedPage ? (
                            <>
                              <View style={styles.metaDot} />
                              <Text style={styles.lectureMeta}>{t('course.lastOpenedPage', { page: material.lastOpenedPage })}</Text>
                            </>
                          ) : null}
                          {annotationCount > 0 ? (
                            <>
                              <View style={styles.metaDot} />
                              <Text style={styles.lectureMeta}>
                                {t(annotationCount === 1 ? 'course.annotationCountOne' : 'course.annotationCount', { count: annotationCount })}
                              </Text>
                            </>
                          ) : null}
                        </View>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('course.renameMaterial')}
                        hitSlop={8}
                        onPress={(e) => {
                          e.stopPropagation();
                          setOpenMaterialId(null);
                          setRenameMaterialTarget(material);
                        }}
                        style={({ pressed }) => [styles.rowMenuButton, pressed && styles.pressed]}
                      >
                        <Ionicons name="pencil-outline" size={17} color={colors.textTertiary} />
                      </Pressable>
                      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                    </Pressable>
                  </SwipeDeleteRow>
                  );
                })}
              </View>
            )}
            <SecondaryButton
              label={importing ? t('common.importing') : t('common.importPdf')}
              icon="cloud-upload-outline"
              onPress={() => { void handleImportMaterial(); }}
              disabled={importing}
              style={styles.materialsImportButton}
            />
            {importing ? (
              <View style={styles.materialsImportingHint}>
                <ActivityIndicator color={colors.deepNavy} />
                <Text style={styles.materialsImportingLabel}>
                  {t('course.readingFiles')}
                </Text>
              </View>
            ) : null}
          </GlassCard>

          {/* ───── Lectures ───── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t('course.lectures')}</Text>
            {latestLecture ? (
              <Text style={styles.sectionMeta}>{t('course.latest', { date: formatDate(latestLecture.date, language) })}</Text>
            ) : null}
          </View>

          {lectures.length === 0 ? (
            <GlassCard style={styles.emptyCard}>
              <View style={styles.emptyIcon}>
                <Ionicons name="mic-outline" size={28} color={colors.deepNavy} />
              </View>
              <Text style={styles.emptyTitle}>{t('course.noLectures')}</Text>
              <Text style={styles.emptyBody}>{t('course.emptyLectureBody')}</Text>
              <PrimaryButton label={t('course.startFirst')} icon="mic" onPress={startLecture} style={styles.emptyButton} />
            </GlassCard>
          ) : (
            <View style={styles.lectureList}>
              {lectures.map((lecture, index) => {
                      const status = lectureStatus(lecture, t);
                      const isSelected = selectedIds.has(lecture.id);
                return (
                  <SwipeDeleteRow
                    key={lecture.id}
                    enabled={!selecting}
                    open={!selecting && openLectureId === lecture.id}
                    onOpen={() => setOpenLectureId(lecture.id)}
                    onClose={() => setOpenLectureId(null)}
                    onDelete={() => confirmDeleteLecture(lecture.id)}
                    style={index < lectures.length - 1 ? styles.lectureDivider : undefined}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        selecting
                          ? t('course.selectLecture', { title: localizeSystemDefaultTitle(t, lecture.title) })
                          : localizeSystemDefaultTitle(t, lecture.title)
                      }
                      onPress={() => (selecting ? toggleSelection(lecture.id) : openLecture(lecture.id))}
                      style={({ pressed }) => [
                        styles.lectureRow,
                        isSelected && styles.lectureRowSelected,
                        pressed && styles.lecturePressed,
                      ]}
                    >
                      {selecting ? (
                        <View style={[styles.selectCircle, isSelected && styles.selectCircleOn]}>
                          {isSelected ? <Ionicons name="checkmark" size={16} color={colors.pearlWhite} /> : null}
                        </View>
                      ) : (
                        <View style={[styles.lectureIcon, { backgroundColor: course.tint }]}>
                          <Ionicons name="document-text-outline" size={20} color={course.accent} />
                        </View>
                      )}
                      <View style={styles.lectureBody}>
                        <Text style={styles.lectureTitle} numberOfLines={1}>{localizeSystemDefaultTitle(t, lecture.title)}</Text>
                        <View style={styles.lectureMetaRow}>
                          <Text style={styles.lectureMeta}>{formatDate(lecture.date, language)}</Text>
                          <View style={styles.metaDot} />
                          <Text style={styles.lectureMeta}>{formatDuration(lecture.durationMillis)}</Text>
                        </View>
                      </View>
                      {selecting ? null : (
                        <>
                          <StatusPill label={status.label} variant={status.variant} />
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('course.renameLecture')}
                            hitSlop={8}
                            onPress={(e) => {
                              e.stopPropagation();
                              setOpenLectureId(null);
                              setRenameLectureTarget(lecture);
                            }}
                            style={({ pressed }) => [styles.rowMenuButton, pressed && styles.pressed]}
                          >
                            <Ionicons name="pencil-outline" size={17} color={colors.textTertiary} />
                          </Pressable>
                          <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                        </>
                      )}
                    </Pressable>
                  </SwipeDeleteRow>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      {selecting ? (
        <View style={styles.selectionBar}>
          <PrimaryButton
            label={t('course.deleteSelected', { count: selectedIds.size })}
            icon="trash-outline"
            disabled={selectedIds.size === 0}
            onPress={confirmBatchDelete}
            style={styles.deleteSelectedButton}
          />
        </View>
      ) : null}

      {/* Rename course modal */}
      <RenameModal
        visible={courseRenameVisible}
        title={t('rename.courseTitle')}
        label={t('rename.courseLabel')}
        initialValue={course.name}
        placeholder={t('rename.coursePlaceholder')}
        onCancel={() => setCourseRenameVisible(false)}
        onSave={(name) => {
          renameCourse(course.id, name);
          setCourseRenameVisible(false);
        }}
      />

      {/* Rename lecture modal (per-row) */}
      <RenameModal
        visible={renameLectureTarget !== null}
        title={t('rename.lectureTitle')}
        label={t('rename.lectureLabel')}
        initialValue={renameLectureTarget?.title ?? ''}
        placeholder={t('rename.lecturePlaceholder')}
        onCancel={() => setRenameLectureTarget(null)}
        onSave={(title) => {
          if (renameLectureTarget) renameLecture(renameLectureTarget.id, title);
          setRenameLectureTarget(null);
        }}
      />

      {/* Rename material modal (per-row) */}
      <RenameModal
        visible={renameMaterialTarget !== null}
        title={t('rename.materialTitle')}
        label={t('rename.materialLabel')}
        initialValue={renameMaterialTarget?.title ?? ''}
        placeholder={t('rename.materialPlaceholder')}
        onCancel={() => setRenameMaterialTarget(null)}
        onSave={(title) => {
          if (renameMaterialTarget) renameMaterial(renameMaterialTarget.id, title);
          setRenameMaterialTarget(null);
        }}
      />
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
  headerTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.textPrimary, flexShrink: 1, marginHorizontal: spacing.sm },
  headerSpacer: { width: 44, height: 44 },
  menuButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  selectButton: {
    minHeight: 40,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectButtonLabel: { fontSize: fontSize.sm, color: colors.deepNavy, fontWeight: '700' },
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxxl },
  content: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: spacing.xl },
  heroHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  courseTile: {
    width: 68,
    height: 68,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: { flex: 1, justifyContent: 'center', gap: spacing.sm },
  courseName: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.textPrimary },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  metaText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600' },
  metaDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.textTertiary },
  startButton: { minWidth: 210, marginTop: spacing.lg },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sectionTitle: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  sectionMeta: { fontSize: fontSize.sm, color: colors.textTertiary, fontWeight: '600' },
  lectureList: {
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  lectureRow: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  lectureDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  lecturePressed: { backgroundColor: colors.surfaceMuted },
  lectureRowSelected: { backgroundColor: colors.surfaceMuted },
  selectCircle: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectCircleOn: {
    backgroundColor: colors.deepNavy,
    borderColor: colors.deepNavy,
  },
  selectionBar: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  deleteSelectedButton: {
    width: '100%',
    backgroundColor: colors.recordingRed,
    shadowColor: colors.recordingRed,
  },
  lectureIcon: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lectureBody: { flex: 1, gap: 4 },
  lectureTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.textPrimary },
  lectureMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  lectureMeta: { fontSize: fontSize.sm, color: colors.textTertiary, fontWeight: '500' },

  // ---- Materials (Build 7 V1.1) ----
  materialsCard: { gap: spacing.md },
  materialsBanner: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.iceTint,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.iceBlue,
    overflow: 'hidden',
  },
  materialsEmpty: { alignItems: 'center', paddingVertical: spacing.lg, gap: spacing.sm },
  materialsEmptyIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.xl,
    backgroundColor: colors.iceTint,
    borderWidth: 1,
    borderColor: colors.iceBlue,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  materialsEmptyTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  materialsEmptyBody: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    fontWeight: '500',
    lineHeight: fontSize.sm * 1.5,
    paddingHorizontal: spacing.md,
  },
  materialList: { borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  materialRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.surface,
  },
  materialDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  materialIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  materialBody: { flex: 1, minWidth: 0, gap: 2 },
  materialMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: spacing.sm,
    rowGap: 2,
  },
  materialTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary },
  materialsImportButton: { alignSelf: 'flex-start' },
  materialsImportingHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  materialsImportingLabel: { fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: '600' },
  emptyCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: radius.xl,
    backgroundColor: colors.iceTint,
    borderWidth: 1,
    borderColor: colors.iceBlue,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
  emptyBody: {
    marginTop: spacing.sm,
    maxWidth: 360,
    textAlign: 'center',
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.5,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  emptyButton: { marginTop: spacing.xl, minWidth: 220 },
  notFound: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xl },
  notFoundTitle: { fontSize: fontSize.lg, color: colors.textSecondary, fontWeight: '600' },
  softButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  softButtonLabel: { fontSize: fontSize.md, color: colors.deepNavy, fontWeight: '700' },
  rowMenuButton: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.86, transform: [{ scale: 0.97 }] },
});
