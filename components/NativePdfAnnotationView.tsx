import { forwardRef, memo, useImperativeHandle, useRef } from 'react';
import { Platform, StyleProp, ViewStyle } from 'react-native';
import type { AnnotationShape } from '@/lib/annotationShape';

import {
  ExpoPdfAnnotationView,
  type ExpoPdfAnnotationNativeRef,
  type NativePdfAnnotationMode,
  type NativePdfSelectionShape,
  type NativePdfSelectionChangedEvent,
  type NativePdfSelectionMovedEvent,
  type NativePdfShapeEditedEvent,
  type NativePdfSelectionScaledEvent,
  type NativePdfPencilActivityEvent,
  type NativePdfShapeHoldEvent,
  type NativePdfAnnotationsByPage,
  type NativePdfAnnotationsChangedEvent,
  type NativePdfEraserGestureEndedEvent,
  type NativePdfErrorEvent,
  type NativePdfLoadCompleteEvent,
  type NativePdfViewport,
  type NativePdfPageChangedEvent,
  type NativePdfTextAnnotationsByPage,
  type NativePdfTextAnnotation,
  type NativePdfTextAnnotationActionEvent,
  type NativePdfViewportDiagnosticEvent,
} from '@/modules/expo-pdf-annotation';

const NativePdfViewComponent = ExpoPdfAnnotationView as React.ComponentType<
  React.ComponentProps<typeof ExpoPdfAnnotationView> & {
    ref?: React.Ref<ExpoPdfAnnotationNativeRef | null>;
  }
>;

export type NativePdfAnnotationViewRef = {
  setPage: (pageNumber: number) => void;
  /** Changes the active tool without reconciling the annotation-data props. */
  setAnnotationMode: (mode: NativePdfAnnotationMode) => void;
  flushViewport: () => void;
  /** Reads PDFKit's current page/zoom/page-space anchor without waiting for its normal debounce. */
  captureViewport: () => Promise<NativePdfViewport | null>;
  /**
   * Tell the native view these stroke ids are being intentionally removed
   * by JS (Undo, or a Redo-of-a-delete) — must be called BEFORE sending the
   * `annotationsByPage` snapshot that excludes them, so the native
   * stale-snapshot protection (`pendingLocalStrokeIds`) doesn't silently
   * re-draw a stroke the user just asked to remove. See
   * AnnotationOverlay.markStrokeRemovalIntent's doc comment for the full
   * race this closes.
   */
  markStrokeRemovalIntent: (ids: string[]) => void;
  /** Allow an intentional Undo to restore ink previously removed natively. */
  markStrokeRestorationIntent: (ids: string[]) => void;
  /** Explicit Undo/Redo overrides a pending native text-render commit. */
  setTextHistoryIntent: (pageNumber: number, annotations: NativePdfTextAnnotation[]) => void;
  clearSelection: () => void;
  /** Selects existing ink by id (e.g. the copies produced by Duplicate). */
  setSelection: (pageNumber: number, ids: string[]) => void;
  /** Shape Snap: replace the live stroke (identified by the hold event's token) with clean geometry. */
  applyShapeSnap: (token: number, points: [number, number][], shape?: AnnotationShape) => void;
};

export type NativePdfAnnotationViewProps = {
  fileUri: string;
  initialPage?: number;
  initialViewport?: NativePdfViewport;
  style?: StyleProp<ViewStyle>;
  /** "scroll" lets PDFKit own all touches; "pen" turns the Apple-Pencil overlay on. */
  annotationMode?: NativePdfAnnotationMode;
  selectionShape?: NativePdfSelectionShape;
  penColor?: string;
  penWidth?: number;
  highlighterColor?: string;
  highlighterWidth?: number;
  eraserRadius?: number;
  annotationsByPage?: NativePdfAnnotationsByPage;
  appendedBlankPageCount?: number;
  textAnnotationsByPage?: NativePdfTextAnnotationsByPage;
  onPageChanged?: (event: NativePdfPageChangedEvent) => void;
  onLoadComplete?: (event: NativePdfLoadCompleteEvent) => void;
  onViewportChanged?: (event: NativePdfViewport) => void;
  onError?: (event: NativePdfErrorEvent) => void;
  onAnnotationsChanged?: (event: NativePdfAnnotationsChangedEvent) => void;
  onEraserGestureEnded?: (event: NativePdfEraserGestureEndedEvent) => void;
  onTextAnnotationAction?: (event: NativePdfTextAnnotationActionEvent) => void;
  onSelectionChanged?: (event: NativePdfSelectionChangedEvent) => void;
  onSelectionMoved?: (event: NativePdfSelectionMovedEvent) => void;
  onShapeEdited?: (event: NativePdfShapeEditedEvent) => void;
  onSelectionScaled?: (event: NativePdfSelectionScaledEvent) => void;
  onPencilActivity?: (event: NativePdfPencilActivityEvent) => void;
  onShapeHold?: (event: NativePdfShapeHoldEvent) => void;
  shapeSnapEnabled?: boolean;
  shapeSnapHoldMs?: number;
  shapeSnapTolerancePt?: number;
  onViewportDiagnostic?: (event: NativePdfViewportDiagnosticEvent) => void;
};

export const NATIVE_PDF_ANNOTATION_AVAILABLE = Platform.OS === 'ios';

export const NativePdfAnnotationView = memo(forwardRef<NativePdfAnnotationViewRef, NativePdfAnnotationViewProps>(
  function NativePdfAnnotationView(
    {
      fileUri,
      initialPage = 1,
      initialViewport,
      style,
      annotationMode,
      selectionShape,
      penColor,
      penWidth,
      highlighterColor,
      highlighterWidth,
      eraserRadius,
      annotationsByPage,
      appendedBlankPageCount,
      textAnnotationsByPage,
      onPageChanged,
      onLoadComplete,
      onViewportChanged,
      onError,
      onAnnotationsChanged,
      onEraserGestureEnded,
      onTextAnnotationAction,
      onSelectionChanged,
      onSelectionMoved,
      onShapeEdited,
      onSelectionScaled,
      onPencilActivity,
      onShapeHold,
      shapeSnapEnabled,
      shapeSnapHoldMs,
      shapeSnapTolerancePt,
      onViewportDiagnostic,
    },
    ref,
  ) {
    const nativeRef = useRef<ExpoPdfAnnotationNativeRef | null>(null);

    useImperativeHandle(ref, () => ({
      setPage(pageNumber: number) {
        nativeRef.current?.setPageAsync?.(pageNumber).catch((error) => {
          if (__DEV__) console.warn('[native-pdf] setPageAsync failed', error);
        });
      },
      setAnnotationMode(mode: NativePdfAnnotationMode) {
        nativeRef.current?.setAnnotationModeAsync?.(mode).catch((error: unknown) => {
          if (__DEV__) console.warn('[native-pdf] setAnnotationModeAsync failed', error);
        });
      },
      flushViewport() {
        nativeRef.current?.flushViewportAsync?.().catch((error) => {
          if (__DEV__) console.warn('[native-pdf] flushViewportAsync failed', error);
        });
      },
      captureViewport() {
        return nativeRef.current?.captureViewportAsync?.() ?? Promise.resolve(null);
      },
      markStrokeRemovalIntent(ids: string[]) {
        nativeRef.current?.markStrokeRemovalIntentAsync?.(ids).catch((error: unknown) => {
          if (__DEV__) console.warn('[native-pdf] markStrokeRemovalIntentAsync failed', error);
        });
      },
      markStrokeRestorationIntent(ids: string[]) {
        nativeRef.current?.markStrokeRestorationIntentAsync?.(ids).catch((error: unknown) => {
          if (__DEV__) console.warn('[native-pdf] markStrokeRestorationIntentAsync failed', error);
        });
      },
      setTextHistoryIntent(pageNumber: number, annotations: NativePdfTextAnnotation[]) {
        nativeRef.current?.setTextHistoryIntentAsync?.(pageNumber, annotations).catch((error: unknown) => {
          if (__DEV__) console.warn('[native-pdf] setTextHistoryIntentAsync failed', error);
        });
      },
      clearSelection() {
        nativeRef.current?.clearSelectionAsync?.().catch((error: unknown) => {
          if (__DEV__) console.warn('[native-pdf] clearSelectionAsync failed', error);
        });
      },
      applyShapeSnap(token, points, shape) {
        nativeRef.current?.applyShapeSnapAsync?.(token, points, shape).catch((error: unknown) => {
          if (__DEV__) console.warn('[native-pdf] applyShapeSnapAsync failed', error);
        });
      },
      setSelection(pageNumber, ids) {
        nativeRef.current?.setSelectionAsync?.(pageNumber, ids).catch((error: unknown) => {
          if (__DEV__) console.warn('[native-pdf] setSelectionAsync failed', error);
        });
      },
    }), []);

    return (
      <NativePdfViewComponent
        ref={nativeRef}
        style={style}
        fileUri={fileUri}
        initialPage={initialPage}
        initialViewport={initialViewport}
        annotationMode={annotationMode}
        selectionShape={selectionShape}
        penColor={penColor}
        penWidth={penWidth}
        highlighterColor={highlighterColor}
        highlighterWidth={highlighterWidth}
        eraserRadius={eraserRadius}
        annotationsByPage={annotationsByPage}
        appendedBlankPageCount={appendedBlankPageCount}
        textAnnotationsByPage={textAnnotationsByPage}
        onPageChanged={(event) => onPageChanged?.(event.nativeEvent)}
        onLoadComplete={(event) => onLoadComplete?.(event.nativeEvent)}
        onViewportChanged={(event) => onViewportChanged?.(event.nativeEvent)}
        onError={(event) => onError?.(event.nativeEvent)}
        onAnnotationsChanged={(event) => onAnnotationsChanged?.(event.nativeEvent)}
        onEraserGestureEnded={(event) => onEraserGestureEnded?.(event.nativeEvent)}
        onTextAnnotationAction={(event) => onTextAnnotationAction?.(event.nativeEvent)}
        onSelectionChanged={(event) => onSelectionChanged?.(event.nativeEvent)}
        onSelectionMoved={(event) => onSelectionMoved?.(event.nativeEvent)}
        onShapeEdited={(event) => onShapeEdited?.(event.nativeEvent)}
        onSelectionScaled={(event) => onSelectionScaled?.(event.nativeEvent)}
        onPencilActivity={(event) => onPencilActivity?.(event.nativeEvent)}
        onShapeHold={(event) => onShapeHold?.(event.nativeEvent)}
        shapeSnapEnabled={shapeSnapEnabled}
        shapeSnapHoldMs={shapeSnapHoldMs}
        shapeSnapTolerancePt={shapeSnapTolerancePt}
        onViewportDiagnostic={(event) => onViewportDiagnostic?.(event.nativeEvent)}
      />
    );
  },
));
