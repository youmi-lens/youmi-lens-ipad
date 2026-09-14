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
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Alert,
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
import { MaterialFloatingToolbar } from '@/components/MaterialFloatingToolbar';
import { PageIndicatorBadge } from '@/components/PageIndicatorBadge';
import { useLiveCaptions } from '@/lib/liveCaptions';
import { useRecordingNotes } from '@/lib/recordingNotes';
import { useT, localizeSystemDefaultTitle } from '@/lib/i18n';
import {
  MaterialAnnotationMode,
  MaterialAnnotationOverlay,
  type MaterialDrawingMode,
} from '@/components/MaterialAnnotationOverlay';
import { NativePdfAnnotationView, type NativePdfAnnotationViewRef } from '@/components/NativePdfAnnotationView';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { resolveMaterialUri } from '@/lib/importMaterial';
import { clampedMaterialResumePage, compositePageCount, appendedPageCountAfterFinalPageContent } from '@/lib/materialWorkspace';
import { materialViewportEqual, normalizeMaterialViewport } from '@/lib/materialViewport';
import {
  EMPTY_MATERIAL_HISTORY,
  applyMaterialHistoryRedo,
  applyMaterialHistoryUndo,
  popMaterialHistoryRedo,
  popMaterialHistoryUndo,
  pushMaterialHistory,
  type MaterialHistoryAction,
  type MaterialHistoryApplyResult,
  type MaterialHistoryState,
} from '@/lib/materialHistory';
import type { MaterialAnnotationStroke, MaterialTextAnnotation, MaterialViewport } from '@/lib/models';
import type {
  NativePdfAnnotationMode,
  NativePdfAnnotationsByPage,
  NativePdfAnnotationsChangedEvent,
  NativePdfAnnotationStroke,
  NativePdfTextAnnotationActionEvent,
  NativePdfViewportDiagnosticEvent,
  NativePdfTextAnnotationsByPage,
  NativePdfViewport,
} from '@/modules/expo-pdf-annotation';
import { exportAnnotatedPdfAsync } from '@/modules/expo-pdf-annotation';
import * as Sharing from 'expo-sharing';
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
// `dot` is the preview-dot diameter shown inside each width/size nib (matches the
// Notebook's nib visual language); `value` is the actual stroke width / radius.
// PEN values are exactly Notebook's own PEN_WIDTHS (components/NotebookCanvas.tsx)
// — they had drifted ~15-20% thicker at every tier, which is what made this pen
// feel like a heavier marker than Notebook's despite every other part of the
// drawing pipeline (gesture handling, point filtering, curve smoothing, opacity)
// already being identical between the two.
const PEN_WIDTHS = [
  { key: 'Thin', value: 2, dot: 7 },
  { key: 'Medium', value: 3.5, dot: 11 },
  { key: 'Thick', value: 6, dot: 16 },
];
const HIGHLIGHTER_WIDTHS = [
  { key: 'Narrow', value: 12, dot: 8 },
  { key: 'Medium', value: 18, dot: 12 },
  { key: 'Wide', value: 26, dot: 17 },
];
const ERASER_SIZES = [
  { key: 'Small', value: 16, dot: 8 },
  { key: 'Medium', value: 26, dot: 13 },
  { key: 'Large', value: 40, dot: 19 },
];
const MATERIAL_REVIEW_LECTURE_ID = '__material_review__';

function debugMaterialViewport(event: string, values: Record<string, unknown>) {
  if (__DEV__) console.log(`[material-viewport] ${event}`, values);
}

function materialScopeLectureId(materialId: string): string {
  return `material:${materialId}`;
}

export default function LectureMaterialWorkspaceScreen() {
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ lectureId?: string; materialId?: string }>();
  const {
    getMaterial,
    updateMaterial,
    linkMaterialToLecture,
    annotationsForMaterialPage,
    textAnnotationsForMaterialPage,
    addAnnotationStroke,
    replaceMaterialPageAnnotationStrokesForMaterial,
    replaceMaterialPageTextAnnotationsForMaterial,
  } = useData();

  const lectureId = params.lectureId ?? '';
  const material = getMaterial(params.materialId);
  const materialReviewMode = lectureId === MATERIAL_REVIEW_LECTURE_ID;
  // A recording session can still be active in the background while the user
  // browses materials through the standalone review route (materialReviewMode
  // is purely a route-parameter check — it has no idea whether a session is
  // actually running elsewhere). The Caption workspace must follow the
  // RECORDING session, not the live-caption provider's network/API status —
  // a live-caption backend outage (e.g. no DashScope key configured) must not
  // make the classroom Caption workspace disappear while a lecture is still
  // being recorded. isLectureSessionActive is the same authoritative,
  // cross-screen "is the Recording screen currently running a session" signal
  // app/lecture/[id].tsx already uses to know a recording is live elsewhere
  // (see lib/recordingNotes.tsx) — registered true only while app/recording.tsx
  // is mounted with an active pause/resume handler, false otherwise.
  const { isLectureSessionActive: classroomSessionActive } = useRecordingNotes();
  // Course Material is one user-scoped document per materialId. Its resume
  // position must not vary according to the lecture route that happened to
  // open it, so legacy link-local positions are deliberately not consulted.
  const initialLinkedPage = clampedMaterialResumePage(
    material?.lastOpenedPage,
    compositePageCount(material?.sourcePageCount ?? material?.pageCount ?? 1, material?.appendedPageCount ?? 0),
  );
  // This value is intentionally captured once per reader mount. Passing a
  // freshly persisted viewport back to native would replay restoration on
  // every store update and turn ordinary reading into a feedback loop.
  const [initialViewport] = useState<NativePdfViewport | undefined>(() =>
    normalizeMaterialViewport(
      material?.lastOpenedViewport,
      compositePageCount(material?.sourcePageCount ?? material?.pageCount ?? 1, material?.appendedPageCount ?? 0),
    ),
  );
  useEffect(() => {
    debugMaterialViewport('mount-read', {
      materialId: material?.id,
      legacyPage: material?.lastOpenedPage,
      viewport: initialViewport,
      initialPage: initialViewport?.pageIndex ?? initialLinkedPage,
    });
  // Captured mount inputs are intentionally not live restore props.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const useNativePdfViewer = USE_NATIVE_PDF_VIEWER && Platform.OS === 'ios';

  // --- Native PDFKit annotation state (Phase 2) ---
  // Native overlay-only state; the legacy JS-overlay branch below does NOT use these.
  const [nativeAnnotationMode, setNativeAnnotationMode] = useState<NativePdfAnnotationMode>('scroll');
  // Pen/Highlight colour are user-selectable from the toolbar's colour strip;
  // width and eraser size keep their default presets (no width picker). The
  // native view reads these on every render, so changing the colour applies to
  // the next stroke without touching committed annotations or PDF coordinates.
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
  const nativeCurrentPageRef = useRef<number>(initialViewport?.pageIndex ?? initialLinkedPage);
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

  const [currentPage, setCurrentPage] = useState<number>(initialViewport?.pageIndex ?? initialLinkedPage);
  const [totalPages, setTotalPages] = useState<number>(material?.pageCount ?? 0);
  const [sourcePageCount, setSourcePageCount] = useState<number>(material?.sourcePageCount ?? material?.pageCount ?? 0);
  const [appendedPageCount, setAppendedPageCount] = useState<number>(material?.appendedPageCount ?? 0);
  // Text create/edit is a native inline UITextView overlay directly on the
  // PDF page (PdfAnnotationView.inlineTextEditor) — no JS-side modal. JS
  // only ever receives the FINAL committed 'create'/'edit' event, already
  // typed and confirmed natively (see handleNativeTextAnnotationAction).
  const [selectedTextAnnotationId, setSelectedTextAnnotationId] = useState<string | undefined>();
  const [exporting, setExporting] = useState(false);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [annotationMode, setAnnotationMode] = useState<MaterialAnnotationMode>('scroll');
  // Fallback (JS overlay) ink presets — colour, width and eraser size selectable.
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1].value);
  const [highlighterColor, setHighlighterColor] = useState(HIGHLIGHTER_COLORS[0].value);
  const [highlighterWidth, setHighlighterWidth] = useState(HIGHLIGHTER_WIDTHS[1].value);
  const [eraserRadius, setEraserRadius] = useState(ERASER_SIZES[1].value);
  const [annotationStrokeActive, setAnnotationStrokeActive] = useState(false);
  const [previousDrawingTool, setPreviousDrawingTool] = useState<MaterialDrawingMode>('pen');
  const previousDrawModeRef = useRef<MaterialDrawingMode>('pen');
  const doubleTapAvailable = useMemo(() => isPencilDoubleTapAvailable(), []);

  // Native path: ONE unified, time-ordered Undo/Redo history covering both
  // strokes and text (see lib/materialHistory.ts) — a mixed sequence like
  // draw → move text → draw undoes in true chronological order, which two
  // independent per-type stacks cannot do correctly. It is only an operation
  // log ABOVE the existing stroke/text stores; storage is unchanged. Scoped
  // to the current page/session — cleared on page change, not persisted.
  const [nativeHistory, setNativeHistory] = useState<MaterialHistoryState>(EMPTY_MATERIAL_HISTORY);
  // Legacy JS-overlay path keeps its own simpler stroke-only redo stack,
  // unchanged — text/paste never existed there, so it's out of scope here.
  const [redoStack, setRedoStack] = useState<MaterialAnnotationStroke[]>([]);

  // Capture the page we want the PDF to open at ONCE on mount. Passing
  // `material.lastOpenedPage` as the live `page` prop would cause the
  // viewer to jump every time we persist a new page, which itself fires
  // onPageChanged again and loops.
  const [initialPage] = useState<number>(() => Math.max(1, initialViewport?.pageIndex ?? initialLinkedPage));
  // Display scope is material-wide for every entry point. Recording mode still
  // writes new strokes to the current lecture id, but the viewer shows the
  // shared PDF history by default.
  const pageStrokes = annotationsForMaterialPage(material?.id ?? '', currentPage);
  const sourcePageCountRef = useRef(sourcePageCount);
  const appendedPageCountRef = useRef(appendedPageCount);
  useEffect(() => { sourcePageCountRef.current = sourcePageCount; }, [sourcePageCount]);
  useEffect(() => { appendedPageCountRef.current = appendedPageCount; }, [appendedPageCount]);

  // Native-path unified history is scoped to the whole document/editing
  // session, NOT the current page — a mixed Pen→Highlighter→Text sequence
  // that happens to cross a page boundary (including an incidental scroll
  // nudge PDFKit reports as a page change, not just deliberate navigation)
  // must stay fully undoable. Each history action already carries its own
  // pageNumber (see lib/materialHistory.ts) and undo/redo apply it there
  // directly, so nothing here needs the CURRENT page to reconstruct a step.
  // Only reset when the DOCUMENT itself changes (a genuinely new editing
  // session) — in practice this component remounts on materialId change,
  // so this only fires if it's ever reused across materials without an
  // unmount.
  useEffect(() => {
    setNativeHistory(EMPTY_MATERIAL_HISTORY);
  }, [material?.id]);

  // Legacy JS-overlay path keeps its existing, unrelated, page-scoped redo
  // behavior — untouched, out of scope for this native-path history fix.
  useEffect(() => {
    setRedoStack([]);
  }, [currentPage]);

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
      debugMaterialViewport('pencil-double-tap', {
        mode: nativeAnnotationModeRef.current,
        nativePage: nativeCurrentPageRef.current,
      });
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
  const savedLastPageRef = useRef<number | undefined>(material?.lastOpenedPage);
  const pendingPageRef = useRef<number | undefined>(material?.lastOpenedPage);
  const savedViewportRef = useRef<MaterialViewport | undefined>(material?.lastOpenedViewport);
  const pendingViewportRef = useRef<MaterialViewport | undefined>(undefined);
  const pageDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const totalPagesRef = useRef(totalPages);
  useEffect(() => { totalPagesRef.current = totalPages; }, [totalPages]);

  // The native iOS reader owns sampling scroll/zoom. JS merely retains its
  // debounced, PDF-space snapshot and writes the latest complete value.
  const flushViewportToStore = useCallback(() => {
    const id = materialIdRef.current;
    const viewport = pendingViewportRef.current;
    if (!id || !viewport) {
      debugMaterialViewport('persist-skip', { materialId: id, latestJsViewport: viewport });
      return;
    }
    const pageChanged = viewport.pageIndex !== savedLastPageRef.current;
    const viewportChanged = !materialViewportEqual(viewport, savedViewportRef.current);
    if (!pageChanged && !viewportChanged) {
      debugMaterialViewport('persist-skip-unchanged', { materialId: id, viewport });
      return;
    }
    savedLastPageRef.current = viewport.pageIndex;
    savedViewportRef.current = viewport;
    debugMaterialViewport('persist-write', { materialId: id, viewport, pageChanged, viewportChanged });
    updateMaterial(id, { lastOpenedPage: viewport.pageIndex, lastOpenedViewport: viewport });
  }, [updateMaterial]);

  const scheduleViewportPersist = useCallback(() => {
    if (pageDebounceRef.current) clearTimeout(pageDebounceRef.current);
    pageDebounceRef.current = setTimeout(() => {
      pageDebounceRef.current = null;
      flushViewportToStore();
    }, 500);
  }, [flushViewportToStore]);

  // Authoritative flush for leave/background boundaries. The normal
  // scroll/zoom path is debounced ~350ms natively + 500ms in JS — a fast
  // "jump to page N, then immediately leave" beats both debounces, so
  // `pendingViewportRef` can still hold an OLDER snapshot at the exact
  // moment of leave. captureViewport() bypasses both debounces and reads
  // PDFKit's current page/scale/anchor directly; awaiting its result (not
  // just logging it) before persisting is what makes this authoritative
  // rather than the previous fire-and-log pattern. Falls back to the latest
  // JS snapshot (flushViewportToStore's existing behavior) if the native
  // view is already gone or has nothing to report.
  const persistAuthoritativeViewport = useCallback((nativePdf: NativePdfAnnotationViewRef | null) => {
    if (!useNativePdfViewer || !nativePdf) {
      flushViewportToStore();
      return;
    }
    void nativePdf.captureViewport()
      .then((nativeViewport) => {
        const normalized = nativeViewport ? normalizeMaterialViewport(nativeViewport, totalPagesRef.current) : undefined;
        debugMaterialViewport('authoritative-capture', {
          materialId: materialIdRef.current,
          nativeViewport,
          normalized,
          latestJsViewport: pendingViewportRef.current,
        });
        if (normalized) pendingViewportRef.current = normalized;
      })
      .catch((error) => {
        debugMaterialViewport('authoritative-capture-failed', {
          materialId: materialIdRef.current,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        flushViewportToStore();
      });
  }, [flushViewportToStore, useNativePdfViewer]);

  // Imperative jump via the native reader / fallback viewer. Keeping the
  // ref separate from the initial page prop prevents prop-driven page loops.
  const pdfRef = useRef<NativePdfAnnotationViewRef | null>(null);

  // True once the beforeRemove-driven authoritative capture has completed
  // for this mount's leave attempt. Guards the classic beforeRemove
  // recursion (preventDefault -> persist -> re-dispatch the original action
  // -> beforeRemove fires again for that same removal) and tells the
  // unmount-cleanup effect its own capture is now a redundant last resort,
  // not the primary path.
  const leavePersistenceCompletedRef = useRef(false);

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
    savedLastPageRef.current = material.lastOpenedPage;
    savedViewportRef.current = material.lastOpenedViewport;
    pendingPageRef.current = savedLastPageRef.current;
    pendingViewportRef.current = undefined;
  }, [lectureId, material?.id, materialReviewMode]);

  // On unmount, flush any pending page write that the debounce didn't run,
  // and clear the page-indicator hide timer. updateMaterial is created with
  // useCallback([]) in the store, so its reference is stable — this effect
  // mounts/unmounts exactly once.
  useEffect(() => {
    const nativePdf = pdfRef.current;
    return () => {
      if (pageDebounceRef.current) {
        clearTimeout(pageDebounceRef.current);
        pageDebounceRef.current = null;
      }
      // If beforeRemove already ran the authoritative capture for this leave
      // (the normal Back/navigation path, while the native ref was still
      // alive), this unmount cleanup is a redundant last-resort fallback —
      // skip it entirely rather than risk a second, now-stale native call
      // clobbering the value beforeRemove already persisted. It still runs
      // for teardown paths that never fire beforeRemove.
      if (leavePersistenceCompletedRef.current) {
        debugMaterialViewport('leave-unmount-skip', {
          materialId: materialIdRef.current,
          reason: 'beforeRemove already persisted',
        });
        return;
      }
      debugMaterialViewport('leave-start', {
        materialId: materialIdRef.current,
        latestJsViewport: pendingViewportRef.current,
        savedViewport: savedViewportRef.current,
      });
      persistAuthoritativeViewport(nativePdf);
      if (navigatorHideTimerRef.current) {
        clearTimeout(navigatorHideTimerRef.current);
        navigatorHideTimerRef.current = null;
      }
      const id = materialIdRef.current;
      const pending = pendingPageRef.current;
      const saved = savedLastPageRef.current;
      if (!useNativePdfViewer && id && typeof pending === 'number' && pending !== saved) {
        savedLastPageRef.current = pending;
        updateMaterial(id, { lastOpenedPage: pending });
      }
    };
  }, [persistAuthoritativeViewport, updateMaterial, useNativePdfViewer]);

  // A background transition can happen before route cleanup. Ask native for
  // its current PDF-space anchor and immediately persist the latest snapshot.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' || !useNativePdfViewer) return;
      debugMaterialViewport('background-start', {
        materialId: materialIdRef.current,
        latestJsViewport: pendingViewportRef.current,
      });
      persistAuthoritativeViewport(pdfRef.current);
    });
    return () => subscription.remove();
  }, [persistAuthoritativeViewport, useNativePdfViewer]);

  // PRIMARY authoritative-leave boundary for Back/navigation. Proven from a
  // physical repro that the unmount-cleanup effect above runs too late for
  // this path: React had already detached the native host ref
  // (nativeRef.current === null inside NativePdfAnnotationView) by the time
  // that cleanup executed, so captureViewport() silently short-circuited to
  // a JS-only Promise.resolve(null) — the native bridge was never actually
  // invoked, and JS fell back to whatever stale viewport it already had.
  // beforeRemove fires while this screen (and its native ref) are still
  // fully mounted, before React starts detaching anything for the removal —
  // that is what makes it authoritative here, not the unmount cleanup.
  useEffect(() => {
    if (!useNativePdfViewer) return;
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      // Already handled this removal (this is the re-dispatch of the same
      // action after we called navigation.dispatch below) — let it through
      // exactly once. Without this guard, preventDefault + dispatch would
      // fire beforeRemove again for the very action we just re-issued,
      // looping forever.
      if (leavePersistenceCompletedRef.current) return;
      e.preventDefault();
      const nativePdf = pdfRef.current;
      debugMaterialViewport('before-remove-start', {
        materialId: materialIdRef.current,
        latestJsViewport: pendingViewportRef.current,
        savedViewport: savedViewportRef.current,
      });
      void (async () => {
        if (nativePdf) {
          try {
            const nativeViewport = await nativePdf.captureViewport();
            const normalized = nativeViewport
              ? normalizeMaterialViewport(nativeViewport, totalPagesRef.current)
              : undefined;
            debugMaterialViewport('before-remove-capture', {
              materialId: materialIdRef.current,
              nativeViewport,
              normalized,
              latestJsViewport: pendingViewportRef.current,
            });
            if (normalized) pendingViewportRef.current = normalized;
          } catch (error) {
            debugMaterialViewport('before-remove-capture-failed', {
              materialId: materialIdRef.current,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        // Bounded, deterministic, and always runs regardless of whether the
        // capture above succeeded — the user must never be trapped on this
        // screen waiting for a native call. A failed/missing capture simply
        // falls back to whatever JS already knew (flushViewportToStore's
        // existing behavior), same as every other leave path.
        flushViewportToStore();
        leavePersistenceCompletedRef.current = true;
        navigation.dispatch(e.data.action);
      })();
    });
    return unsubscribe;
  }, [flushViewportToStore, navigation, useNativePdfViewer]);

  const fileUri = material ? resolveMaterialUri(material.localPath) : '';
  // Memoize the source prop so react-native-pdf doesn't treat each render
  // as a new document and re-fire onLoadComplete.
  const pdfSource = useMemo(
    () => (fileUri ? { uri: fileUri, cache: false } : null),
    [fileUri],
  );

  const handlePdfLoadComplete = useCallback(
    (numberOfPages: number, loadedSourcePageCount?: number) => {
      setLoadingPdf(false);
      setPdfError(null);
      setTotalPages(numberOfPages);
      // Surface the page indicator briefly so the user sees "1 / 842" on
      // first open, then it auto-hides.
      showNavigatorBriefly();
      const id = materialIdRef.current;
      // Only persist if the stored pageCount actually differs. Combined with
      // updateMaterial being idempotent, two layers of guard against loops.
      const source = Math.max(1, loadedSourcePageCount ?? material?.sourcePageCount ?? numberOfPages);
      sourcePageCountRef.current = source;
      setSourcePageCount(source);
      if (id && (savedPageCountRef.current !== numberOfPages || material?.sourcePageCount !== source)) {
        savedPageCountRef.current = numberOfPages;
        updateMaterial(id, { pageCount: numberOfPages, sourcePageCount: source });
      }
    },
    [material?.sourcePageCount, showNavigatorBriefly, updateMaterial],
  );

  const handlePdfPageChanged = useCallback(
    (page: number) => {
      setCurrentPage(page);
      nativeCurrentPageRef.current = page;
      // Show indicator + reset auto-hide timer on every page change.
      showNavigatorBriefly();
      debugMaterialViewport('js-onPageChanged-received', { materialId: materialIdRef.current, page });
      // Native snapshots are intentionally suppressed until restoration is
      // complete. Do not turn a synthetic initial page callback into a write.
      if (useNativePdfViewer) return;
      pendingPageRef.current = page;
      if (pageDebounceRef.current) clearTimeout(pageDebounceRef.current);
      pageDebounceRef.current = setTimeout(() => {
        pageDebounceRef.current = null;
        const id = materialIdRef.current;
        const pending = pendingPageRef.current;
        if (id && typeof pending === 'number' && pending !== savedLastPageRef.current) {
          savedLastPageRef.current = pending;
          updateMaterial(id, { lastOpenedPage: pending });
        }
      }, 500);
    },
    [showNavigatorBriefly, updateMaterial, useNativePdfViewer],
  );

  const handleNativeViewportChanged = useCallback((snapshot: NativePdfViewport) => {
    const viewport = normalizeMaterialViewport(snapshot, totalPagesRef.current);
    if (!viewport) return;
    nativeCurrentPageRef.current = viewport.pageIndex;
    setCurrentPage(viewport.pageIndex);
    showNavigatorBriefly();
    pendingPageRef.current = viewport.pageIndex;
    pendingViewportRef.current = viewport;
    debugMaterialViewport('native-bridge-snapshot', { viewport });
    scheduleViewportPersist();
  }, [scheduleViewportPersist, showNavigatorBriefly]);

  const handleNativeViewportDiagnostic = useCallback((event: NativePdfViewportDiagnosticEvent) => {
    debugMaterialViewport('native-forensic', event);
  }, []);

  const handlePdfError = useCallback((err: unknown) => {
    setLoadingPdf(false);
    // Raw technical detail stays in logs; the user sees a localized generic message.
    console.warn('[material] PDF load error', err);
    setPdfError(t('material.loadFailed'));
  }, [t]);

  /** Adds one stable synthetic page only when the current final page receives real work. */
  const ensureTrailingBlankPageAfterContent = useCallback((pageNumber: number) => {
    const id = materialIdRef.current;
    const source = sourcePageCountRef.current;
    if (!id || source < 1) return;
    const next = appendedPageCountAfterFinalPageContent(source, appendedPageCountRef.current, pageNumber);
    if (next === appendedPageCountRef.current) return;
    appendedPageCountRef.current = next;
    setAppendedPageCount(next);
    const nextTotal = compositePageCount(source, next);
    savedPageCountRef.current = nextTotal;
    setTotalPages(nextTotal);
    updateMaterial(id, { sourcePageCount: source, appendedPageCount: next, pageCount: nextTotal });
  }, [updateMaterial]);

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
      const strokes = annotationsForMaterialPage(material.id, page);
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
  }, [annotationsForMaterialPage, lectureId, material?.id, material?.pageCount, totalPages, useNativePdfViewer]);

  const nativeTextAnnotationsByPage = useMemo<NativePdfTextAnnotationsByPage>(() => {
    const grouped: NativePdfTextAnnotationsByPage = {};
    if (!useNativePdfViewer || !material?.id) return grouped;
    const pageCount = totalPages || material.pageCount || 0;
    for (let page = 1; page <= pageCount; page += 1) {
      const annotations = textAnnotationsForMaterialPage(material.id, page);
      if (annotations.length > 0) grouped[String(page)] = annotations;
    }
    return grouped;
  }, [material?.id, material?.pageCount, textAnnotationsForMaterialPage, totalPages, useNativePdfViewer]);

  const saveTextAnnotations = useCallback((pageNumber: number, annotations: MaterialTextAnnotation[]) => {
    const id = materialIdRef.current;
    if (!id) return;
    replaceMaterialPageTextAnnotationsForMaterial(id, pageNumber, annotations, materialScopeLectureId(id));
  }, [replaceMaterialPageTextAnnotationsForMaterial]);

  // Shared by 'paste' and the native inline-editor's 'create' commit — both
  // hand JS the SAME shape (final text + position, already typed/confirmed
  // natively), so both create exactly one MaterialTextAnnotation and push
  // exactly one text-create history action. No second text-creation path.
  const createTextAnnotationFromEvent = useCallback((
    pageNumber: number, text: string, x: number, y: number, width: number, fontSize: number,
  ) => {
    const id = materialIdRef.current;
    if (!id) return;
    const current = textAnnotationsForMaterialPage(id, pageNumber);
    const now = new Date().toISOString();
    const created: MaterialTextAnnotation = {
      id: `material-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text, x, y, width, fontSize, createdAt: now, updatedAt: now,
    };
    setNativeHistory((h) => pushMaterialHistory(h, { kind: 'text-create', pageNumber, annotation: created }));
    saveTextAnnotations(pageNumber, [...current, created]);
    ensureTrailingBlankPageAfterContent(pageNumber);
  }, [ensureTrailingBlankPageAfterContent, saveTextAnnotations, textAnnotationsForMaterialPage]);

  const handleNativeTextAnnotationAction = useCallback((event: NativePdfTextAnnotationActionEvent) => {
    const id = materialIdRef.current;
    if (!id || !event.pageNumber) return;
    const current = textAnnotationsForMaterialPage(id, event.pageNumber);
    if (event.action === 'select' && event.annotationId) {
      setSelectedTextAnnotationId(event.annotationId);
      return;
    }
    if (event.action === 'deselect') {
      setSelectedTextAnnotationId(undefined);
      return;
    }
    if (event.action === 'create') {
      // The native inline editor already collected and confirmed the final
      // text before emitting this — no modal, nothing left to ask the user.
      const text = event.text?.trim();
      if (!text || !Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
      createTextAnnotationFromEvent(event.pageNumber, text, event.x!, event.y!, event.width ?? 180, event.fontSize ?? 16);
      return;
    }
    if (event.action === 'paste') {
      const text = event.text?.trim();
      if (!text || !Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
      // Paste is treated as text-create for history: Undo removes the pasted
      // item, Redo restores it — same as native Text-tool creation above.
      createTextAnnotationFromEvent(event.pageNumber, text, event.x!, event.y!, 180, 16);
      return;
    }
    const selected = current.find((annotation) => annotation.id === event.annotationId);
    if (!selected) return;
    if (event.action === 'delete') {
      setNativeHistory((h) => pushMaterialHistory(h, { kind: 'text-delete', pageNumber: event.pageNumber, annotation: selected }));
      saveTextAnnotations(event.pageNumber, current.filter((annotation) => annotation.id !== selected.id));
      setSelectedTextAnnotationId(undefined);
    } else if (event.action === 'edit') {
      // The native inline editor already collected the final text (even if
      // empty — an empty commit is the existing clear-to-delete path, same
      // rule the old Save-button modal used, just reached directly now).
      const text = (event.text ?? '').trim();
      if (text && text !== selected.text) {
        setNativeHistory((h) => pushMaterialHistory(h, {
          kind: 'text-edit', pageNumber: event.pageNumber, annotationId: selected.id, before: selected.text, after: text,
        }));
      } else if (!text) {
        setNativeHistory((h) => pushMaterialHistory(h, { kind: 'text-delete', pageNumber: event.pageNumber, annotation: selected }));
      }
      saveTextAnnotations(event.pageNumber, text
        ? current.map((annotation) => annotation.id === selected.id ? { ...annotation, text, updatedAt: new Date().toISOString() } : annotation)
        : current.filter((annotation) => annotation.id !== selected.id));
      if (text) ensureTrailingBlankPageAfterContent(event.pageNumber);
      if (!text) setSelectedTextAnnotationId(undefined);
    } else if (event.action === 'move' && Number.isFinite(event.x) && Number.isFinite(event.y)) {
      // Reached both by the existing long-press "Move" flow (a second
      // long-press elsewhere completes it) and by the finger-drag gesture
      // (native tracks the drag live, then emits this ONE mutation at drag
      // end) — one drag gesture = one history action either way.
      setNativeHistory((h) => pushMaterialHistory(h, {
        kind: 'text-move',
        pageNumber: event.pageNumber,
        annotationId: selected.id,
        before: { x: selected.x, y: selected.y },
        after: { x: event.x!, y: event.y! },
      }));
      saveTextAnnotations(event.pageNumber, current.map((annotation) => annotation.id === selected.id
        ? { ...annotation, x: event.x!, y: event.y!, updatedAt: new Date().toISOString() }
        : annotation));
    } else if (event.action === 'move') {
      Alert.alert('Move text', 'Long-press the new location on the page.');
    }
  }, [createTextAnnotationFromEvent, ensureTrailingBlankPageAfterContent, saveTextAnnotations, textAnnotationsForMaterialPage]);

  const handleNativeModeChange = useCallback((next: NativePdfAnnotationMode) => {
    nativeAnnotationModeRef.current = next;
    nativeTemporaryEraserRef.current = false;
    setNativeTemporaryEraser(false);

    if (next === 'pen' || next === 'highlighter') {
      nativePreviousDrawingToolRef.current = next;
    }

    setNativeAnnotationMode(next);
  }, []);

  // Colour selection from the toolbar strip — applies to whichever draw tool is
  // active. Native (PDFKit) and JS-overlay paths each have their own colour state;
  // the toolbar instance for each path calls its matching handler.
  const handleSelectNativeColor = useCallback((color: string) => {
    if (nativeAnnotationModeRef.current === 'highlighter') {
      setNativeHighlighterColor(color);
    } else {
      setNativePenColor(color);
    }
  }, []);

  const handleSelectColor = useCallback((color: string) => {
    if (annotationMode === 'highlighter') {
      setHighlighterColor(color);
    } else {
      setPenColor(color);
    }
  }, [annotationMode]);

  // Stroke-width selection — applies to the active draw tool. Width feeds the PDF
  // view as a prop and only affects future strokes (no coordinate/storage change).
  const handleSelectNativeWidth = useCallback((width: number) => {
    if (nativeAnnotationModeRef.current === 'highlighter') {
      setNativeHighlighterWidth(width);
    } else {
      setNativePenWidth(width);
    }
  }, []);

  const handleSelectWidth = useCallback((width: number) => {
    if (annotationMode === 'highlighter') {
      setHighlighterWidth(width);
    } else {
      setPenWidth(width);
    }
  }, [annotationMode]);

  // Eraser coverage — wired to the native eraserRadius prop (and the JS overlay).
  const handleSelectNativeEraserSize = useCallback((radius: number) => {
    setNativeEraserRadius(radius);
  }, []);
  const handleSelectEraserSize = useCallback((radius: number) => {
    setEraserRadius(radius);
  }, []);

  const restoreNativeTemporaryEraserIfNeeded = useCallback(() => {
    if (!nativeTemporaryEraserRef.current) return;
    const restored = nativePreviousDrawingToolRef.current ?? 'pen';
    nativeAnnotationModeRef.current = restored;
    nativeTemporaryEraserRef.current = false;
    setNativeTemporaryEraser(false);
    setNativeAnnotationMode(restored);
  }, []);

  // Batching boundary for one eraser gesture (drag). A single continuous
  // erase can cross multiple strokes, each firing its own "replacePage"
  // commit (see PdfAnnotationView's eraseStroke call sites) — those already
  // update the store live, unchanged, one at a time. This ref only captures
  // the page's stroke array as it stood BEFORE the first replacePage of the
  // in-progress gesture, so onEraserGestureEnded can push ONE stroke-erase
  // history action covering the whole gesture (before → after), matching
  // "one drag = one action" instead of one entry per stroke crossed.
  const eraseBatchBeforeRef = useRef<{ pageNumber: number; strokes: MaterialAnnotationStroke[] } | null>(null);

  const handleNativeAnnotationCommitted = useCallback(
    (event: NativePdfAnnotationsChangedEvent) => {
      const lid = nativeLectureIdRef.current;
      const mid = nativeMaterialIdRef.current;
      if (!lid || !mid) return;
      const page = Number.isFinite(event.pageNumber) ? event.pageNumber : nativeCurrentPageRef.current;
      if (!Number.isFinite(page) || page <= 0) return;
      debugMaterialViewport('native-annotation-commit-received', {
        action: event.action ?? 'add',
        page,
        nativePage: nativeCurrentPageRef.current,
        strokePoints: event.stroke?.points.length,
      });

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
        if (!eraseBatchBeforeRef.current || eraseBatchBeforeRef.current.pageNumber !== page) {
          eraseBatchBeforeRef.current = { pageNumber: page, strokes: annotationsForMaterialPage(mid, page) };
        }
        const nextStrokes = event.strokes.map(toStoreStroke);
        replaceMaterialPageAnnotationStrokesForMaterial(mid, page, nextStrokes, materialScopeLectureId(mid));
        debugMaterialViewport('native-annotation-store-update', { action: 'replacePage', page });
        return;
      }

      if (!event.stroke) return;
      const stroke: MaterialAnnotationStroke = {
        ...toStoreStroke(event.stroke),
      };
      // One drawn Pencil stroke = one history action.
      setNativeHistory((h) => pushMaterialHistory(h, { kind: 'stroke-add', pageNumber: page, stroke }));
      addAnnotationStroke(materialReviewMode ? materialScopeLectureId(mid) : lid, mid, page, stroke);
      debugMaterialViewport('native-annotation-store-update', { action: 'add', page, strokeId: stroke.id });
      ensureTrailingBlankPageAfterContent(page);
    },
    [addAnnotationStroke, annotationsForMaterialPage, ensureTrailingBlankPageAfterContent, materialReviewMode, replaceMaterialPageAnnotationStrokesForMaterial],
  );

  const handleNativeEraserGestureEnded = useCallback(() => {
    const mid = nativeMaterialIdRef.current;
    const before = eraseBatchBeforeRef.current;
    eraseBatchBeforeRef.current = null;
    if (mid && before) {
      const after = annotationsForMaterialPage(mid, before.pageNumber);
      const beforeIds = new Set(before.strokes.map((s) => s.id));
      const afterIds = new Set(after.map((s) => s.id));
      const changed = beforeIds.size !== afterIds.size || [...beforeIds].some((id) => !afterIds.has(id));
      if (changed) {
        setNativeHistory((h) => pushMaterialHistory(h, {
          kind: 'stroke-erase', pageNumber: before.pageNumber, before: before.strokes, after,
        }));
      }
    }
    restoreNativeTemporaryEraserIfNeeded();
  }, [annotationsForMaterialPage, restoreNativeTemporaryEraserIfNeeded]);

  const addPageStroke = useCallback(
    (stroke: MaterialAnnotationStroke) => {
      if (!lectureId || !material?.id) return;
      // A fresh user stroke invalidates the redo stack.
      setRedoStack([]);
      addAnnotationStroke(materialReviewMode ? materialScopeLectureId(material.id) : lectureId, material.id, currentPage, stroke);
      ensureTrailingBlankPageAfterContent(currentPage);
    },
    [addAnnotationStroke, currentPage, ensureTrailingBlankPageAfterContent, lectureId, material?.id, materialReviewMode],
  );

  const erasePageStrokeIds = useCallback(
    (ids: string[]) => {
      if (!lectureId || !material?.id || ids.length === 0) return;
      setRedoStack([]);
      const idSet = new Set(ids);
      const next = pageStrokes.filter((stroke) => !idSet.has(stroke.id));
      replaceMaterialPageAnnotationStrokesForMaterial(material.id, currentPage, next, materialScopeLectureId(material.id));
    },
    [currentPage, lectureId, material?.id, pageStrokes, replaceMaterialPageAnnotationStrokesForMaterial],
  );

  const undoCurrentPage = useCallback(() => {
    if (!lectureId || !material?.id || pageStrokes.length === 0) return;
    const removed = pageStrokes[pageStrokes.length - 1];
    const next = pageStrokes.slice(0, -1);
    replaceMaterialPageAnnotationStrokesForMaterial(material.id, currentPage, next, materialScopeLectureId(material.id));
    setRedoStack((stack) => [...stack, removed]);
  }, [currentPage, lectureId, material?.id, pageStrokes, replaceMaterialPageAnnotationStrokesForMaterial]);

  const redoCurrentPage = useCallback(() => {
    if (!lectureId || !material?.id || redoStack.length === 0) return;
    const restored = redoStack[redoStack.length - 1];
    setRedoStack((stack) => stack.slice(0, -1));
    addAnnotationStroke(
      materialReviewMode ? materialScopeLectureId(material.id) : lectureId,
      material.id,
      currentPage,
      restored,
    );
  }, [addAnnotationStroke, currentPage, lectureId, material?.id, materialReviewMode, redoStack]);

  // Applies one history step's result: strokes go through the stroke store,
  // text through the text store — never both for a single action, since
  // every MaterialHistoryAction touches exactly one of the two. Any stroke
  // ids this step just removed (undo of a stroke-add, or redo of a
  // stroke-erase) must reach native BEFORE the snapshot that omits them —
  // see markStrokeRemovalIntent's doc comment for the race this avoids.
  const applyNativeHistoryStep = useCallback(
    (action: MaterialHistoryAction, result: MaterialHistoryApplyResult) => {
      const mid = nativeMaterialIdRef.current;
      if (!mid) return;
      if (result.removedStrokeIds.length > 0) {
        pdfRef.current?.markStrokeRemovalIntent(result.removedStrokeIds);
      }
      if (action.kind === 'stroke-add' || action.kind === 'stroke-erase') {
        replaceMaterialPageAnnotationStrokesForMaterial(mid, action.pageNumber, result.strokes, materialScopeLectureId(mid));
        return;
      }
      saveTextAnnotations(action.pageNumber, result.textAnnotations);
      // A create/delete undo-or-redo that removes the currently-selected
      // annotation must not leave a selection pointing at nothing.
      const affectedId = action.kind === 'text-create' || action.kind === 'text-delete' ? action.annotation.id : action.annotationId;
      const stillPresent = result.textAnnotations.some((a) => a.id === affectedId);
      if (!stillPresent && selectedTextAnnotationId === affectedId) {
        setSelectedTextAnnotationId(undefined);
      }
    },
    [replaceMaterialPageAnnotationStrokesForMaterial, saveTextAnnotations, selectedTextAnnotationId],
  );

  const undoNativeCurrentPage = useCallback(() => {
    const mid = nativeMaterialIdRef.current;
    const page = nativeCurrentPageRef.current;
    if (!mid || !Number.isFinite(page) || page <= 0) return;
    const popped = popMaterialHistoryUndo(nativeHistory);
    if (!popped) return;
    const strokes = annotationsForMaterialPage(mid, popped.action.pageNumber);
    const texts = textAnnotationsForMaterialPage(mid, popped.action.pageNumber);
    const result = applyMaterialHistoryUndo(popped.action, strokes, texts);
    setNativeHistory(popped.state);
    applyNativeHistoryStep(popped.action, result);
  }, [annotationsForMaterialPage, applyNativeHistoryStep, nativeHistory, textAnnotationsForMaterialPage]);

  const redoNativeCurrentPage = useCallback(() => {
    const mid = nativeMaterialIdRef.current;
    const page = nativeCurrentPageRef.current;
    if (!mid || !Number.isFinite(page) || page <= 0) return;
    const popped = popMaterialHistoryRedo(nativeHistory);
    if (!popped) return;
    const strokes = annotationsForMaterialPage(mid, popped.action.pageNumber);
    const texts = textAnnotationsForMaterialPage(mid, popped.action.pageNumber);
    const result = applyMaterialHistoryRedo(popped.action, strokes, texts);
    setNativeHistory(popped.state);
    applyNativeHistoryStep(popped.action, result);
  }, [annotationsForMaterialPage, applyNativeHistoryStep, nativeHistory, textAnnotationsForMaterialPage]);

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
          <Text style={styles.emptyTitle}>{t('material.notFound')}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
            style={({ pressed }) => [styles.softButton, pressed && styles.pressed]}
          >
            <Text style={styles.softButtonLabel}>{t('material.goBack')}</Text>
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
          <Text style={styles.emptyTitle}>{t('material.viewerUnavailable')}</Text>
          <Text style={styles.emptyBody}>
            {t('material.rebuildXcode')}
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
          initialViewport={initialViewport}
          style={styles.pdfFill}
          annotationMode={nativeAnnotationMode}
          penColor={nativePenColor}
          penWidth={nativePenWidth}
          highlighterColor={nativeHighlighterColor}
          highlighterWidth={nativeHighlighterWidth}
          eraserRadius={nativeEraserRadius}
          annotationsByPage={nativeAnnotationsByPage}
          appendedBlankPageCount={appendedPageCount}
          textAnnotationsByPage={nativeTextAnnotationsByPage}
          selectedTextAnnotationId={selectedTextAnnotationId}
          onLoadComplete={(event) => handlePdfLoadComplete(event.totalPages, event.sourcePageCount)}
          onPageChanged={(event) => handlePdfPageChanged(event.pageNumber)}
          onViewportChanged={handleNativeViewportChanged}
          onViewportDiagnostic={handleNativeViewportDiagnostic}
          onError={(event) => handlePdfError(new Error(event.message))}
          onAnnotationsChanged={handleNativeAnnotationCommitted}
          onEraserGestureEnded={handleNativeEraserGestureEnded}
          onTextAnnotationAction={handleNativeTextAnnotationAction}
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
        </View>
      ) : null}

      {/* Loading + error sit ON TOP of the PDF, centered. */}
      {loadingPdf && !pdfError ? (
        <View style={styles.pdfLoading} pointerEvents="none">
          <ActivityIndicator color={colors.deepNavy} />
          <Text style={styles.pdfLoadingLabel}>{t('material.opening')}</Text>
        </View>
      ) : null}
      {pdfError ? (
        <View style={styles.pdfErrorBlock} pointerEvents="none">
          <Ionicons name="alert-circle-outline" size={28} color={colors.recordingRed} />
          <Text style={styles.emptyTitle}>{t('material.openFailed')}</Text>
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
              {localizeSystemDefaultTitle(t, material.title)}
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

        {useNativePdfViewer ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Export annotated PDF"
            disabled={exporting || sourcePageCount < 1}
            onPress={async () => {
              if (!material?.id || exporting) return;
              setExporting(true);
              try {
                const outputUri = await exportAnnotatedPdfAsync({
                  fileUri,
                  sourcePageCount,
                  appendedBlankPageCount: appendedPageCount,
                  annotationsByPage: nativeAnnotationsByPage,
                  textAnnotationsByPage: nativeTextAnnotationsByPage,
                });
                if (await Sharing.isAvailableAsync()) {
                  await Sharing.shareAsync(outputUri, { mimeType: 'application/pdf', dialogTitle: 'Export annotated PDF' });
                } else {
                  Alert.alert('Export ready', outputUri);
                }
              } catch (error) {
                console.warn('[material] annotated PDF export failed', error);
                Alert.alert('Export failed', 'The annotated PDF could not be created. Please try again.');
              } finally {
                setExporting(false);
              }
            }}
            style={({ pressed }) => [styles.exportButton, { top: insets.top + spacing.md, right: spacing.md }, (pressed || exporting) && styles.pressed]}
          >
            {exporting ? <ActivityIndicator size="small" color={colors.deepNavy} /> : <Ionicons name="share-outline" size={20} color={colors.deepNavy} />}
          </Pressable>
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
          captionsEnabled={classroomSessionActive}
        />

        <FloatingMiniCaption topOffset={insets.top + 80} enabled={classroomSessionActive} />
      </View>

      {/* Notebook-style draggable annotation toolbar — same board / drag / dock /
          minimize model as the Notebook toolbar, reduced to the Course Material
          tool set. Drives the native PDFKit overlay (or the JS fallback overlay)
          without touching PDF annotation storage. */}
      {useNativePdfViewer ? (
        <MaterialFloatingToolbar
          mode={nativeAnnotationMode}
          onChangeMode={handleNativeModeChange}
          showTextTool
          onUndo={undoNativeCurrentPage}
          canUndo={nativeHistory.undo.length > 0}
          onRedo={redoNativeCurrentPage}
          canRedo={nativeHistory.redo.length > 0}
          penColors={PEN_COLORS}
          penColor={nativePenColor}
          highlighterColors={HIGHLIGHTER_COLORS}
          highlighterColor={nativeHighlighterColor}
          onSelectColor={handleSelectNativeColor}
          penWidths={PEN_WIDTHS}
          penWidth={nativePenWidth}
          highlighterWidths={HIGHLIGHTER_WIDTHS}
          highlighterWidth={nativeHighlighterWidth}
          onSelectWidth={handleSelectNativeWidth}
          eraserSizes={ERASER_SIZES}
          eraserSize={nativeEraserRadius}
          onSelectEraserSize={handleSelectNativeEraserSize}
        />
      ) : Pdf ? (
        <MaterialFloatingToolbar
          mode={annotationMode}
          // showTextTool is omitted (default false) — the legacy JS-overlay
          // path has no text model, so the toolbar never offers Text here.
          // This adapter exists only so the shared prop type can stay the
          // wider MaterialToolMode without narrowing it for the native path;
          // 'text' can never actually reach setAnnotationMode at runtime.
          onChangeMode={(next) => { if (next !== 'text') setAnnotationMode(next); }}
          onUndo={undoCurrentPage}
          canUndo={pageStrokes.length > 0}
          onRedo={redoCurrentPage}
          canRedo={redoStack.length > 0}
          penColors={PEN_COLORS}
          penColor={penColor}
          highlighterColors={HIGHLIGHTER_COLORS}
          highlighterColor={highlighterColor}
          onSelectColor={handleSelectColor}
          penWidths={PEN_WIDTHS}
          penWidth={penWidth}
          highlighterWidths={HIGHLIGHTER_WIDTHS}
          highlighterWidth={highlighterWidth}
          onSelectWidth={handleSelectWidth}
          eraserSizes={ERASER_SIZES}
          eraserSize={eraserRadius}
          onSelectEraserSize={handleSelectEraserSize}
        />
      ) : null}

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
  const t = useT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('common.back')}
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
  const t = useT();
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

  // Same grey-capsule "current / total" style as the normal Notebook page
  // indicator (shared PageIndicatorBadge), wrapped in a Pressable so the
  // existing tap-to-jump-to-page behaviour is preserved.
  return (
    <Animated.View pointerEvents="box-none" style={[styles.pageNav, { bottom, opacity }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          showTotal
            ? t('material.pageOfA11y', { current: currentPage, total: totalPages })
            : t('material.pageA11y', { current: currentPage })
        }
        onPress={onTapCurrent}
        hitSlop={8}
        style={({ pressed }) => (pressed ? styles.pageNavPressed : null)}
      >
        <PageIndicatorBadge current={currentPage} total={showTotal ? totalPages : currentPage} />
      </Pressable>
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
  const t = useT();
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
    if (!trimmed) return { ok: false, reason: t('material.pageRequired') };
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
      return { ok: false, reason: t('material.wholePage') };
    }
    if (parsed < 1) return { ok: false, reason: t('material.pagesStartOne') };
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

  const helper = totalPages > 0 ? `1–${totalPages}` : t('material.enterPage');

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
          <Text style={modalStyles.title}>{t('material.goToPage')}</Text>
          <Text style={modalStyles.helper}>{helper}</Text>
          <TextInput
            ref={inputRef}
            style={modalStyles.input}
            value={value}
            onChangeText={handleChange}
            keyboardType="number-pad"
            placeholder={t('material.pageNumber')}
            placeholderTextColor={colors.textTertiary}
            autoFocus
            selectTextOnFocus
            returnKeyType="go"
            onSubmitEditing={handleGo}
            maxLength={6}
            accessibilityLabel={t('material.pageNumber')}
          />
          {error ? <Text style={modalStyles.error}>{error}</Text> : null}
          <View style={modalStyles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [modalStyles.cancelBtn, pressed && modalStyles.pressed]}
            >
              <Text style={modalStyles.cancelLabel}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={handleGo}
              style={({ pressed }) => [modalStyles.goBtn, pressed && modalStyles.pressed]}
            >
              <Text style={modalStyles.goLabel}>{t('material.go')}</Text>
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
  const t = useT();
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
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
  exportButton: {
    position: 'absolute', width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.94)', borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', zIndex: 12,
  },
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
  // Bottom-right position wrapper for the shared PageIndicatorBadge (the actual
  // grey "current / total" capsule, matching the normal Notebook indicator).
  // `bottom` is supplied inline so it respects safe-area insets and lifts over
  // the captions strip.
  pageNav: {
    position: 'absolute',
    right: 16,
    alignItems: 'flex-end',
  },
  pageNavPressed: { opacity: 0.7 },

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
    width: 32,
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
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
    width: 36,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
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
