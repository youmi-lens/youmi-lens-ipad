import { requireNativeViewManager } from 'expo-modules-core';

export type NativePdfPageChangedEvent = {
  pageNumber: number;
  totalPages: number;
};

export type NativePdfLoadCompleteEvent = {
  totalPages: number;
};

export type NativePdfErrorEvent = {
  message: string;
};

export type NativePdfEraserGestureEndedEvent = {
  pageNumber?: number;
};

/**
 * A stroke as it crosses the JS / native bridge.
 *
 * Points are flat [x, y] tuples in PDFKit page coordinates — see Swift's
 * AnnotationOverlay for how those are produced/consumed. JS converts to/from
 * the store's MaterialAnnotationStroke shape at the boundary.
 */
export type NativePdfAnnotationStroke = {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  opacity?: number;
  points: [number, number][];
  createdAt: string;
};

export type NativePdfAnnotationsChangedEvent = {
  pageNumber: number;
} & (
  | {
      action?: 'add';
      stroke: NativePdfAnnotationStroke;
      strokes?: never;
    }
  | {
      action: 'replacePage';
      strokes: NativePdfAnnotationStroke[];
      stroke?: never;
    }
);

export type NativePdfAnnotationsByPage = {
  /** Key is a stringified 1-based PDF page number. */
  [pageNumber: string]: NativePdfAnnotationStroke[];
};

export type NativePdfAnnotationMode = 'scroll' | 'pen' | 'highlighter' | 'eraser';

export type ExpoPdfAnnotationViewProps = {
  fileUri?: string;
  initialPage?: number;
  /** "scroll" (default) lets PDFKit own all touches; "pen" turns the overlay on. */
  annotationMode?: NativePdfAnnotationMode;
  /** Hex color for new pen strokes. */
  penColor?: string;
  /** Stroke width for new pen strokes, in PDF points. */
  penWidth?: number;
  /** Hex color for new highlighter strokes. */
  highlighterColor?: string;
  /** Stroke width for new highlighter strokes, in PDF points. */
  highlighterWidth?: number;
  /** Whole-stroke eraser radius, in screen points. */
  eraserRadius?: number;
  /** Strokes to render, in PDF page coordinates, keyed by 1-based page number. */
  annotationsByPage?: NativePdfAnnotationsByPage;
  onPageChanged?: (event: { nativeEvent: NativePdfPageChangedEvent }) => void;
  onLoadComplete?: (event: { nativeEvent: NativePdfLoadCompleteEvent }) => void;
  onError?: (event: { nativeEvent: NativePdfErrorEvent }) => void;
  onAnnotationsChanged?: (event: { nativeEvent: NativePdfAnnotationsChangedEvent }) => void;
  onEraserGestureEnded?: (event: { nativeEvent: NativePdfEraserGestureEndedEvent }) => void;
  style?: unknown;
};

export type ExpoPdfAnnotationNativeRef = {
  setPageAsync?: (pageNumber: number) => Promise<void>;
};

export const ExpoPdfAnnotationView = requireNativeViewManager<ExpoPdfAnnotationViewProps>(
  'ExpoPdfAnnotation',
);
