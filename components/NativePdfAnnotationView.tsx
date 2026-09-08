import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Platform, StyleProp, ViewStyle } from 'react-native';

import {
  ExpoPdfAnnotationView,
  type ExpoPdfAnnotationNativeRef,
  type NativePdfAnnotationMode,
  type NativePdfAnnotationsByPage,
  type NativePdfAnnotationsChangedEvent,
  type NativePdfEraserGestureEndedEvent,
  type NativePdfErrorEvent,
  type NativePdfLoadCompleteEvent,
  type NativePdfViewport,
  type NativePdfPageChangedEvent,
  type NativePdfTextAnnotationsByPage,
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
  flushViewport: () => void;
  /** Reads PDFKit's current page/zoom/page-space anchor without waiting for its normal debounce. */
  captureViewport: () => Promise<NativePdfViewport | null>;
};

export type NativePdfAnnotationViewProps = {
  fileUri: string;
  initialPage?: number;
  initialViewport?: NativePdfViewport;
  style?: StyleProp<ViewStyle>;
  /** "scroll" lets PDFKit own all touches; "pen" turns the Apple-Pencil overlay on. */
  annotationMode?: NativePdfAnnotationMode;
  penColor?: string;
  penWidth?: number;
  highlighterColor?: string;
  highlighterWidth?: number;
  eraserRadius?: number;
  annotationsByPage?: NativePdfAnnotationsByPage;
  appendedBlankPageCount?: number;
  textAnnotationsByPage?: NativePdfTextAnnotationsByPage;
  selectedTextAnnotationId?: string;
  onPageChanged?: (event: NativePdfPageChangedEvent) => void;
  onLoadComplete?: (event: NativePdfLoadCompleteEvent) => void;
  onViewportChanged?: (event: NativePdfViewport) => void;
  onError?: (event: NativePdfErrorEvent) => void;
  onAnnotationsChanged?: (event: NativePdfAnnotationsChangedEvent) => void;
  onEraserGestureEnded?: (event: NativePdfEraserGestureEndedEvent) => void;
  onTextAnnotationAction?: (event: NativePdfTextAnnotationActionEvent) => void;
  onViewportDiagnostic?: (event: NativePdfViewportDiagnosticEvent) => void;
};

export const NATIVE_PDF_ANNOTATION_AVAILABLE = Platform.OS === 'ios';

export const NativePdfAnnotationView = forwardRef<NativePdfAnnotationViewRef, NativePdfAnnotationViewProps>(
  function NativePdfAnnotationView(
    {
      fileUri,
      initialPage = 1,
      initialViewport,
      style,
      annotationMode,
      penColor,
      penWidth,
      highlighterColor,
      highlighterWidth,
      eraserRadius,
      annotationsByPage,
      appendedBlankPageCount,
      textAnnotationsByPage,
      selectedTextAnnotationId,
      onPageChanged,
      onLoadComplete,
      onViewportChanged,
      onError,
      onAnnotationsChanged,
      onEraserGestureEnded,
      onTextAnnotationAction,
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
      flushViewport() {
        nativeRef.current?.flushViewportAsync?.().catch((error) => {
          if (__DEV__) console.warn('[native-pdf] flushViewportAsync failed', error);
        });
      },
      captureViewport() {
        return nativeRef.current?.captureViewportAsync?.() ?? Promise.resolve(null);
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
        penColor={penColor}
        penWidth={penWidth}
        highlighterColor={highlighterColor}
        highlighterWidth={highlighterWidth}
        eraserRadius={eraserRadius}
        annotationsByPage={annotationsByPage}
        appendedBlankPageCount={appendedBlankPageCount}
        textAnnotationsByPage={textAnnotationsByPage}
        selectedTextAnnotationId={selectedTextAnnotationId}
        onPageChanged={(event) => onPageChanged?.(event.nativeEvent)}
        onLoadComplete={(event) => onLoadComplete?.(event.nativeEvent)}
        onViewportChanged={(event) => onViewportChanged?.(event.nativeEvent)}
        onError={(event) => onError?.(event.nativeEvent)}
        onAnnotationsChanged={(event) => onAnnotationsChanged?.(event.nativeEvent)}
        onEraserGestureEnded={(event) => onEraserGestureEnded?.(event.nativeEvent)}
        onTextAnnotationAction={(event) => onTextAnnotationAction?.(event.nativeEvent)}
        onViewportDiagnostic={(event) => onViewportDiagnostic?.(event.nativeEvent)}
      />
    );
  },
);
