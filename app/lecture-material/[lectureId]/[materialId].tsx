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
import { ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FloatingMiniCaption } from '@/components/FloatingMiniCaption';
import { useLiveCaptions } from '@/lib/liveCaptions';
import {
  MaterialAnnotationMode,
  MaterialAnnotationOverlay,
  type MaterialDrawingMode,
} from '@/components/MaterialAnnotationOverlay';
import { NativePdfAnnotationView } from '@/components/NativePdfAnnotationView';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { resolveMaterialUri } from '@/lib/importMaterial';
import type { MaterialAnnotationStroke } from '@/lib/models';
import type {
  NativePdfAnnotationMode,
  NativePdfAnnotationsByPage,
  NativePdfAnnotationsChangedEvent,
  NativePdfAnnotationStroke,
} from '@/modules/expo-pdf-annotation';
import {
  addPencilDoubleTapListener,
  isPencilDoubleTapAvailable,
} from '@/lib/pencilInteraction';
import { useData } from '@/lib/store';

/** How long the floating page indicator stays visible after the last page change. */
const PAGE_NAV_HIDE_DELAY_MS = 1800;
/** Phase 1 native PDFKit viewer spike. Old react-native-pdf path remains below as fallback. */
const USE_NATIVE_PDF_VIEWER = true;
const PEN_COLORS = [
  { key: 'Navy', value: '#061B34' },
  { key: 'Blue', value: '#2D6CDF' },
  { key: 'Red', value: '#D7263D' },
  { key: 'Purple', value: '#6C4FB3' },
  { key: 'Black', value: '#1A1A1A' },
];
const HIGHLIGHTER_COLORS = [
  { key: 'Yellow', value: '#FFE066' },
  { key: 'Blue', value: '#78D6FF' },
  { key: 'Pink', value: '#FF9CCB' },
  { key: 'Green', value: '#9BE7A6' },
];
const PEN_WIDTHS = [
  { key: 'Thin', value: 2.4 },
  { key: 'Medium', value: 4 },
  { key: 'Thick', value: 6.5 },
];
const HIGHLIGHTER_WIDTHS = [
  { key: 'Narrow', value: 12 },
  { key: 'Medium', value: 18 },
  { key: 'Wide', value: 26 },
];
const ERASER_SIZES = [
  { key: 'Small', value: 16 },
  { key: 'Medium', value: 26 },
  { key: 'Large', value: 40 },
];
const MATERIAL_REVIEW_LECTURE_ID = '__material_review__';

function materialScopeLectureId(materialId: string): string {
  return `material:${materialId}`;
}

export default function LectureMaterialWorkspaceScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ lectureId?: string; materialId?: string }>();
  const {
    getMaterial,
    updateMaterial,
    linkMaterialToLecture,
    updateLectureMaterialLink,
    materialLinksForLecture,
    annotationsForPage,
    annotationsForMaterialPage,
    addAnnotationStroke,
    saveAnnotationStrokes,
    replaceMaterialPageAnnotationStrokes,
    replaceMaterialPageAnnotationStrokesForMaterial,
    undoLastAnnotationStroke,
  } = useData();

  const lectureId = params.lectureId ?? '';
  const material = getMaterial(params.materialId);
  const materialReviewMode = lectureId === MATERIAL_REVIEW_LECTURE_ID;
  const materialLink = !materialReviewMode
    ? materialLinksForLecture(lectureId).find((link) => link.materialId === material?.id)
    : undefined;
  const initialLinkedPage = materialReviewMode
    ? (material?.lastOpenedPage ?? 1)
    : (materialLink?.lastOpenedPage ?? material?.lastOpenedPage ?? 1);
  const useNativePdfViewer = USE_NATIVE_PDF_VIEWER && Platform.OS === 'ios';

  // --- Native PDFKit annotation state (Phase 2) ---
  // Native overlay-only state; the legacy JS-overlay branch below does NOT use these.
  const [nativeAnnotationMode, setNativeAnnotationMode] = useState<NativePdfAnnotationMode>('scroll');
  // Color + width *do* need setters — the previous cut destructured without
  // them, which silently locked every stroke to the initial (deep navy /
  // medium) values. The native view now picks these up on every change.
  const [nativePenColor, setNativePenColor] = useState<string>(PEN_COLORS[0].value);
  const [nativePenWidth, setNativePenWidth] = useState<number>(PEN_WIDTHS[1].value);
  const [nativeHighlighterColor, setNativeHighlighterColor] = useState<string>(HIGHLIGHTER_COLORS[0].value);
  const [nativeHighlighterWidth, setNativeHighlighterWidth] = useState<number>(HIGHLIGHTER_WIDTHS[1].value);
  const [nativeEraserRadius, setNativeEraserRadius] = useState<number>(ERASER_SIZES[1].value);
  const [nativeTemporaryEraser, setNativeTemporaryEraser] = useState(false);
  const nativeAnnotationModeRef = useRef<NativePdfAnnotationMode>(nativeAnnotationMode);
  const nativePreviousDrawingToolRef = useRef<Extract<NativePdfAnnotationMode, 'pen' | 'highlighter'>>('pen');
  const nativeTemporaryEraserRef = useRef(false);
  // Refs so the native onAnnotationsChanged handler always sees the latest
  // lecture/material/page without re-creating the callback (which would
  // churn the native prop and risk update-depth loops).
  const nativeLectureIdRef = useRef<string>(lectureId);
  const nativeMaterialIdRef = useRef<string | undefined>(material?.id);
  const nativeCurrentPageRef = useRef<number>(initialLinkedPage);
  useEffect(() => { nativeLectureIdRef.current = lectureId; }, [lectureId]);
  useEffect(() => { nativeMaterialIdRef.current = material?.id; }, [material?.id]);

  useEffect(() => {
    if (!materialReviewMode && lectureId && material?.id) {
      linkMaterialToLecture(lectureId, material.id);
    }
  }, [lectureId, linkMaterialToLecture, material?.id, materialReviewMode]);

  // Guarded require — same pattern as exportLectureNotesPdf so a missing
  // native module is a friendly alert, not a red screen.
  const Pdf = useMemo(() => {
    if (useNativePdfViewer) return null;
    try {
      // react-native-pdf default-exports the viewer component.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('react-native-pdf');
      return (mod?.default ?? mod) as React.ComponentType<any> | null;
    } catch (err) {
      if (__DEV__) console.warn('[material] react-native-pdf not available in this build', err);
      return null;
    }
  }, [useNativePdfViewer]);

  const [currentPage, setCurrentPage] = useState<number>(initialLinkedPage);
  const [totalPages, setTotalPages] = useState<number>(material?.pageCount ?? 0);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [annotationMode, setAnnotationMode] = useState<MaterialAnnotationMode>('scroll');
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1].value);
  const [highlighterColor, setHighlighterColor] = useState(HIGHLIGHTER_COLORS[0].value);
  const [highlighterWidth, setHighlighterWidth] = useState(HIGHLIGHTER_WIDTHS[1].value);
  const [eraserRadius, setEraserRadius] = useState(ERASER_SIZES[1].value);
  const [annotationStrokeActive, setAnnotationStrokeActive] = useState(false);
  const [previousDrawingTool, setPreviousDrawingTool] = useState<MaterialDrawingMode>('pen');
  const previousDrawModeRef = useRef<MaterialDrawingMode>('pen');
  const doubleTapAvailable = useMemo(() => isPencilDoubleTapAvailable(), []);

  // Capture the page we want the PDF to open at ONCE on mount. Passing
  // `material.lastOpenedPage` as the live `page` prop would cause the
  // viewer to jump every time we persist a new page, which itself fires
  // onPageChanged again and loops.
  const [initialPage] = useState<number>(() => Math.max(1, initialLinkedPage));
  const pageStrokes = materialReviewMode
    ? annotationsForMaterialPage(material?.id ?? '', currentPage)
    : annotationsForPage(lectureId, material?.id ?? '', currentPage);

  useEffect(() => {
    if (annotationMode === 'pen' || annotationMode === 'highlighter') {
      previousDrawModeRef.current = annotationMode;
      setPreviousDrawingTool(annotationMode);
    }
  }, [annotationMode]);

  useEffect(() => { nativeAnnotationModeRef.current = nativeAnnotationMode; }, [nativeAnnotationMode]);
  useEffect(() => { nativeTemporaryEraserRef.current = nativeTemporaryEraser; }, [nativeTemporaryEraser]);

  useEffect(() => {
    if (!doubleTapAvailable) return;
    return addPencilDoubleTapListener(() => {
      if (useNativePdfViewer) {
        const current = nativeAnnotationModeRef.current;
        if (current === 'pen' || current === 'highlighter') {
          nativePreviousDrawingToolRef.current = current;
          nativeAnnotationModeRef.current = 'eraser';
          nativeTemporaryEraserRef.current = true;
          setNativeTemporaryEraser(true);
          setNativeAnnotationMode('eraser');
          return;
        }

        if (current === 'eraser') {
          const restored = nativePreviousDrawingToolRef.current ?? 'pen';
          nativeAnnotationModeRef.current = restored;
          nativeTemporaryEraserRef.current = false;
          setNativeTemporaryEraser(false);
          setNativeAnnotationMode(restored);
        }
        return;
      }

      setAnnotationMode((current) =>
        current === 'eraser' ? previousDrawModeRef.current : 'eraser',
      );
    });
  }, [doubleTapAvailable, useNativePdfViewer]);

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
    savedLastPageRef.current = materialReviewMode
      ? material.lastOpenedPage
      : (materialLink?.lastOpenedPage ?? material.lastOpenedPage);
    pendingPageRef.current = savedLastPageRef.current;
  }, [lectureId, material?.id, materialReviewMode]);

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
      if (id && typeof pending === 'number' && pending !== saved) {
        savedLastPageRef.current = pending;
        if (materialReviewMode) {
          updateMaterial(id, { lastOpenedPage: pending });
        } else if (lectureId) {
          updateLectureMaterialLink(lectureId, id, { lastOpenedPage: pending });
        }
      }
    };
  }, [materialReviewMode, updateLectureMaterialLink, updateMaterial]);

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
      nativeCurrentPageRef.current = page;
      // Show indicator + reset auto-hide timer on every page change.
      showNavigatorBriefly();
      pendingPageRef.current = page;
      if (pageDebounceRef.current) clearTimeout(pageDebounceRef.current);
      pageDebounceRef.current = setTimeout(() => {
        pageDebounceRef.current = null;
        const lectureId = lectureIdRef.current;
        const id = materialIdRef.current;
        const pending = pendingPageRef.current;
        if (id && typeof pending === 'number' && pending !== savedLastPageRef.current) {
          savedLastPageRef.current = pending;
          if (materialReviewMode) {
            updateMaterial(id, { lastOpenedPage: pending });
          } else if (lectureId) {
            updateLectureMaterialLink(lectureId, id, { lastOpenedPage: pending });
          }
        }
      }, 500);
    },
    [materialReviewMode, showNavigatorBriefly, updateLectureMaterialLink, updateMaterial],
  );

  const handlePdfError = useCallback((err: unknown) => {
    setLoadingPdf(false);
    const message = err instanceof Error ? err.message : 'The PDF could not be loaded.';
    if (__DEV__) console.warn('[material] PDF load error', err);
    setPdfError(message);
  }, []);

  // --- Native annotation bridge (Phase 2) ---

  // Collect this lecture's PDF-page-space annotations from the store, keyed
  // by stringified page number for the native prop. Memoized so the prop
  // identity doesn't churn on every render (which would force the native
  // overlay to reload + redraw every commit).
  const nativeAnnotationsByPage = useMemo<NativePdfAnnotationsByPage>(() => {
    const grouped: NativePdfAnnotationsByPage = {};
    if (!useNativePdfViewer || !lectureId || !material?.id) return grouped;
    const totalRaw = totalPages > 0 ? totalPages : (material.pageCount ?? 0);
    if (totalRaw <= 0) return grouped;
    for (let page = 1; page <= totalRaw; page += 1) {
      const strokes = materialReviewMode
        ? annotationsForMaterialPage(material.id, page)
        : annotationsForPage(lectureId, material.id, page);
      if (!strokes || strokes.length === 0) continue;
      const native: NativePdfAnnotationStroke[] = [];
      for (const stroke of strokes) {
        // Only PDF-page coords are safe to render in the native overlay.
        // Pre-Phase-2 strokes (rejected JS spike) have coordSpace !== 'pdfPage'
        // and are ignored here.
        if (stroke.coordSpace !== 'pdfPage') continue;
        if (!stroke.points || stroke.points.length === 0) continue;
        native.push({
          id: stroke.id,
          tool: stroke.tool === 'highlighter' ? 'highlighter' : 'pen',
          color: stroke.color,
          width: stroke.width,
          opacity: stroke.opacity,
          points: stroke.points.map((p) => [p.x, p.y] as [number, number]),
          createdAt: stroke.createdAt,
        });
      }
      if (native.length > 0) grouped[String(page)] = native;
    }
    return grouped;
  }, [annotationsForMaterialPage, annotationsForPage, lectureId, material?.id, material?.pageCount, materialReviewMode, totalPages, useNativePdfViewer]);

  const handleNativeModeChange = useCallback((next: NativePdfAnnotationMode) => {
    nativeAnnotationModeRef.current = next;
    nativeTemporaryEraserRef.current = false;
    setNativeTemporaryEraser(false);

    if (next === 'pen' || next === 'highlighter') {
      nativePreviousDrawingToolRef.current = next;
    }

    setNativeAnnotationMode(next);
  }, []);

  const restoreNativeTemporaryEraserIfNeeded = useCallback(() => {
    if (!nativeTemporaryEraserRef.current) return;
    const restored = nativePreviousDrawingToolRef.current ?? 'pen';
    nativeAnnotationModeRef.current = restored;
    nativeTemporaryEraserRef.current = false;
    setNativeTemporaryEraser(false);
    setNativeAnnotationMode(restored);
  }, []);

  const handleNativeAnnotationCommitted = useCallback(
    (event: NativePdfAnnotationsChangedEvent) => {
      const lid = nativeLectureIdRef.current;
      const mid = nativeMaterialIdRef.current;
      if (!lid || !mid) return;
      const page = Number.isFinite(event.pageNumber) ? event.pageNumber : nativeCurrentPageRef.current;
      if (!Number.isFinite(page) || page <= 0) return;

      const toStoreStroke = (native: NativePdfAnnotationStroke): MaterialAnnotationStroke => ({
        id: native.id,
        tool: native.tool === 'highlighter' ? 'highlighter' : 'pen',
        color: native.color,
        width: native.width,
        opacity: native.opacity,
        points: native.points.map(([x, y]) => ({ x, y })),
        coordSpace: 'pdfPage',
        createdAt: native.createdAt,
      });

      if (event.action === 'replacePage') {
        const nextStrokes = event.strokes.map(toStoreStroke);
        if (materialReviewMode) {
          replaceMaterialPageAnnotationStrokesForMaterial(mid, page, nextStrokes, materialScopeLectureId(mid));
        } else {
          replaceMaterialPageAnnotationStrokes(lid, mid, page, nextStrokes);
        }
        return;
      }

      if (!event.stroke) return;
      const stroke: MaterialAnnotationStroke = {
        ...toStoreStroke(event.stroke),
      };
      addAnnotationStroke(materialReviewMode ? materialScopeLectureId(mid) : lid, mid, page, stroke);
    },
    [addAnnotationStroke, materialReviewMode, replaceMaterialPageAnnotationStrokes, replaceMaterialPageAnnotationStrokesForMaterial, restoreNativeTemporaryEraserIfNeeded],
  );

  const addPageStroke = useCallback(
    (stroke: MaterialAnnotationStroke) => {
      if (!lectureId || !material?.id) return;
      addAnnotationStroke(materialReviewMode ? materialScopeLectureId(material.id) : lectureId, material.id, currentPage, stroke);
    },
    [addAnnotationStroke, currentPage, lectureId, material?.id, materialReviewMode],
  );

  const erasePageStrokeIds = useCallback(
    (ids: string[]) => {
      if (!lectureId || !material?.id || ids.length === 0) return;
      const idSet = new Set(ids);
      const next = pageStrokes.filter((stroke) => !idSet.has(stroke.id));
      if (materialReviewMode) {
        replaceMaterialPageAnnotationStrokesForMaterial(material.id, currentPage, next, materialScopeLectureId(material.id));
      } else {
        saveAnnotationStrokes(lectureId, material.id, currentPage, next);
      }
    },
    [currentPage, lectureId, material?.id, materialReviewMode, pageStrokes, replaceMaterialPageAnnotationStrokesForMaterial, saveAnnotationStrokes],
  );

  const undoCurrentPage = useCallback(() => {
    if (!lectureId || !material?.id) return;
    if (materialReviewMode) {
      const next = pageStrokes.slice(0, -1);
      replaceMaterialPageAnnotationStrokesForMaterial(material.id, currentPage, next, materialScopeLectureId(material.id));
    } else {
      undoLastAnnotationStroke(lectureId, material.id, currentPage);
    }
  }, [currentPage, lectureId, material?.id, materialReviewMode, pageStrokes, replaceMaterialPageAnnotationStrokesForMaterial, undoLastAnnotationStroke]);

  const undoNativeCurrentPage = useCallback(() => {
    const lid = nativeLectureIdRef.current;
    const mid = nativeMaterialIdRef.current;
    const page = nativeCurrentPageRef.current;
    if (!lid || !mid || !Number.isFinite(page) || page <= 0) return;
    const strokes = materialReviewMode ? annotationsForMaterialPage(mid, page) : annotationsForPage(lid, mid, page);
    const removeIndex = strokes.map((stroke, index) => ({ stroke, index }))
      .reverse()
      .find(({ stroke }) => stroke.coordSpace === 'pdfPage')?.index;
    if (removeIndex == null) return;
    const next = strokes.filter((_, index) => index !== removeIndex);
    if (materialReviewMode) {
      replaceMaterialPageAnnotationStrokesForMaterial(mid, page, next, materialScopeLectureId(mid));
    } else {
      replaceMaterialPageAnnotationStrokes(lid, mid, page, next);
    }
  }, [annotationsForMaterialPage, annotationsForPage, materialReviewMode, replaceMaterialPageAnnotationStrokes, replaceMaterialPageAnnotationStrokesForMaterial]);

  // ---- Empty / error states ----
  if (!material) {
    return (
      <View style={styles.root}>
        <FloatingBackButton
          onPress={() => router.back()}
          style={{ top: insets.top + spacing.md, left: spacing.md }}
        />
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
      </View>
    );
  }

  if ((!useNativePdfViewer && !Pdf) || !pdfSource) {
    return (
      <View style={styles.root}>
        <FloatingBackButton
          onPress={() => router.back()}
          style={{ top: insets.top + spacing.md, left: spacing.md }}
        />
        <View style={styles.emptyState}>
          <Ionicons name="construct-outline" size={36} color={colors.mutedBlueGray} />
          <Text style={styles.emptyTitle}>PDF viewer is not available in this build yet.</Text>
          <Text style={styles.emptyBody}>
            Please rebuild the app from Xcode after running pod install.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* PDF fills the entire screen — no card, no margins. The PDF page
          itself stays white; the surrounding canvas is the same light
          #F6F9FC as the JS root so the two blend seamlessly. */}
      {useNativePdfViewer ? (
        <NativePdfAnnotationView
          ref={pdfRef}
          fileUri={fileUri}
          initialPage={initialPage}
          style={styles.pdfFill}
          annotationMode={nativeAnnotationMode}
          penColor={nativePenColor}
          penWidth={nativePenWidth}
          highlighterColor={nativeHighlighterColor}
          highlighterWidth={nativeHighlighterWidth}
          eraserRadius={nativeEraserRadius}
          annotationsByPage={nativeAnnotationsByPage}
          onLoadComplete={(event) => handlePdfLoadComplete(event.totalPages)}
          onPageChanged={(event) => handlePdfPageChanged(event.pageNumber)}
          onError={(event) => handlePdfError(new Error(event.message))}
          onAnnotationsChanged={handleNativeAnnotationCommitted}
          onEraserGestureEnded={restoreNativeTemporaryEraserIfNeeded}
        />
      ) : Pdf ? (
        <View style={styles.legacyPdfWrap}>
          <MaterialAnnotationOverlay
            mode={annotationMode}
            previousDrawingTool={previousDrawingTool}
            strokes={pageStrokes}
            color={penColor}
            width={penWidth}
            highlighterColor={highlighterColor}
            highlighterWidth={highlighterWidth}
            eraserRadius={eraserRadius}
            onAddStroke={addPageStroke}
            onEraseStrokeIds={erasePageStrokeIds}
            onModeChange={setAnnotationMode}
            onStylusStrokeActiveChange={setAnnotationStrokeActive}
          >
            <Pdf
              ref={pdfRef as React.Ref<any>}
              source={pdfSource}
              page={initialPage}
              trustAllCerts={false}
              onLoadComplete={handlePdfLoadComplete}
              onPageChanged={handlePdfPageChanged}
              onError={handlePdfError}
              enablePaging={false}
              scrollEnabled={!annotationStrokeActive}
              spacing={8}
              horizontal={false}
              minScale={1}
              maxScale={5}
              enableDoubleTapZoom
              style={styles.pdf}
            />
          </MaterialAnnotationOverlay>

          <AnnotationToolbar
            mode={annotationMode}
            onModeChange={setAnnotationMode}
            penColor={penColor}
            onPenColorChange={setPenColor}
            penWidth={penWidth}
            onPenWidthChange={setPenWidth}
            highlighterColor={highlighterColor}
            onHighlighterColorChange={setHighlighterColor}
            highlighterWidth={highlighterWidth}
            onHighlighterWidthChange={setHighlighterWidth}
            eraserRadius={eraserRadius}
            onEraserRadiusChange={setEraserRadius}
            onUndo={undoCurrentPage}
            canUndo={pageStrokes.length > 0}
            doubleTapAvailable={doubleTapAvailable}
          />
        </View>
      ) : null}

      {/* Loading + error sit ON TOP of the PDF, centered. */}
      {loadingPdf && !pdfError ? (
        <View style={styles.pdfLoading} pointerEvents="none">
          <ActivityIndicator color={colors.deepNavy} />
          <Text style={styles.pdfLoadingLabel}>Opening PDF…</Text>
        </View>
      ) : null}
      {pdfError ? (
        <View style={styles.pdfErrorBlock} pointerEvents="none">
          <Ionicons name="alert-circle-outline" size={28} color={colors.recordingRed} />
          <Text style={styles.emptyTitle}>Could not open this PDF.</Text>
          <Text style={styles.emptyBody}>{pdfError}</Text>
        </View>
      ) : null}

      {/* Floating overlays — each one is a small frosted-glass pill that
          floats above the PDF. `box-none` everywhere so we never block
          PDF gestures except where a Pressable explicitly captures. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {/* Back button — top-left, respects safe area */}
        <FloatingBackButton
          onPress={() => router.back()}
          style={{ top: insets.top + spacing.md, left: spacing.md }}
        />

        {/* Title pill — top-center, respects safe area. Shows page count
            inline only when the document has reported its page count. */}
        <View
          style={[styles.floatingTitleWrap, { top: insets.top + spacing.md }]}
          pointerEvents="box-none"
        >
          <View style={styles.floatingTitlePill}>
            <Text style={styles.floatingTitleText} numberOfLines={1}>
              {material.title}
            </Text>
            {totalPages > 0 ? (
              <>
                <View style={styles.floatingTitleDivider} />
                <Text style={styles.floatingTitleMeta}>
                  {currentPage}/{totalPages}
                </Text>
              </>
            ) : null}
          </View>
        </View>

        {/* Pen toolbar — top-right, respects safe area */}
        {useNativePdfViewer ? (
          <View
            style={[styles.floatingToolbarWrap, { top: insets.top + spacing.md, right: spacing.md }]}
            pointerEvents="box-none"
          >
            <NativePenToolbar
              mode={nativeAnnotationMode}
              onChangeMode={handleNativeModeChange}
              color={nativePenColor}
              onChangeColor={setNativePenColor}
              width={nativePenWidth}
              onChangeWidth={setNativePenWidth}
              highlighterColor={nativeHighlighterColor}
              onChangeHighlighterColor={setNativeHighlighterColor}
              highlighterWidth={nativeHighlighterWidth}
              onChangeHighlighterWidth={setNativeHighlighterWidth}
              eraserRadius={nativeEraserRadius}
              onChangeEraserRadius={setNativeEraserRadius}
              onUndo={undoNativeCurrentPage}
              canUndo={pageStrokes.some((stroke) => stroke.coordSpace === 'pdfPage')}
            />
          </View>
        ) : null}

        {/* Page navigator — bottom-right, lifts over the captions strip
            when one is active. Tap the current-page number to open the
            Go-to-page modal. */}
        <FloatingPageNavigator
          currentPage={currentPage}
          totalPages={totalPages}
          visible={navigatorVisible}
          onTapCurrent={openJumpModal}
          bottomOffset={insets.bottom + spacing.lg}
          captionsEnabled={!materialReviewMode}
        />

        {!materialReviewMode ? (
          <FloatingMiniCaption topOffset={insets.top + 80} />
        ) : null}
      </View>

      <GoToPageModal
        visible={jumpModalVisible}
        currentPage={currentPage}
        totalPages={totalPages}
        onCancel={closeJumpModal}
        onGo={handleJumpGo}
      />
    </View>
  );
}

/**
 * Floating glass back button. 44pt round, semi-transparent white, soft shadow.
 * Positioned by the caller with absolute `top` / `left`.
 */
function FloatingBackButton({
  onPress,
  style,
}: {
  onPress: () => void;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.floatingBack, style, pressed && styles.pressed]}
    >
      <Ionicons name="chevron-back" size={22} color={colors.deepNavy} />
    </Pressable>
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
  bottomOffset,
  captionsEnabled,
}: {
  currentPage: number;
  totalPages: number;
  visible: boolean;
  onTapCurrent: () => void;
  /** Distance from the bottom of the screen — typically `insets.bottom + spacing.lg`. */
  bottomOffset: number;
  captionsEnabled: boolean;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: visible ? 140 : 260,
      useNativeDriver: true,
    }).start();
  }, [visible, opacity]);

  // Lift the pill above the captions strip when a caption session is active —
  // otherwise the two surfaces would stack on top of each other in the
  // bottom-right corner.
  const { status } = useLiveCaptions();
  const captionsShown = captionsEnabled && (
    status === 'active' ||
    status === 'listening' ||
    status === 'connecting' ||
    status === 'error'
  );
  const bottom = bottomOffset + (captionsShown ? 80 : 0);

  if (!Number.isFinite(currentPage) || currentPage <= 0) return null;

  const showTotal = Number.isFinite(totalPages) && totalPages > 0;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.pageNav,
        { bottom, opacity },
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

function NativePenToolbar({
  mode,
  onChangeMode,
  color,
  onChangeColor,
  width,
  onChangeWidth,
  highlighterColor,
  onChangeHighlighterColor,
  highlighterWidth,
  onChangeHighlighterWidth,
  eraserRadius,
  onChangeEraserRadius,
  onUndo,
  canUndo,
}: {
  mode: NativePdfAnnotationMode;
  onChangeMode: (next: NativePdfAnnotationMode) => void;
  color: string;
  onChangeColor: (next: string) => void;
  width: number;
  onChangeWidth: (next: number) => void;
  highlighterColor: string;
  onChangeHighlighterColor: (next: string) => void;
  highlighterWidth: number;
  onChangeHighlighterWidth: (next: number) => void;
  eraserRadius: number;
  onChangeEraserRadius: (next: number) => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const activeColor = mode === 'highlighter' ? highlighterColor : color;
  const colorOptions = mode === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widthOptions = mode === 'highlighter' ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
  const activeWidth = mode === 'highlighter' ? highlighterWidth : width;
  const showInkOptions = mode === 'pen' || mode === 'highlighter';

  return (
    <View style={styles.nativeToolbar} pointerEvents="auto">
      <View style={styles.nativeToolbarRow}>
        <NativeToolbarButton
          label="Scroll"
          icon="hand-left-outline"
          active={mode === 'scroll'}
          onPress={() => onChangeMode('scroll')}
        />
        <NativeToolbarButton
          label="Pen"
          icon="pencil"
          active={mode === 'pen'}
          onPress={() => onChangeMode('pen')}
        />
        <NativeToolbarButton
          label="Highlight"
          icon="color-wand-outline"
          active={mode === 'highlighter'}
          onPress={() => onChangeMode('highlighter')}
        />
        <NativeToolbarButton
          label="Erase"
          icon="backspace-outline"
          active={mode === 'eraser'}
          onPress={() => onChangeMode('eraser')}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo last annotation stroke"
          disabled={!canUndo}
          onPress={onUndo}
          style={({ pressed }) => [
            styles.nativeUndoButton,
            !canUndo && styles.nativeUndoButtonDisabled,
            pressed && canUndo && styles.pressed,
          ]}
        >
          <Ionicons name="arrow-undo-outline" size={16} color={colors.deepNavy} />
        </Pressable>
      </View>

      {showInkOptions ? (
        <View style={styles.nativePenOptionsRow}>
          <View style={styles.nativeColorRow}>
            {colorOptions.map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: activeColor === option.value }}
                accessibilityLabel={`${option.key} ${mode === 'highlighter' ? 'highlighter' : 'pen'} color`}
                onPress={() => (
                  mode === 'highlighter'
                    ? onChangeHighlighterColor(option.value)
                    : onChangeColor(option.value)
                )}
                style={({ pressed }) => [
                  styles.nativeColorSwatch,
                  { backgroundColor: option.value },
                  activeColor === option.value && styles.nativeColorSwatchActive,
                  pressed && styles.pressed,
                ]}
              />
            ))}
          </View>
          <View style={styles.nativeToolbarVerticalDivider} />
          <View style={styles.nativeWidthRow}>
            {widthOptions.map((option) => {
              // Visual size derived from value; capped so the dot fits the chip.
              const dotSize = mode === 'highlighter'
                ? Math.min(18, Math.max(8, Math.round(option.value / 1.8)))
                : Math.min(14, Math.max(6, Math.round(option.value * 2)));
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeWidth === option.value }}
                  accessibilityLabel={`${option.key} stroke width`}
                  onPress={() => (
                    mode === 'highlighter'
                      ? onChangeHighlighterWidth(option.value)
                      : onChangeWidth(option.value)
                  )}
                  style={({ pressed }) => [
                    styles.nativeWidthOption,
                    activeWidth === option.value && styles.nativeWidthOptionActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <View
                    style={[
                      styles.nativeWidthDot,
                      {
                        width: dotSize,
                        height: dotSize,
                        borderRadius: dotSize / 2,
                      },
                    ]}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : mode === 'eraser' ? (
        <View style={styles.nativePenOptionsRow}>
          <View style={styles.nativeWidthRow}>
            {ERASER_SIZES.map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: eraserRadius === option.value }}
                accessibilityLabel={`${option.key} eraser size`}
                onPress={() => onChangeEraserRadius(option.value)}
                style={({ pressed }) => [
                  styles.nativeEraserOption,
                  eraserRadius === option.value && styles.nativeWidthOptionActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.nativeEraserOptionText}>{option.key}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function NativeToolbarButton({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label} annotation mode`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.nativeToolbarButton,
        active && styles.nativeToolbarButtonActive,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons name={icon} size={15} color={active ? colors.textOnNavy : colors.deepNavy} />
      <Text style={[styles.nativeToolbarLabel, active && styles.nativeToolbarLabelActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function AnnotationToolbar({
  mode,
  onModeChange,
  penColor,
  onPenColorChange,
  penWidth,
  onPenWidthChange,
  highlighterColor,
  onHighlighterColorChange,
  highlighterWidth,
  onHighlighterWidthChange,
  eraserRadius,
  onEraserRadiusChange,
  onUndo,
  canUndo,
  doubleTapAvailable,
}: {
  mode: MaterialAnnotationMode;
  onModeChange: (mode: MaterialAnnotationMode) => void;
  penColor: string;
  onPenColorChange: (color: string) => void;
  penWidth: number;
  onPenWidthChange: (width: number) => void;
  highlighterColor: string;
  onHighlighterColorChange: (color: string) => void;
  highlighterWidth: number;
  onHighlighterWidthChange: (width: number) => void;
  eraserRadius: number;
  onEraserRadiusChange: (radius: number) => void;
  onUndo: () => void;
  canUndo: boolean;
  doubleTapAvailable: boolean;
}) {
  const drawing = mode === 'pen' || mode === 'highlighter' || mode === 'eraser';
  const colorOptions = mode === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widthOptions = mode === 'highlighter' ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
  const selectedColor = mode === 'highlighter' ? highlighterColor : penColor;
  const selectedWidth = mode === 'highlighter' ? highlighterWidth : penWidth;

  return (
    <View style={styles.annotationToolbar} pointerEvents="auto">
      <View style={styles.annotationModeRow}>
        <ToolButton
          label="Scroll"
          icon="hand-left-outline"
          active={mode === 'scroll'}
          onPress={() => onModeChange('scroll')}
        />
        <ToolButton
          label="Pen"
          icon="pencil"
          active={mode === 'pen'}
          onPress={() => onModeChange('pen')}
        />
        <ToolButton
          label="Highlight"
          icon="color-wand-outline"
          active={mode === 'highlighter'}
          onPress={() => onModeChange('highlighter')}
        />
        <ToolButton
          label="Erase"
          icon="backspace-outline"
          active={mode === 'eraser'}
          onPress={() => onModeChange('eraser')}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo last annotation stroke"
          disabled={!canUndo}
          onPress={onUndo}
          style={({ pressed }) => [
            styles.annotationIconButton,
            !canUndo && styles.annotationButtonDisabled,
            pressed && canUndo && styles.pressed,
          ]}
        >
          <Ionicons name="arrow-undo-outline" size={17} color={colors.deepNavy} />
        </Pressable>
      </View>

      {drawing ? (
        <View style={styles.annotationOptions}>
          {mode === 'eraser' ? (
            <View style={styles.widthOptions}>
              {ERASER_SIZES.map((option) => (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityLabel={`${option.key} eraser size`}
                  onPress={() => onEraserRadiusChange(option.value)}
                  style={({ pressed }) => [
                    styles.eraserSizeOption,
                    eraserRadius === option.value && styles.widthOptionActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.eraserSizeLabel}>{option.key}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <>
              <View style={styles.annotationSwatches}>
                {colorOptions.map((option) => (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityLabel={`${option.key} ${mode === 'highlighter' ? 'highlighter' : 'pen'} color`}
                    onPress={() =>
                      mode === 'highlighter'
                        ? onHighlighterColorChange(option.value)
                        : onPenColorChange(option.value)
                    }
                    style={({ pressed }) => [
                      styles.colorSwatch,
                      { backgroundColor: option.value },
                      selectedColor === option.value && styles.colorSwatchActive,
                      pressed && styles.pressed,
                    ]}
                  />
                ))}
              </View>
              <View style={styles.widthOptions}>
                {widthOptions.map((option) => (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityLabel={`${option.key} stroke width`}
                    onPress={() =>
                      mode === 'highlighter'
                        ? onHighlighterWidthChange(option.value)
                        : onPenWidthChange(option.value)
                    }
                    style={({ pressed }) => [
                      styles.widthOption,
                      selectedWidth === option.value && styles.widthOptionActive,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View
                      style={[
                        styles.widthDot,
                        {
                          width: Math.max(6, option.value),
                          height: Math.max(6, option.value),
                          borderRadius: Math.max(3, option.value / 2),
                        },
                      ]}
                    />
                  </Pressable>
                ))}
              </View>
            </>
          )}
          {doubleTapAvailable ? (
            <Text style={styles.doubleTapHint}>Pencil double-tap toggles eraser</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ToolButton({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.annotationToolButton,
        active && styles.annotationToolButtonActive,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons name={icon} size={15} color={active ? colors.textOnNavy : colors.deepNavy} />
      <Text style={[styles.annotationToolLabel, active && styles.annotationToolLabelActive]}>
        {label}
      </Text>
    </Pressable>
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
  // Full-bleed workspace. Matches the native PDFKit canvas color so the RN
  // background and the PDFKit surround blend seamlessly — no visible
  // rectangle between them when the page floats inside the canvas.
  root: { flex: 1, backgroundColor: colors.background },
  // PDF view fills the entire screen (no card, no margins).
  pdfFill: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.background },
  // Legacy JS fallback wrap (only rendered when native isn't available — on
  // iOS dev binaries this branch is dead code).
  legacyPdfWrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.surfaceMuted,
  },
  pdf: { flex: 1, backgroundColor: colors.surfaceMuted },

  // ---- Header / back button — left as no-ops below; the Header component
  //      is retained but no longer rendered. Floating overlays replace it.
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

  // ---- Floating overlay controls (frosted-glass look without a blur module) ----
  floatingBack: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    borderWidth: 1,
    borderColor: 'rgba(6, 27, 52, 0.08)',
    shadowColor: '#0A2342',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 5,
  },
  floatingTitleWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  floatingTitlePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    maxWidth: 420,
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(6, 27, 52, 0.08)',
    shadowColor: '#0A2342',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 5,
  },
  floatingTitleText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: -0.1,
    maxWidth: 280,
  },
  floatingTitleDivider: {
    width: 1,
    height: 14,
    backgroundColor: 'rgba(6, 27, 52, 0.18)',
  },
  floatingTitleMeta: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textTertiary,
    letterSpacing: 0.2,
  },
  floatingToolbarWrap: {
    position: 'absolute',
  },
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
  // Bottom-right pill. The deep-navy fill is intentionally heavier than the
  // glass overlays so the "current page" indicator stays unambiguous against
  // the light canvas. `bottom` is supplied inline by the component so it can
  // respect safe-area insets and lift over the captions strip.
  pageNav: {
    position: 'absolute',
    right: spacing.lg,
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

  // ---- Native (Phase 2) Scroll/Pen toolbar ----
  // Outer pill is column-flex so the Pen options can sit below the Scroll/Pen
  // row. When Pen is inactive the second row isn't rendered, so the pill
  // collapses to its original two-button width. The wrapping parent
  // (`floatingToolbarWrap`) supplies the absolute top/right positioning so
  // the toolbar can respect safe-area insets.
  nativeToolbar: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: spacing.xs,
    padding: spacing.xs + 2,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    borderWidth: 1,
    borderColor: 'rgba(6, 27, 52, 0.08)',
    shadowColor: '#0A2342',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 5,
  },
  nativeToolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: spacing.xs,
    maxWidth: 420,
  },
  nativeToolbarButton: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
  },
  nativeToolbarButtonActive: {
    backgroundColor: colors.deepNavy,
  },
  nativeToolbarLabel: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    color: colors.deepNavy,
  },
  nativeToolbarLabelActive: {
    color: colors.textOnNavy,
  },
  nativeUndoButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: 'rgba(6, 27, 52, 0.08)',
  },
  nativeUndoButtonDisabled: {
    opacity: 0.38,
  },

  // ---- Pen color + width row (only visible when Pen mode is active) ----
  nativePenOptionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingTop: 6,
    paddingBottom: 2,
  },
  nativeColorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  nativeColorSwatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(6, 27, 52, 0.16)',
  },
  nativeColorSwatchActive: {
    borderColor: colors.deepNavy,
    transform: [{ scale: 1.08 }],
  },
  nativeToolbarVerticalDivider: {
    width: 1,
    height: 22,
    backgroundColor: colors.border,
  },
  nativeWidthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  nativeWidthOption: {
    minWidth: 30,
    height: 26,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  nativeWidthOptionActive: {
    borderColor: colors.deepNavy,
    backgroundColor: colors.iceTint,
  },
  nativeWidthDot: {
    backgroundColor: colors.deepNavy,
  },
  nativeEraserOption: {
    minWidth: 58,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  nativeEraserOptionText: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    color: colors.deepNavy,
  },

  // ---- Annotation toolbar ----
  annotationToolbar: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    zIndex: 9,
    maxWidth: 520,
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#0A2342',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 20,
    elevation: 8,
  },
  annotationModeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  annotationToolButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
  },
  annotationToolButtonActive: {
    backgroundColor: colors.deepNavy,
  },
  annotationToolLabel: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    color: colors.deepNavy,
  },
  annotationToolLabelActive: {
    color: colors.textOnNavy,
  },
  annotationIconButton: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  annotationButtonDisabled: {
    opacity: 0.42,
  },
  annotationOptions: {
    gap: spacing.xs,
  },
  annotationSwatches: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  colorSwatch: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'rgba(6, 27, 52, 0.14)',
  },
  colorSwatchActive: {
    borderColor: colors.deepNavy,
    transform: [{ scale: 1.08 }],
  },
  widthOptions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  widthOption: {
    minWidth: 32,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  widthOptionActive: {
    borderColor: colors.deepNavy,
    backgroundColor: colors.iceTint,
  },
  widthDot: {
    backgroundColor: colors.deepNavy,
  },
  eraserSizeOption: {
    minWidth: 64,
    height: 30,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  eraserSizeLabel: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    color: colors.deepNavy,
  },
  doubleTapHint: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textTertiary,
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
