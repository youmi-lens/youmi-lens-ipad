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
  type NativePdfPageChangedEvent,
} from '@/modules/expo-pdf-annotation';

const NativePdfViewComponent = ExpoPdfAnnotationView as React.ComponentType<
  React.ComponentProps<typeof ExpoPdfAnnotationView> & {
    ref?: React.Ref<ExpoPdfAnnotationNativeRef | null>;
  }
>;

export type NativePdfAnnotationViewRef = {
  setPage: (pageNumber: number) => void;
};

export type NativePdfAnnotationViewProps = {
  fileUri: string;
  initialPage?: number;
  style?: StyleProp<ViewStyle>;
  /** "scroll" lets PDFKit own all touches; "pen" turns the Apple-Pencil overlay on. */
  annotationMode?: NativePdfAnnotationMode;
  penColor?: string;
  penWidth?: number;
  highlighterColor?: string;
  highlighterWidth?: number;
  eraserRadius?: number;
  annotationsByPage?: NativePdfAnnotationsByPage;
  onPageChanged?: (event: NativePdfPageChangedEvent) => void;
  onLoadComplete?: (event: NativePdfLoadCompleteEvent) => void;
  onError?: (event: NativePdfErrorEvent) => void;
  onAnnotationsChanged?: (event: NativePdfAnnotationsChangedEvent) => void;
  onEraserGestureEnded?: (event: NativePdfEraserGestureEndedEvent) => void;
};

export const NATIVE_PDF_ANNOTATION_AVAILABLE = Platform.OS === 'ios';

export const NativePdfAnnotationView = forwardRef<NativePdfAnnotationViewRef, NativePdfAnnotationViewProps>(
  function NativePdfAnnotationView(
    {
      fileUri,
      initialPage = 1,
      style,
      annotationMode,
      penColor,
      penWidth,
      highlighterColor,
      highlighterWidth,
      eraserRadius,
      annotationsByPage,
      onPageChanged,
      onLoadComplete,
      onError,
      onAnnotationsChanged,
      onEraserGestureEnded,
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
    }), []);

    return (
      <NativePdfViewComponent
        ref={nativeRef}
        style={style}
        fileUri={fileUri}
        initialPage={initialPage}
        annotationMode={annotationMode}
        penColor={penColor}
        penWidth={penWidth}
        highlighterColor={highlighterColor}
        highlighterWidth={highlighterWidth}
        eraserRadius={eraserRadius}
        annotationsByPage={annotationsByPage}
        onPageChanged={(event) => onPageChanged?.(event.nativeEvent)}
        onLoadComplete={(event) => onLoadComplete?.(event.nativeEvent)}
        onError={(event) => onError?.(event.nativeEvent)}
        onAnnotationsChanged={(event) => onAnnotationsChanged?.(event.nativeEvent)}
        onEraserGestureEnded={(event) => onEraserGestureEnded?.(event.nativeEvent)}
      />
    );
  },
);
