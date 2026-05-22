import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ComponentProps, useState } from 'react';
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
import type { CourseMaterial, Lecture } from '@/lib/models';
import { useData } from '@/lib/store';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type LectureStatusDisplay = {
  label: string;
  variant: StatusVariant;
};

function lectureStatus(lecture: Lecture): LectureStatusDisplay {
  if (lecture.processingStatus === 'ready' || (lecture.transcript && (lecture.summaryEn || lecture.summaryZh))) {
    return { label: 'READY', variant: 'done' };
  }
  if (lecture.processingStatus === 'processing') return { label: 'PROCESSING', variant: 'processing' };
  if (lecture.processingStatus === 'failed') return { label: 'FAILED', variant: 'idle' };
  if (lecture.uploadStatus === 'uploaded') return { label: 'UPLOADED', variant: 'synced' };
  if (lecture.uploadStatus === 'uploading') return { label: 'UPLOADING', variant: 'processing' };
  if (lecture.uploadStatus === 'upload_failed') return { label: 'UPLOAD FAILED', variant: 'idle' };
  return { label: 'RECORDED', variant: 'idle' };
}

export default function CourseDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const {
    getCourse,
    lecturesForCourse,
    setSelectedCourseId,
    deleteLecture,
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
    Alert.alert('Could not import material', result.reason);
  };

  const confirmDeleteMaterial = (materialId: string) => {
    Alert.alert(
      'Delete material',
      'This material will move to Recently Deleted. The file stays on this iPad.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => setOpenMaterialId(null) },
        {
          text: 'Delete',
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
          <Text style={styles.notFoundTitle}>This course could not be found.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/courses')}
            style={({ pressed }) => [styles.softButton, pressed && styles.pressed]}
          >
            <Text style={styles.softButtonLabel}>Back to Courses</Text>
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
    router.push({ pathname: '/lecture/[id]', params: { id: lectureId } });
  };

  const confirmDeleteLecture = (lectureId: string) => {
    Alert.alert(
      'Delete lecture',
      'This lecture will move to Recently Deleted. You can restore it anytime.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => setOpenLectureId(null) },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteLecture(lectureId);
            setOpenLectureId(null);
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
          accessibilityLabel="Back"
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={24} color={colors.deepNavy} />
        </Pressable>
        <Text style={styles.headerTitle}>Course Detail</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Rename course"
          onPress={() => setCourseRenameVisible(true)}
          hitSlop={10}
          style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}
        >
          <Ionicons name="pencil-outline" size={20} color={colors.deepNavy} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => setOpenLectureId(null)}
      >
        <View style={styles.content}>
          <GlassCard style={styles.heroCard}>
            <View style={[styles.courseTile, { backgroundColor: course.tint }]}> 
              <Ionicons name={course.icon as IoniconName} size={28} color={course.accent} />
            </View>
            <View style={styles.heroText}>
              <Text style={styles.courseName}>{course.name}</Text>
              <View style={styles.metaRow}>
                <Text style={styles.metaText}>
                  {lectures.length} {lectures.length === 1 ? 'lecture' : 'lectures'}
                </Text>
                <View style={styles.metaDot} />
                <Text style={styles.metaText}>
                  {latestLecture ? `Last recorded ${formatShortDate(latestLecture.date)}` : 'No recordings yet'}
                </Text>
              </View>
            </View>
            <PrimaryButton label="Start new lecture" icon="mic" onPress={startLecture} style={styles.startButton} />
          </GlassCard>

          {/* ───── Course Materials (Build 7 V1.1, local-only) ───── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Materials</Text>
            <Text style={styles.sectionMeta}>
              {materials.length} {materials.length === 1 ? 'item' : 'items'}
            </Text>
          </View>

          <GlassCard style={styles.materialsCard}>
            <Text style={styles.materialsBanner}>
              Materials are saved on this iPad only. Cloud backup for materials will come later.
            </Text>
            {materials.length === 0 ? (
              <View style={styles.materialsEmpty}>
                <View style={styles.materialsEmptyIcon}>
                  <Ionicons name="document-attach-outline" size={26} color={colors.deepNavy} />
                </View>
                <Text style={styles.materialsEmptyTitle}>No materials imported yet.</Text>
                <Text style={styles.materialsEmptyBody}>
                  Import a PDF textbook, slide deck, or reading you want available across this course.
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
                        <Text style={styles.materialTitle} numberOfLines={1}>{material.title}</Text>
                        <View style={styles.lectureMetaRow}>
                          <Text style={styles.lectureMeta}>PDF</Text>
                          {material.pageCount ? (
                            <>
                              <View style={styles.metaDot} />
                              <Text style={styles.lectureMeta}>
                                {material.pageCount} {material.pageCount === 1 ? 'page' : 'pages'}
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
                              <Text style={styles.lectureMeta}>Last opened page {material.lastOpenedPage}</Text>
                            </>
                          ) : null}
                          {annotationCount > 0 ? (
                            <>
                              <View style={styles.metaDot} />
                              <Text style={styles.lectureMeta}>
                                {annotationCount} {annotationCount === 1 ? 'annotation' : 'annotations'}
                              </Text>
                            </>
                          ) : null}
                        </View>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Rename material"
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
              label={importing ? 'Importing…' : 'Import PDF'}
              icon="cloud-upload-outline"
              onPress={() => { void handleImportMaterial(); }}
              disabled={importing}
              style={styles.materialsImportButton}
            />
            {importing ? (
              <View style={styles.materialsImportingHint}>
                <ActivityIndicator color={colors.deepNavy} />
                <Text style={styles.materialsImportingLabel}>
                  Reading from Files…
                </Text>
              </View>
            ) : null}
          </GlassCard>

          {/* ───── Lectures ───── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Lectures</Text>
            {latestLecture ? (
              <Text style={styles.sectionMeta}>Latest {formatDate(latestLecture.date)}</Text>
            ) : null}
          </View>

          {lectures.length === 0 ? (
            <GlassCard style={styles.emptyCard}>
              <View style={styles.emptyIcon}>
                <Ionicons name="mic-outline" size={28} color={colors.deepNavy} />
              </View>
              <Text style={styles.emptyTitle}>No lectures recorded yet.</Text>
              <Text style={styles.emptyBody}>
                Record your first lecture to start building this course library.
              </Text>
              <PrimaryButton label="Start first lecture" icon="mic" onPress={startLecture} style={styles.emptyButton} />
            </GlassCard>
          ) : (
            <View style={styles.lectureList}>
              {lectures.map((lecture, index) => {
                const status = lectureStatus(lecture);
                return (
                  <SwipeDeleteRow
                    key={lecture.id}
                    open={openLectureId === lecture.id}
                    onOpen={() => setOpenLectureId(lecture.id)}
                    onClose={() => setOpenLectureId(null)}
                    onDelete={() => confirmDeleteLecture(lecture.id)}
                    style={index < lectures.length - 1 ? styles.lectureDivider : undefined}
                  >
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => openLecture(lecture.id)}
                      style={({ pressed }) => [styles.lectureRow, pressed && styles.lecturePressed]}
                    >
                      <View style={[styles.lectureIcon, { backgroundColor: course.tint }]}>
                        <Ionicons name="document-text-outline" size={20} color={course.accent} />
                      </View>
                      <View style={styles.lectureBody}>
                        <Text style={styles.lectureTitle} numberOfLines={1}>{lecture.title}</Text>
                        <View style={styles.lectureMetaRow}>
                          <Text style={styles.lectureMeta}>{formatDate(lecture.date)}</Text>
                          <View style={styles.metaDot} />
                          <Text style={styles.lectureMeta}>{formatDuration(lecture.durationMillis)}</Text>
                        </View>
                      </View>
                      <StatusPill label={status.label} variant={status.variant} />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Rename lecture"
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
                    </Pressable>
                  </SwipeDeleteRow>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
      {/* Rename course modal */}
      <RenameModal
        visible={courseRenameVisible}
        title="Rename Course"
        label="Course name"
        initialValue={course.name}
        placeholder="e.g. Introduction to Biology"
        onCancel={() => setCourseRenameVisible(false)}
        onSave={(name) => {
          renameCourse(course.id, name);
          setCourseRenameVisible(false);
        }}
      />

      {/* Rename lecture modal (per-row) */}
      <RenameModal
        visible={renameLectureTarget !== null}
        title="Rename Lecture"
        label="Lecture title"
        initialValue={renameLectureTarget?.title ?? ''}
        placeholder="e.g. Week 3 — Cell Division"
        onCancel={() => setRenameLectureTarget(null)}
        onSave={(title) => {
          if (renameLectureTarget) renameLecture(renameLectureTarget.id, title);
          setRenameLectureTarget(null);
        }}
      />

      {/* Rename material modal (per-row) */}
      <RenameModal
        visible={renameMaterialTarget !== null}
        title="Rename Material"
        label="Material name"
        initialValue={renameMaterialTarget?.title ?? ''}
        placeholder="e.g. Psychology Textbook"
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
  headerTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.textPrimary },
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
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxxl },
  content: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: spacing.xl },
  heroCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  courseTile: {
    width: 68,
    height: 68,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: { flex: 1, gap: spacing.sm },
  courseName: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.textPrimary },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  metaText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600' },
  metaDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.textTertiary },
  startButton: { minWidth: 210 },
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
  materialBody: { flex: 1, gap: 2 },
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
