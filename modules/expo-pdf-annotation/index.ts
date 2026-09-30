import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import type { AnnotationShape } from '../../lib/annotationShape';

export type NativePdfPageChangedEvent = {
  pageNumber: number;
  totalPages: number;
};

export type NativePdfLoadCompleteEvent = {
  totalPages: number;
  sourcePageCount: number;
};

export type NativePdfViewport = { version: 1; pageIndex: number; scaleFactor: number; anchorX: number; anchorY: number };

export type NativePdfErrorEvent = {
  message: string;
};

/** DEBUG-only native PDFKit event sequencing for device forensic captures. */
export type NativePdfViewportDiagnosticEvent = {
  sequence: number;
  event: string;
  reason: string;
  currentPage?: number;
  visiblePage?: number;
  offsetX?: number;
  offsetY?: number;
  scaleFactor: number;
  pageCount: number;
  annotationCount: number;
  pencilActive: boolean;
  strokeJustEnded: boolean;
  mode: string;
  restoring: boolean;
  restorationComplete: boolean;
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
  /** Structured shape (PDF-page coordinates); `points` are derived from it. Absent on ordinary ink. */
  shape?: AnnotationShape;
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

export type NativePdfTextAnnotation = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  /** Absent on legacy bottom-anchored annotations; no coordinate migration. */
  anchor?: 'top-left';
  createdAt: string;
  updatedAt: string;
};

export type NativePdfTextAnnotationsByPage = { [pageNumber: string]: NativePdfTextAnnotation[] };

export type NativePdfTextAnnotationActionEvent = {
  /**
   * Text create/edit are both native-driven: a `UITextView` overlay
   * anchored directly on the PDF page (no JS modal) collects the typing,
   * and JS only ever hears about it once committed —
   * 'create' fires with the FINAL typed text (+ position/width/fontSize)
   * already attached, only when non-empty; an empty commit creates nothing.
   * 'edit' fires with the FINAL typed text for an existing annotationId,
   * even when empty — JS's existing clear-to-delete rule decides from
   * there, exactly as it did for the old Save-button modal.
   */
  action: 'create' | 'edit' | 'delete';
  pageNumber: number;
  annotationId?: string;
  text?: string;
  x?: number;
  y?: number;
  /** Populated on 'create', in PDF-page points. */
  width?: number;
  fontSize?: number;
  anchor?: 'top-left';
};

export type NativePdfAnnotationMode = 'scroll' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'select';
export type NativePdfSelectionShape = 'rect' | 'lasso';
export type NativePdfSelectionChangedEvent = {
  pageNumber: number;
  strokeIds: string[];
};
/** Draw-and-hold reached with an eligible stroke (page-space points). Answer with `applyShapeSnap(token, points)`. */
export type NativePdfShapeHoldEvent = {
  token: number;
  pageNumber: number;
  points: [number, number][];
  scale: number;
};
/** Apple Pencil touched down (`active: true`) or lifted/cancelled (`active: false`) with an ink tool. */
export type NativePdfPencilActivityEvent = { active: boolean };
/** One completed Pencil drag of the selected ink; dx/dy are PDF page-space units. */
export type NativePdfSelectionMovedEvent = {
  pageNumber: number;
  strokeIds: string[];
  dx: number;
  dy: number;
  /**
   * Present ONLY when the release landed on a different PDF page: the destination page and the exact
   * source-page -> destination-page affine [a, b, c, d, tx, ty] (CGAffineTransform order) native applied.
   */
  toPageNumber?: number;
  transform?: number[];
};

/**
 * One completed Pencil drag of a structured-shape handle. `x`/`y` is the final target of the
 * handle in PDF page space (grab offset already applied); JS applies the shared
 * `dragShapeHandle` semantics, regenerates points and records ONE history action.
 */
export type NativePdfShapeEditedEvent = {
  pageNumber: number;
  strokeId: string;
  handleIndex: number;
  x: number;
  y: number;
};

/** One completed two-finger pinch of the selected ink; `factor` scales about (centerX, centerY), PDF page space. */
export type NativePdfSelectionScaledEvent = {
  pageNumber: number;
  strokeIds: string[];
  factor: number;
  centerX: number;
  centerY: number;
};

export type ExpoPdfAnnotationViewProps = {
  fileUri?: string;
  initialPage?: number;
  initialViewport?: NativePdfViewport;
  /** "scroll" (default) lets PDFKit own all touches; "pen" turns the overlay on. */
  annotationMode?: NativePdfAnnotationMode;
  selectionShape?: NativePdfSelectionShape;
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
  /** Synthetic, Youmi-owned pages after the immutable source document. */
  appendedBlankPageCount?: number;
  textAnnotationsByPage?: NativePdfTextAnnotationsByPage;
  onPageChanged?: (event: { nativeEvent: NativePdfPageChangedEvent }) => void;
  onLoadComplete?: (event: { nativeEvent: NativePdfLoadCompleteEvent }) => void;
  onViewportChanged?: (event: { nativeEvent: NativePdfViewport }) => void;
  onError?: (event: { nativeEvent: NativePdfErrorEvent }) => void;
  onAnnotationsChanged?: (event: { nativeEvent: NativePdfAnnotationsChangedEvent }) => void;
  onEraserGestureEnded?: (event: { nativeEvent: NativePdfEraserGestureEndedEvent }) => void;
  onTextAnnotationAction?: (event: { nativeEvent: NativePdfTextAnnotationActionEvent }) => void;
  onSelectionChanged?: (event: { nativeEvent: NativePdfSelectionChangedEvent }) => void;
  onSelectionMoved?: (event: { nativeEvent: NativePdfSelectionMovedEvent }) => void;
  onShapeEdited?: (event: { nativeEvent: NativePdfShapeEditedEvent }) => void;
  onSelectionScaled?: (event: { nativeEvent: NativePdfSelectionScaledEvent }) => void;
  onPencilActivity?: (event: { nativeEvent: NativePdfPencilActivityEvent }) => void;
  onShapeHold?: (event: { nativeEvent: NativePdfShapeHoldEvent }) => void;
  shapeSnapEnabled?: boolean;
  shapeSnapHoldMs?: number;
  shapeSnapTolerancePt?: number;
  onViewportDiagnostic?: (event: { nativeEvent: NativePdfViewportDiagnosticEvent }) => void;
  style?: unknown;
};

export type ExpoPdfAnnotationNativeRef = {
  setPageAsync?: (pageNumber: number) => Promise<void>;
  setAnnotationModeAsync?: (mode: NativePdfAnnotationMode) => Promise<void>;
  flushViewportAsync?: () => Promise<void>;
  captureViewportAsync?: () => Promise<NativePdfViewport | null>;
  markStrokeRemovalIntentAsync?: (ids: string[]) => Promise<void>;
  markStrokeRestorationIntentAsync?: (ids: string[]) => Promise<void>;
  setTextHistoryIntentAsync?: (pageNumber: number, annotations: NativePdfTextAnnotation[]) => Promise<void>;
  clearSelectionAsync?: () => Promise<void>;
  setSelectionAsync?: (pageNumber: number, ids: string[]) => Promise<void>;
  applyShapeSnapAsync?: (token: number, points: [number, number][], shape?: AnnotationShape) => Promise<void>;
};

export const ExpoPdfAnnotationView = requireNativeViewManager<ExpoPdfAnnotationViewProps>(
  'ExpoPdfAnnotation',
);

type ExpoPdfAnnotationModule = {
  exportAnnotatedPdfAsync: (options: {
    fileUri: string;
    sourcePageCount: number;
    appendedBlankPageCount: number;
    annotationsByPage: NativePdfAnnotationsByPage;
    textAnnotationsByPage: NativePdfTextAnnotationsByPage;
  }) => Promise<string>;
};

const nativeModule = requireNativeModule<ExpoPdfAnnotationModule>('ExpoPdfAnnotation');

export function exportAnnotatedPdfAsync(options: Parameters<ExpoPdfAnnotationModule['exportAnnotatedPdfAsync']>[0]) {
  return nativeModule.exportAnnotatedPdfAsync(options);
}
