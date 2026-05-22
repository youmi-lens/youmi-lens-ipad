/**
 * Material reader (Build 7 V1.1).
 *
 * Read-only PDF viewer backed by react-native-pdf (PDFKit on iOS). Shows the
 * Live Captions strip whenever a live caption session is already active —
 * we never start a new engine here. Persists last-opened page back into the
 * store on page change.
 *
 * react-native-pdf is loaded via guarded require() so a dev binary that
 * doesn't yet have the pod linked surfaces a friendly fallback screen
 * instead of red-screening.
 */
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FloatingMiniCaption } from '@/components/FloatingMiniCaption';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { resolveMaterialUri } from '@/lib/importMaterial';
import { useData } from '@/lib/store';

/** How long the floating page indicator stays visible after the last page change. */
const PAGE_NAV_HIDE_DELAY_MS = 1800;

export default function LectureMaterialWorkspaceScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ lectureId?: string; materialId?: string }>();
  const {
    getMaterial,
    updateMaterial,
    linkMaterialToLecture,
    updateLectureMaterialLink,
    materialLinksForLecture,
  } = useData();

  const lectureId = params.lectureId ?? '';
  const material = getMaterial(params.materialId);
  const materialLink = materialLinksForLecture(lectureId).find((link) => link.materialId === material?.id);
  const initialLinkedPage = materialLink?.lastOpenedPage ?? material?.lastOpenedPage ?? 1;

  useEffect(() => {
    if (lectureId && material?.id) {
      linkMaterialToLecture(lectureId, material.id);
    }
  }, [lectureId, linkMaterialToLecture, material?.id]);

  // Guarded require — same pattern as exportLectureNotesPdf so a missing
  // native module is a friendly alert, not a red screen.
  const Pdf = useMemo(() => {
    try {
      // react-native-pdf default-exports the viewer component.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('react-native-pdf');
      return (mod?.default ?? mod) as React.ComponentType<any> | null;
    } catch (err) {
      if (__DEV__) console.warn('[material] react-native-pdf not available in this build', err);
      return null;
    }
  }, []);

  const [currentPage, setCurrentPage] = useState<number>(initialLinkedPage);
  const [totalPages, setTotalPages] = useState<number>(material?.pageCount ?? 0);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Capture the page we want the PDF to open at ONCE on mount. Passing
  // `material.lastOpenedPage` as the live `page` prop would cause the
  // viewer to jump every time we persist a new page, which itself fires
  // onPageChanged again and loops.
  const [initialPage] = useState<number>(() => Math.max(1, initialLinkedPage));

  // Track persistence state via refs so no effect depends on `material`'s
  // React identity. material's identity changes after every updateMaterial,
  // and an effect that depends on it would run its cleanup again — that's
  // what produced the "Maximum update depth exceeded" loop on first PDF load.
  const materialIdRef = useRef<string | undefined>(material?.id);
  const lectureIdRef = useRef<string | undefined>(lectureId || undefined);
  const savedPageCountRef = useRef<number | undefined>(material?.pageCount);
  const savedLastPageRef = useRef<number | undefined>(materialLink?.lastOpenedPage ?? material?.lastOpenedPage);
  const pendingPageRef = useRef<number | undefined>(materialLink?.lastOpenedPage ?? material?.lastOpenedPage);
  const pageDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Floating page indicator: purely local UI state. Auto-shows when the page
  // changes (or the PDF first loads), auto-hides after PAGE_NAV_HIDE_DELAY_MS
  // of idle. Visibility is never persisted to the store.
  const [navigatorVisible, setNavigatorVisible] = useState(false);
  const navigatorHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNavigatorBriefly = useCallback(() => {
    setNavigatorVisible(true);
    if (navigatorHideTimerRef.current) clearTimeout(navigatorHideTimerRef.current);
    navigatorHideTimerRef.current = setTimeout(() => {
      setNavigatorVisible(false);
      navigatorHideTimerRef.current = null;
    }, PAGE_NAV_HIDE_DELAY_MS);
  }, []);
  const keepNavigatorVisible = useCallback(() => {
    setNavigatorVisible(true);
    if (navigatorHideTimerRef.current) {
      clearTimeout(navigatorHideTimerRef.current);
      navigatorHideTimerRef.current = null;
    }
  }, []);

  // Imperative jump via react-native-pdf's setPage(n). Using the ref keeps
  // the `page` prop locked at `initialPage` — that's what prevents the
  // page-prop-drift loop class we fixed previously. Jumps fire onPageChanged
  // exactly once per jump, which our existing handler safely picks up.
  const pdfRef = useRef<{ setPage: (n: number) => void } | null>(null);

  // Go-to-page modal state. All local; never written to the store.
  const [jumpModalVisible, setJumpModalVisible] = useState(false);

  const openJumpModal = useCallback(() => {
    // Keep the navigator visible while the modal is up (no fade-out).
    keepNavigatorVisible();
    setJumpModalVisible(true);
  }, [keepNavigatorVisible]);

  const closeJumpModal = useCallback(() => {
    setJumpModalVisible(false);
    // Re-arm the auto-hide so the navigator lingers briefly after dismiss.
    showNavigatorBriefly();
  }, [showNavigatorBriefly]);

  const handleJumpGo = useCallback(
    (page: number) => {
      // Imperative call — does NOT change the page prop.
      pdfRef.current?.setPage(page);
      // Mirror locally so the navigator updates instantly without waiting
      // for the onPageChanged round-trip from native.
      setCurrentPage(page);
      pendingPageRef.current = page;
      setJumpModalVisible(false);
      showNavigatorBriefly();
    },
    [showNavigatorBriefly],
  );

  // Sync refs only when the material *id* changes (i.e. navigating between
  // materials inside the same mounted route — defensive; the route normally
  // remounts on id change). Non-id field updates do NOT retrigger this.
  useEffect(() => {
    if (!material) return;
    lectureIdRef.current = lectureId || undefined;
    materialIdRef.current = material.id;
    savedPageCountRef.current = material.pageCount;
    savedLastPageRef.current = materialLink?.lastOpenedPage ?? material.lastOpenedPage;
    pendingPageRef.current = materialLink?.lastOpenedPage ?? material.lastOpenedPage;
  }, [lectureId, material?.id]);

  // On unmount, flush any pending page write that the debounce didn't run,
  // and clear the page-indicator hide timer. updateMaterial is created with
  // useCallback([]) in the store, so its reference is stable — this effect
  // mounts/unmounts exactly once.
  useEffect(() => {
    return () => {
      if (pageDebounceRef.current) {
        clearTimeout(pageDebounceRef.current);
        pageDebounceRef.current = null;
      }
      if (navigatorHideTimerRef.current) {
        clearTimeout(navigatorHideTimerRef.current);
        navigatorHideTimerRef.current = null;
      }
      const lectureId = lectureIdRef.current;
      const id = materialIdRef.current;
      const pending = pendingPageRef.current;
      const saved = savedLastPageRef.current;
      if (lectureId && id && typeof pending === 'number' && pending !== saved) {
        savedLastPageRef.current = pending;
        updateLectureMaterialLink(lectureId, id, { lastOpenedPage: pending });
      }
    };
  }, [updateLectureMaterialLink]);

  const fileUri = material ? resolveMaterialUri(material.localPath) : '';
  // Memoize the source prop so react-native-pdf doesn't treat each render
  // as a new document and re-fire onLoadComplete.
  const pdfSource = useMemo(
    () => (fileUri ? { uri: fileUri, cache: false } : null),
    [fileUri],
  );

  const handlePdfLoadComplete = useCallback(
    (numberOfPages: number) => {
      setLoadingPdf(false);
      setPdfError(null);
      setTotalPages(numberOfPages);
      // Surface the page indicator briefly so the user sees "1 / 842" on
      // first open, then it auto-hides.
      showNavigatorBriefly();
      const id = materialIdRef.current;
      // Only persist if the stored pageCount actually differs. Combined with
      // updateMaterial being idempotent, two layers of guard against loops.
      if (id && savedPageCountRef.current !== numberOfPages) {
        savedPageCountRef.current = numberOfPages;
        updateMaterial(id, { pageCount: numberOfPages });
      }
    },
    [showNavigatorBriefly, updateMaterial],
  );

  const handlePdfPageChanged = useCallback(
    (page: number) => {
      setCurrentPage(page);
      // Show indicator + reset auto-hide timer on every page change.
      showNavigatorBriefly();
      pendingPageRef.current = page;
      if (pageDebounceRef.current) clearTimeout(pageDebounceRef.current);
      pageDebounceRef.current = setTimeout(() => {
        pageDebounceRef.current = null;
        const lectureId = lectureIdRef.current;
        const id = materialIdRef.current;
        const pending = pendingPageRef.current;
        if (lectureId && id && typeof pending === 'number' && pending !== savedLastPageRef.current) {
          savedLastPageRef.current = pending;
          updateLectureMaterialLink(lectureId, id, { lastOpenedPage: pending });
        }
      }, 500);
    },
    [showNavigatorBriefly, updateLectureMaterialLink],
  );

  const handlePdfError = useCallback((err: unknown) => {
    setLoadingPdf(false);
    const message = err instanceof Error ? err.message : 'The PDF could not be loaded.';
    if (__DEV__) console.warn('[material] PDF load error', err);
    setPdfError(message);
  }, []);

  // ---- Empty / error states ----
  if (!material) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
        <Header title="Material" onBack={() => router.back()} />
        <View style={styles.emptyState}>
          <Ionicons name="document-outline" size={36} color={colors.mutedBlueGray} />
          <Text style={styles.emptyTitle}>This lecture material could not be found.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
            style={({ pressed }) => [styles.softButton, pressed && styles.pressed]}
          >
            <Text style={styles.softButtonLabel}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!Pdf || !pdfSource) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
        <Header title={material.title} onBack={() => router.back()} />
        <View style={styles.emptyState}>
          <Ionicons name="construct-outline" size={36} color={colors.mutedBlueGray} />
          <Text style={styles.emptyTitle}>PDF viewer is not available in this build yet.</Text>
          <Text style={styles.emptyBody}>
            Please rebuild the app from Xcode after running pod install.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
      <Header
        title={material.title}
        subtitle={totalPages > 0 ? `Lecture material · Page ${currentPage} of ${totalPages}` : 'Lecture material'}
        onBack={() => router.back()}
      />

      <View style={styles.pdfWrap}>
        {loadingPdf && !pdfError ? (
          <View style={styles.pdfLoading}>
            <ActivityIndicator color={colors.deepNavy} />
            <Text style={styles.pdfLoadingLabel}>Opening PDF…</Text>
          </View>
        ) : null}

        {pdfError ? (
          <View style={styles.pdfErrorBlock}>
            <Ionicons name="alert-circle-outline" size={28} color={colors.recordingRed} />
            <Text style={styles.emptyTitle}>Could not open this PDF.</Text>
            <Text style={styles.emptyBody}>{pdfError}</Text>
          </View>
        ) : null}

        <Pdf
          ref={pdfRef as React.Ref<any>}
          source={pdfSource}
          page={initialPage}
          trustAllCerts={false}
          onLoadComplete={handlePdfLoadComplete}
          onPageChanged={handlePdfPageChanged}
          onError={handlePdfError}
          enablePaging={false}
          spacing={8}
          horizontal={false}
          style={styles.pdf}
        />

        {/* Floating page indicator — Notability-style. Tapping the current
            page opens the Go-to-page modal. */}
        <FloatingPageNavigator
          currentPage={currentPage}
          totalPages={totalPages}
          visible={navigatorVisible}
          onTapCurrent={openJumpModal}
        />
      </View>

      <FloatingMiniCaption topOffset={104} />

      <GoToPageModal
        visible={jumpModalVisible}
        currentPage={currentPage}
        totalPages={totalPages}
        onCancel={closeJumpModal}
        onGo={handleJumpGo}
      />
    </SafeAreaView>
  );
}

/**
 * Notability-style floating page indicator. Visibility is controlled by the
 * parent (auto-hide timer); we just animate opacity.
 *
 * Non-interactive in V1 (pointerEvents="none"). Tap-to-jump intentionally
 * deferred: setting react-native-pdf's `page` prop after mount would
 * reintroduce the page-prop drift that caused the previous update-depth
 * loop. Future revision can add jump controls via a controlled `page`
 * state that is only set on explicit user action, never from store updates.
 */
function FloatingPageNavigator({
  currentPage,
  totalPages,
  visible,
  onTapCurrent,
}: {
  currentPage: number;
  totalPages: number;
  visible: boolean;
  onTapCurrent: () => void;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: visible ? 140 : 260,
      useNativeDriver: true,
    }).start();
  }, [visible, opacity]);

  // Hide entirely when we don't have valid page metadata to show.
  if (!Number.isFinite(currentPage) || currentPage <= 0) return null;

  const showTotal = Number.isFinite(totalPages) && totalPages > 0;

  return (
    // `box-none` lets the Pressable child capture taps for the jump dialog
    // while non-interactive parts (divider + total page text) pass touches
    // through to the PDF underneath. The pill itself never swallows gestures.
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.pageNav,
        { opacity },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          showTotal
            ? `Page ${currentPage} of ${totalPages}. Tap to go to page.`
            : `Page ${currentPage}. Tap to go to page.`
        }
        onPress={onTapCurrent}
        hitSlop={8}
        style={({ pressed }) => [styles.pageNavCurrentWrap, pressed && styles.pageNavCurrentPressed]}
      >
        <Text style={styles.pageNavCurrent}>{currentPage}</Text>
      </Pressable>
      {showTotal ? (
        <>
          <View style={styles.pageNavDivider} />
          <Text style={styles.pageNavTotal}>{totalPages}</Text>
        </>
      ) : null}
    </Animated.View>
  );
}

/**
 * Go-to-page modal — Youmi-Lens-styled with a numeric keyboard, inline
 * validation, and Cancel/Go buttons. Mirrors the RenameModal visual pattern.
 *
 * The modal owns its own input + error state. Submission calls onGo(page)
 * with a validated 1-based page number; the parent does the imperative
 * pdfRef.setPage(...) call. Closing the modal (cancel or successful Go) is
 * always driven by the parent via setJumpModalVisible — we never close from
 * inside this component without surfacing the action.
 */
function GoToPageModal({
  visible,
  currentPage,
  totalPages,
  onCancel,
  onGo,
}: {
  visible: boolean;
  currentPage: number;
  totalPages: number;
  onCancel: () => void;
  onGo: (page: number) => void;
}) {
  const initial = Number.isFinite(currentPage) && currentPage > 0 ? String(currentPage) : '';
  const [value, setValue] = useState<string>(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  // Reset every time the modal opens so the field starts with the current page.
  useEffect(() => {
    if (visible) {
      setValue(initial);
      setError(null);
    }
    // We intentionally do not depend on `initial` to avoid resetting the
    // field while the user is typing — `initial` is recomputed every render
    // from currentPage, which updates as the user scrolls behind the modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleChange = (next: string) => {
    // Strip everything that isn't a digit. number-pad already restricts on
    // iOS, but external keyboards and paste can bypass it.
    setValue(next.replace(/[^0-9]/g, ''));
    if (error) setError(null);
  };

  const validate = (): { ok: true; page: number } | { ok: false; reason: string } => {
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, reason: 'Please enter a page number.' };
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
      return { ok: false, reason: 'Please enter a whole number.' };
    }
    if (parsed < 1) return { ok: false, reason: 'Pages start at 1.' };
    if (totalPages > 0 && parsed > totalPages) {
      return {
        ok: false,
        reason: `This PDF has only ${totalPages} ${totalPages === 1 ? 'page' : 'pages'}.`,
      };
    }
    return { ok: true, page: parsed };
  };

  const handleGo = () => {
    const result = validate();
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    onGo(result.page);
  };

  const helper = totalPages > 0 ? `1–${totalPages}` : 'Enter a page number';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={modalStyles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={modalStyles.backdrop} onPress={onCancel} />
        <View style={modalStyles.card}>
          <Text style={modalStyles.title}>Go to page</Text>
          <Text style={modalStyles.helper}>{helper}</Text>
          <TextInput
            ref={inputRef}
            style={modalStyles.input}
            value={value}
            onChangeText={handleChange}
            keyboardType="number-pad"
            placeholder="Page number"
            placeholderTextColor={colors.textTertiary}
            autoFocus
            selectTextOnFocus
            returnKeyType="go"
            onSubmitEditing={handleGo}
            maxLength={6}
            accessibilityLabel="Page number"
          />
          {error ? <Text style={modalStyles.error}>{error}</Text> : null}
          <View style={modalStyles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [modalStyles.cancelBtn, pressed && modalStyles.pressed]}
            >
              <Text style={modalStyles.cancelLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={handleGo}
              style={({ pressed }) => [modalStyles.goBtn, pressed && modalStyles.pressed]}
            >
              <Text style={modalStyles.goLabel}>Go</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Header({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={onBack}
        hitSlop={10}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <Ionicons name="chevron-back" size={24} color={colors.deepNavy} />
      </Pressable>
      <View style={styles.headerTextWrap}>
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.headerSpacer} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
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
  headerTextWrap: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.textPrimary },
  headerSubtitle: { marginTop: 2, fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: '600' },
  headerSpacer: { width: 44, height: 44 },

  pdfWrap: {
    flex: 1,
    backgroundColor: colors.surfaceMuted,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  pdf: { flex: 1, backgroundColor: colors.surfaceMuted },
  pdfLoading: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    zIndex: 1,
  },
  pdfLoadingLabel: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600' },
  pdfErrorBlock: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
    zIndex: 2,
  },
  // ---- Floating page navigator (Notability-style) ----
  pageNav: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minWidth: 64,
    backgroundColor: 'rgba(10, 23, 40, 0.86)',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.10)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  pageNavCurrentWrap: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  pageNavCurrentPressed: { backgroundColor: 'rgba(255,255,255,0.12)' },
  pageNavCurrent: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.2,
    lineHeight: fontSize.lg * 1.1,
    textAlign: 'center',
  },
  pageNavDivider: {
    width: 18,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.34)',
    marginVertical: 4,
  },
  pageNavTotal: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.7)',
    letterSpacing: 0.2,
    lineHeight: fontSize.sm * 1.1,
  },

  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  emptyBody: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '500', textAlign: 'center' },
  softButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  softButtonLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.deepNavy },

  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
});

// ---- Go-to-page modal styles (kept in a separate sheet so they don't get
//      tangled with the reader screen's positional styles above). ----
const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(6, 27, 52, 0.32)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  backdrop: { ...StyleSheet.absoluteFillObject },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
    gap: spacing.sm,
    shadowColor: '#0A2342',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.18,
    shadowRadius: 30,
    elevation: 12,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },
  helper: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  input: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  error: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.recordingRed,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  cancelBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cancelLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },
  goBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.deepNavy,
  },
  goLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.pearlWhite, letterSpacing: 0.2 },
  pressed: { opacity: 0.88, transform: [{ scale: 0.97 }] },
});
