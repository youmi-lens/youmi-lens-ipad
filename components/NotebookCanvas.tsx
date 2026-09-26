/**
 * NotebookCanvas — a Notability-style handwritten + typed notes page.
 *
 * Interaction model (iPad):
 *  - Apple Pencil / stylus draws (or erases) on the page.
 *  - A finger drag scrolls the long page.
 *  - Apple Pencil double-tap toggles Write <-> Eraser, when the optional native
 *    module is present (see lib/pencilInteraction.ts — unavailable in Expo Go).
 *
 * Pointer type comes from react-native-gesture-handler, which can report
 * `PointerType.STYLUS` for an Apple Pencil and `PointerType.TOUCH` for a
 * finger. A manual-activation Pan gesture activates only for confirmed stylus
 * input; every non-stylus pointer fails immediately so the underlying
 * ScrollView can handle it.
 *
 * That means finger drawing is intentionally disabled in Write / Erase mode.
 * On iPad, preserving the Pencil-write / finger-scroll split is the more
 * important product behavior, and Scroll remains only a manual fallback.
 *
 * Intentionally NOT a full Notability clone: no layers, lasso, shape tools,
 * OCR or PDF. The eraser removes whole touched strokes (V1).
 */
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from 'react';
import {
  Alert,
  Animated,
  Easing,
  Image as RNImage,
  LayoutAnimation,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  PointerType,
  ScrollView as GestureScrollView,
} from 'react-native-gesture-handler';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';
import Reanimated, { runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { strokeBounds, strokeNearSweep, sweepMayReachBounds } from '@/lib/inkEraser.mjs';
import type { NoteImage, NotePoint, NoteStroke } from '@/lib/models';
import { useT } from '@/lib/i18n';
import { PressableScale } from '@/components/PressableScale';
import { persistNotebookImage } from '@/lib/notebookImageStorage';
import { shouldStartToolbarTransition } from '@/lib/notebookToolbarTransition.mjs';
import {
  appendStrokePoint,
  NOTEBOOK_MIN_POINT_DISTANCE,
  strokeToPath,
} from '@/lib/notebookStroke';
import {
  NOTEBOOK_DEFAULT_SCALE,
  NOTEBOOK_PALM_GRACE_MS,
  applyPinchZoomFromStart,
  screenToCanvasPoint,
  shouldLockNotebookScroll,
} from '@/lib/notebookViewport';
import {
  addPencilDoubleTapListener,
  isPencilDoubleTapAvailable,
} from '@/lib/pencilInteraction';

/** Re-export for callers/tests that historically imported path helpers from this module. */
export { strokeToPath } from '@/lib/notebookStroke';

const PEN_COLORS: { key: string; value: string }[] = [
  { key: 'Charcoal', value: '#222630' },
  { key: 'Blue', value: '#2D6BD4' },
  { key: 'Red', value: '#E23B47' },
  { key: 'Orange', value: '#F08A1E' },
  { key: 'Purple', value: '#9B30C9' },
  { key: 'White', value: '#FFFFFF' },
  { key: 'Teal', value: '#1FB58E' },
];

// ---- Unified navy toolbar tokens — match the Live Caption overlay ----
// Toolbar surface gradient (design: linear-gradient(180deg, #1E2E50, #16233F)).
const TOOLBAR_NAVY_TOP = '#1E2E50';
const TOOLBAR_NAVY_BOTTOM = '#16233F';
const TOOLBAR_BORDER_COLOR = 'rgba(255,255,255,0.07)';
const TOOLBAR_SELECTED = '#5F86E8';
const TOOLBAR_ICON_IDLE = 'rgba(255,255,255,0.62)';
const TOOLBAR_ICON_DISABLED = 'rgba(255,255,255,0.26)';
const TOOLBAR_DELETE_RED = '#FF8A8A';
const TOOLBAR_DIVIDER_COLOR = 'rgba(255,255,255,0.11)';
const TOOLBAR_SHELL_RADIUS = 22;
const TOOLBAR_MINIMIZED_RADIUS = 16;
const TOOLBAR_CHIP_RADIUS = 11;

const PEN_WIDTHS: { key: string; value: number; dot: number }[] = [
  { key: 'Thin', value: 2, dot: 7 },
  { key: 'Medium', value: 3.5, dot: 11 },
  { key: 'Thick', value: 6, dot: 16 },
];

const HIGHLIGHTER_COLORS: { key: string; value: string }[] = [
  { key: 'Yellow', value: 'rgba(245,210,70,0.9)' },
  { key: 'Green', value: 'rgba(120,215,140,0.85)' },
  { key: 'Pink', value: 'rgba(245,150,190,0.85)' },
  { key: 'Blue', value: 'rgba(120,180,245,0.85)' },
];

const HIGHLIGHTER_WIDTHS: { key: string; value: number; dot: number }[] = [
  { key: 'Narrow', value: 12, dot: 8 },
  { key: 'Medium', value: 18, dot: 12 },
  { key: 'Wide', value: 26, dot: 17 },
];

type EraserSizeKey = 'small' | 'medium' | 'large';
type SelectionShape = 'rect' | 'lasso';

const ERASER_SIZES: { key: EraserSizeKey; label: string; radius: number }[] = [
  { key: 'small', label: 'Small', radius: 12 },
  { key: 'medium', label: 'Medium', radius: 26 },
  { key: 'large', label: 'Large', radius: 44 },
];

const LINE_GAP = 34;
const MARGIN_X = 56;
const MIN_POINT_DISTANCE = NOTEBOOK_MIN_POINT_DISTANCE;
/**
 * Page-based paper. The notebook is a vertical stack of A4-like sheets in one
 * continuous coordinate space: a stroke/image at canvas-y N belongs to the sheet
 * whose band contains N. Sheet height = sheet width × PAGE_ASPECT, with a small
 * gap between sheets so it reads as stacked paper rather than one endless canvas.
 * Total pages = (sheets that contain content) + 1 trailing blank sheet, so a new
 * blank page appears automatically the moment the user writes on the last one.
 * PAGE_HEIGHT remains the pre-layout fallback (before the container is measured).
 */
const PAGE_ASPECT = 1.414; // height / width ≈ A4
const PAGE_GAP = 22; // gap shown between stacked sheets
const PAGE_HEIGHT = 3200;
/** How long the Pen / Eraser badge stays on screen after a double-tap. */
const TOOL_TOAST_MS = 1100;
const TOOLBAR_STORAGE_KEY = 'youmi.notebookToolbar.v1';
const TOOLBAR_EDGE_MARGIN = 12;
const TOOLBAR_COLLISION_GAP = 14;
const NARROW_TOOLBAR_WIDTH = 720;
// Minimized tag — design `.tbmin`: grip + 46pt current-tool + 38pt expand chevron.
const TOOLBAR_COLLAPSED_WIDTH = 126;
const TOOLBAR_COLLAPSED_HEIGHT = 60;
const TOOLBAR_PRIMARY_HEIGHT = 52;
const TOOLBAR_CONTEXT_HEIGHT = 44;
const TOOLBAR_ANIMATION_MS = 190;
const TOOLBAR_EASING = Easing.bezier(0.4, 0, 0.2, 1);
const TOOLBAR_WIDTHS = {
  drawing: 536,
  erase: 536,
  compact: 536,
} as const;
const TOOLBAR_ICON_HIT_SLOP = { top: 5, right: 5, bottom: 5, left: 5 };
const TOOLBAR_DRAG_THRESHOLD = 8;
// Edge-intent activation zones for drag-release snapping. A release whose finger
// lands within the left/right band of the usable width is treated as explicit
// intent to dock to that side edge (vertical layout), winning over top/bottom
// corner anchors. Generous so the user never has to hit a tiny target.
const TOOLBAR_SIDE_EDGE_ZONE_RATIO = 0.28; // rightmost / leftmost 28% of width
const TOOLBAR_SIDE_EDGE_ZONE_MIN = 300; // ...but at least 300pt
const TOOLBAR_VERT_EDGE_ZONE_RATIO = 0.2; // top / bottom 20% of height
const TOOLBAR_VERT_EDGE_ZONE_MIN = 150; // ...but at least 150pt
const TOOLBAR_VERTICAL_RAIL_WIDTH = 60;
const TOOLBAR_VERTICAL_CONTEXT_WIDTH = 360;
const TOOLBAR_VERTICAL_ACTION_WIDTH = 60;
const TOOLBAR_VERTICAL_BUTTON_GAP = 2;
// Undo/Redo now live in a fixed top-right control (not the draggable toolbar),
// so the action pill holds only the context-aware Trash (1 × 44 + padding) and
// the selection pill holds Duplicate + Delete (2 × 44 + gap + padding).
const TOOLBAR_HISTORY_PILL_WIDTH = 64;
const TOOLBAR_SELECTION_PILL_WIDTH = 106;
const TOOLBAR_RIGHT_PILL_GAP = 12;

// ---- Side-docked vertical toolbar (Concept C: stable rail + detached inward cards) ----
// A purpose-built side layout — NOT a rotated/transposed horizontal toolbar. The primary
// rail never resizes; the context card, history mini-rail and selection cluster are their
// own detached navy surfaces. These values feed both the render and the snap footprint.
// One unified rounded capsule = [primary tool column | divider | narrow context column].
// History and selection actions live in their own separate small capsules nearby.
const TOOLBAR_VERTICAL_TOOL_COL_WIDTH = 52;
const TOOLBAR_VERTICAL_CONTEXT_NARROW = 56; // Pen / Highlight / Eraser (swatch + nib columns)
const TOOLBAR_VERTICAL_CONTEXT_WIDE = 76; // Text / Select / Insert (compact labelled controls)
const TOOLBAR_VERTICAL_COL_DIVIDER = 1;
const TOOLBAR_VERTICAL_CAPSULE_HEIGHT = 400;
const TOOLBAR_VERTICAL_GROUP_GAP = 12;
const TOOLBAR_VERTICAL_ACTION_HEIGHT = 60; // action capsule: Trash only (Undo/Redo moved to fixed top-right)
const TOOLBAR_MINI_CAPSULE_WIDTH = 56;
const TOOLBAR_MINI_CAPSULE_HEIGHT = 132;
const IMAGE_MIN_EDGE = 56;
const IMAGE_MAX_EDGE = 1200;
const IMAGE_VISIBLE_EDGE = 36;
/** Small movement threshold so a selected image starts dragging quickly (not the larger toolbar threshold). */
const IMAGE_DRAG_MIN_DISTANCE = 3;
/** Tap tolerance for selecting an image without it being read as a drag. */
const IMAGE_TAP_MAX_DISTANCE = 12;
/** Forgiving touch padding around the image frame so taps/drags need not be pixel-perfect. */
const IMAGE_HIT_SLOP = 6;
/** Half-extent of a corner handle's touch target (so the hit area is ~36pt though the dot is ~8pt). */
const IMAGE_CORNER_HANDLE_HALF = 18;
const IMAGE_ACTION_BAR_WIDTH = 104;
const IMAGE_ACTION_BAR_HEIGHT = 44;
const IMAGE_ACTION_BAR_GAP = 10;
const IMAGE_ACTION_BAR_EDGE = 8;

/** One reversible snapshot of all editable notebook content for undo/redo. */
type NotebookSnapshot = { strokes: NoteStroke[]; images: NoteImage[]; text: string };
/** Max in-memory history depth (per session) to bound memory. */
const HISTORY_MAX = 60;
const TEXT_HISTORY_DEBOUNCE_MS = 900;
const AnimatedNotebookScrollView = Reanimated.createAnimatedComponent(GestureScrollView);

export type CanvasMode = 'write' | 'highlight' | 'type' | 'erase' | 'scroll' | 'select' | 'insert';

const NOOP_IMAGES_CHANGE = (_imgs: NoteImage[]) => {};
type DrawingMode = 'write' | 'highlight';
export type NotebookToolbarDock =
  | 'topLeft'
  | 'topCenter'
  | 'topRight'
  | 'leftCenter'
  | 'rightCenter'
  | 'bottomLeft'
  | 'bottomCenter'
  | 'bottomRight';
export type NotebookOverlayRect = { x: number; y: number; width: number; height: number };

type ToolbarPreferences = {
  collapsed: boolean;
  /** Snapped edge region. The toolbar always rests in one of these after a drag. */
  dock: NotebookToolbarDock;
  mode: CanvasMode;
  eraserSize: EraserSizeKey;
};

const DEFAULT_TOOLBAR_PREFERENCES: ToolbarPreferences = {
  collapsed: false,
  dock: 'topCenter',
  mode: 'write',
  eraserSize: 'medium',
};

const TOOLBAR_DOCKS: NotebookToolbarDock[] = [
  'topLeft',
  'topCenter',
  'topRight',
  'leftCenter',
  'rightCenter',
  'bottomLeft',
  'bottomCenter',
  'bottomRight',
];

/** Primary row tools, left to right. Hand (scroll) and Minimize are rendered separately after the divider. */
const PRIMARY_TOOLS: { key: CanvasMode; label: string }[] = [
  { key: 'write', label: 'Write' },
  { key: 'highlight', label: 'Highlight' },
  { key: 'type', label: 'Text' },
  { key: 'select', label: 'Select' },
  { key: 'insert', label: 'Insert' },
  { key: 'erase', label: 'Erase' },
];
/** All valid saved-preference modes. */
const DRAW_MODES = PRIMARY_TOOLS;

function makeStrokeId(): string {
  return `stroke_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function makeImageId(): string {
  return `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Used only for the single image being actively transformed (gesture-start baseline) — not the undo/redo path. */
function cloneImage(image: NoteImage): NoteImage {
  return { ...image };
}

/**
 * Undo/redo snapshots do NOT deep-clone stroke/image data. Every commit path
 * (commitStroke, commitErase, commitMove, image transforms) already replaces
 * arrays/objects wholesale via spread/map/filter and never mutates an existing
 * NoteStroke's `points` (or a NoteImage) in place, so a shallow array copy is
 * enough to isolate a snapshot from later mutation. A prior version deep-cloned
 * every point of every stroke on every commit (recordHistory before each
 * commitStroke/commitErase/commitMove) — O(total points so far) per stroke,
 * i.e. quadratic over a session — which was the dominant cause of handwriting
 * commits getting progressively slower, then freezing, in Notes-heavy classes.
 */
function cloneSnapshot(snapshot: NotebookSnapshot): NotebookSnapshot {
  return {
    strokes: snapshot.strokes.slice(),
    images: snapshot.images.slice(),
    text: snapshot.text,
  };
}

/** Ray-casting point-in-polygon test for the lasso selection. */
function pointInPolygon(point: NotePoint, polygon: NotePoint[]): boolean {
  const { x, y } = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function rectFromPoints(a: NotePoint, b: NotePoint): NotebookOverlayRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function pointInRect(point: NotePoint, rect: NotebookOverlayRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function imageRect(image: NoteImage): NotebookOverlayRect {
  return { x: image.x, y: image.y, width: image.width, height: image.height };
}

function clampImageGeometry(image: NoteImage, canvasWidth: number, canvasHeight: number = PAGE_HEIGHT): NoteImage {
  const safeCanvasWidth = Math.max(canvasWidth, IMAGE_VISIBLE_EDGE * 2);
  const minX = -image.width + IMAGE_VISIBLE_EDGE;
  const maxX = safeCanvasWidth - IMAGE_VISIBLE_EDGE;
  const minY = -image.height + IMAGE_VISIBLE_EDGE;
  const maxY = Math.max(canvasHeight, PAGE_HEIGHT) - IMAGE_VISIBLE_EDGE;
  return {
    ...image,
    x: clamp(image.x, minX, maxX),
    y: clamp(image.y, minY, maxY),
  };
}

function resizeImageAroundCenter(image: NoteImage, scale: number, canvasWidth: number, canvasHeight: number = PAGE_HEIGHT): NoteImage {
  const aspect = image.height / Math.max(image.width, 1);
  const maxEdge = Math.max(
    IMAGE_MIN_EDGE,
    Math.min(IMAGE_MAX_EDGE, Math.max(canvasWidth * 1.5, IMAGE_MIN_EDGE * 2)),
  );
  const minScale = IMAGE_MIN_EDGE / Math.max(Math.min(image.width, image.height), 1);
  const maxScale = maxEdge / Math.max(image.width, image.height, 1);
  const nextScale = clamp(scale, minScale, maxScale);
  const nextWidth = image.width * nextScale;
  const nextHeight = nextWidth * aspect;
  const centerX = image.x + image.width / 2;
  const centerY = image.y + image.height / 2;
  return clampImageGeometry(
    {
      ...image,
      x: centerX - nextWidth / 2,
      y: centerY - nextHeight / 2,
      width: nextWidth,
      height: nextHeight,
    },
    canvasWidth,
    canvasHeight,
  );
}

type ImageCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

/**
 * Resize an image by dragging one corner, keeping the OPPOSITE corner pinned and
 * preserving aspect ratio. `dx`/`dy` are the cumulative drag of the grabbed corner
 * from the gesture start. The drag is projected onto the image's diagonal so the
 * grabbed corner follows the finger as closely as possible while aspect locks, and
 * the same min/max edge limits as the pinch path apply.
 */
function resizeImageFromCorner(
  image: NoteImage,
  corner: ImageCorner,
  dx: number,
  dy: number,
  canvasWidth: number,
  canvasHeight: number = PAGE_HEIGHT,
): NoteImage {
  const w = Math.max(image.width, 1);
  const h = Math.max(image.height, 1);
  // Outward direction of the grabbed corner from the image centre.
  const sx = corner === 'topRight' || corner === 'bottomRight' ? 1 : -1;
  const sy = corner === 'bottomLeft' || corner === 'bottomRight' ? 1 : -1;
  const diagLen = Math.hypot(w, h);
  // Unit vector along the anchor -> grabbed-corner diagonal; project the drag onto it.
  const ux = (sx * w) / diagLen;
  const uy = (sy * h) / diagLen;
  const projected = dx * ux + dy * uy; // positive = grow, negative = shrink

  const maxEdge = Math.max(
    IMAGE_MIN_EDGE,
    Math.min(IMAGE_MAX_EDGE, Math.max(canvasWidth * 1.5, IMAGE_MIN_EDGE * 2)),
  );
  const minScale = IMAGE_MIN_EDGE / Math.max(Math.min(w, h), 1);
  const maxScale = maxEdge / Math.max(w, h, 1);
  const scale = clamp((diagLen + projected) / diagLen, minScale, maxScale);
  const nextWidth = w * scale;
  const nextHeight = h * scale;

  // Pin the opposite corner: edges that are NOT being dragged keep their position.
  const nextX = sx > 0 ? image.x : image.x + w - nextWidth;
  const nextY = sy > 0 ? image.y : image.y + h - nextHeight;

  return clampImageGeometry(
    { ...image, x: nextX, y: nextY, width: nextWidth, height: nextHeight },
    canvasWidth,
    canvasHeight,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toolbarDockPoint(
  dock: NotebookToolbarDock,
  container: { width: number; height: number },
  toolbar: { width: number; height: number },
) {
  const left = TOOLBAR_EDGE_MARGIN;
  const right = Math.max(left, container.width - toolbar.width - TOOLBAR_EDGE_MARGIN);
  const top = TOOLBAR_EDGE_MARGIN;
  const bottom = Math.max(top, container.height - toolbar.height - TOOLBAR_EDGE_MARGIN);
  const centerX = clamp((container.width - toolbar.width) / 2, left, right);
  const centerY = clamp(
    (container.height - toolbar.height) / 2,
    top,
    bottom,
  );

  switch (dock) {
    case 'topLeft':
      return { x: left, y: top };
    case 'topRight':
      return { x: right, y: top };
    case 'leftCenter':
      return { x: left, y: centerY };
    case 'rightCenter':
      return { x: right, y: centerY };
    case 'bottomLeft':
      return { x: left, y: bottom };
    case 'bottomCenter':
      return { x: centerX, y: bottom };
    case 'bottomRight':
      return { x: right, y: bottom };
    default:
      return { x: centerX, y: top };
  }
}

function toolbarDockIsVertical(dock: NotebookToolbarDock): boolean {
  return dock === 'leftCenter' || dock === 'rightCenter';
}

function rectsOverlap(a: NotebookOverlayRect, b: NotebookOverlayRect, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

function toolbarRect(
  point: { x: number; y: number },
  size: { width: number; height: number },
): NotebookOverlayRect {
  return { ...point, ...size };
}

/**
 * One rendered stroke. A single-point stroke (a tap) is drawn as a small dot,
 * a multi-point stroke as a smooth path. Each stroke is its own SVG node with
 * its own points, so distinct strokes can never visually connect.
 *
 * Memoized so completed strokes do not rebuild SVG path strings when only the
 * active stroke's points change.
 */
const StrokeShape = memo(function StrokeShape({
  stroke,
}: {
  stroke: { points: NotePoint[]; color: string; width: number; tool?: 'pen' | 'highlighter'; opacity?: number };
}) {
  const { points, color, width } = stroke;
  const opacity = stroke.opacity ?? (stroke.tool === 'highlighter' ? 0.34 : 1);
  if (points.length === 0) return null;
  if (points.length === 1) {
    return (
      <Circle cx={points[0].x} cy={points[0].y} r={Math.max(width / 2, 1.6)} fill={color} opacity={opacity} />
    );
  }
  return (
    <Path
      d={strokeToPath(points)}
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={opacity}
      fill="none"
    />
  );
});

type ActiveInkHandle = {
  begin: (point: NotePoint) => void;
  append: (point: NotePoint) => void;
  clear: () => void;
  getPoints: () => NotePoint[];
};

type ActiveInkHostProps = {
  canvasHeight: number;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  opacity: number;
};

/**
 * Live ink only. Owns its own React state so each Pencil sample updates this
 * overlay without re-rendering the parent canvas, toolbar, or completed strokes.
 *
 * Points still accumulate in a ref for O(1) append + synchronous commit reads,
 * but the RENDERED snapshot is always a fresh `livePoints` state array. A bare
 * `revision` counter + reading `pointsRef.current` during render is unsafe under
 * React Compiler (the counter can be treated as unused), which made strokes
 * invisible until Pencil-up committed them into the completed layer.
 */
const ActiveInkHost = memo(
  forwardRef<ActiveInkHandle, ActiveInkHostProps>(function ActiveInkHost(
    { canvasHeight, tool, color, width, opacity },
    ref,
  ) {
    const pointsRef = useRef<NotePoint[]>([]);
    const [livePoints, setLivePoints] = useState<NotePoint[]>([]);

    useImperativeHandle(
      ref,
      () => ({
        begin(point: NotePoint) {
          pointsRef.current = [point];
          setLivePoints([point]);
        },
        append(point: NotePoint) {
          if (!appendStrokePoint(pointsRef.current, point, MIN_POINT_DISTANCE)) return;
          // Slice so React sees a new points array and StrokeShape rebuilds the path.
          setLivePoints(pointsRef.current.slice());
        },
        clear() {
          if (pointsRef.current.length === 0) return;
          pointsRef.current = [];
          setLivePoints([]);
        },
        getPoints() {
          return pointsRef.current;
        },
      }),
      [],
    );

    if (livePoints.length === 0) {
      return <View style={StyleSheet.absoluteFill} pointerEvents="none" />;
    }

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height={canvasHeight}>
          <StrokeShape
            stroke={{ points: livePoints, tool, color, width, opacity }}
          />
        </Svg>
      </View>
    );
  }),
);

type CompletedStrokeLayerProps = {
  canvasHeight: number;
  unselectedShapes: ReactNode;
  selectedShapes: ReactNode;
  selectionMoveOffset: NotePoint;
  erasePoint: NotePoint | null;
  eraserRadius: number;
  showEraseCursor: boolean;
  lassoPoints: NotePoint[];
  showLasso: boolean;
  selectionRect: NotebookOverlayRect | null;
  showSelectionRect: boolean;
  selectionBounds: { x: number; y: number; w: number; h: number } | null;
  showSelectionBounds: boolean;
};

/** Stable SVG layer for committed ink + selection chrome (not live pen samples). */
const CompletedStrokeLayer = memo(function CompletedStrokeLayer({
  canvasHeight,
  unselectedShapes,
  selectedShapes,
  selectionMoveOffset,
  erasePoint,
  eraserRadius,
  showEraseCursor,
  lassoPoints,
  showLasso,
  selectionRect,
  showSelectionRect,
  selectionBounds,
  showSelectionBounds,
}: CompletedStrokeLayerProps) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width="100%" height={canvasHeight}>
        {unselectedShapes}
        <G translateX={selectionMoveOffset.x} translateY={selectionMoveOffset.y}>
          {selectedShapes}
        </G>
        {showEraseCursor && erasePoint ? (
          <>
            <Circle
              cx={erasePoint.x}
              cy={erasePoint.y}
              r={eraserRadius}
              stroke="rgba(6, 27, 52, 0.88)"
              strokeWidth={2}
              fill="rgba(120, 214, 255, 0.22)"
            />
            <Circle
              cx={erasePoint.x}
              cy={erasePoint.y}
              r={2.4}
              fill="rgba(6, 27, 52, 0.88)"
            />
          </>
        ) : null}
        {showLasso && lassoPoints.length > 1 ? (
          <Path
            d={`M ${lassoPoints.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`}
            stroke="#5F86E8"
            strokeWidth={1.6}
            strokeDasharray="5 3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="rgba(95,134,232,0.08)"
          />
        ) : null}
        {showSelectionRect && selectionRect ? (
          <Rect
            x={selectionRect.x}
            y={selectionRect.y}
            width={selectionRect.width}
            height={selectionRect.height}
            rx={3}
            stroke="#5F86E8"
            strokeWidth={1.6}
            strokeDasharray="6 4"
            fill="rgba(95,134,232,0.08)"
          />
        ) : null}
        {showSelectionBounds && selectionBounds ? (
          <Path
            d={`M ${selectionBounds.x + selectionMoveOffset.x} ${selectionBounds.y + selectionMoveOffset.y} h ${selectionBounds.w} v ${selectionBounds.h} h ${-selectionBounds.w} Z`}
            stroke="#5F86E8"
            strokeWidth={1.5}
            strokeDasharray="6 3"
            strokeLinecap="round"
            fill="rgba(95,134,232,0.06)"
          />
        ) : null}
      </Svg>
    </View>
  );
});

type ToolbarGlyphName =
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'type'
  | 'undo'
  | 'redo'
  | 'more'
  | 'hand'
  | 'chevronRight'
  | 'chevronLeft'
  | 'chevronUp'
  | 'chevronDown'
  | 'select'
  | 'insert'
  | 'duplicate'
  | 'trash';

/**
 * Toolbar icon glyphs. SVG paths are ported verbatim from the approved design
 * (`youmi-notebook-combined.html`, viewBox 0 0 28 28) so the shapes match the
 * Chrome reference exactly. `size` follows the design: 25 for primary tools,
 * 23 for the icon buttons (Hand/Minimize/right pill), 24 for the minimized tag.
 */
function ToolbarGlyphBase({
  name,
  color = colors.textOnNavyMuted,
  size = 23,
}: {
  name: ToolbarGlyphName;
  color?: string;
  size?: number;
}) {
  const outline = {
    stroke: color,
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 28 28" accessibilityElementsHidden>
      {name === 'pen' ? (
        <>
          <Path d="M5 23l1.4-4.6L19 5.8a2.3 2.3 0 0 1 3.3 3.3L9.6 21.6 5 23Z" {...outline} />
          <Path d="M16.6 8.2l3.2 3.2" stroke={color} strokeWidth={1.9} fill="none" />
          <Path d="M5 23l1.4-4.6 3.2 3.2L5 23Z" fill={color} />
        </>
      ) : null}
      {name === 'highlighter' ? (
        <>
          <Path d="M6 20l-1.2 3.4 3.4-1.2L20 9.4l-2.2-2.2L6 20Z" {...outline} />
          <Path d="M17.8 7.2l2.2 2.2 2.2-2.2a1.55 1.55 0 0 0 0-2.2a1.55 1.55 0 0 0-2.2 0L17.8 7.2Z" fill={color} />
          <Path d="M5 24h6.5" stroke={color} strokeWidth={2} strokeLinecap="round" fill="none" />
        </>
      ) : null}
      {name === 'eraser' ? (
        <>
          <Path d="M9 22h12" stroke={color} strokeWidth={1.9} strokeLinecap="round" fill="none" />
          <Path d="M6.2 18.4l-1.6-1.6a2.2 2.2 0 0 1 0-3.1l7.6-7.6a2.2 2.2 0 0 1 3.1 0l4.4 4.4a2.2 2.2 0 0 1 0 3.1L15 20.4H8.6L6.2 18.4Z" {...outline} />
          <Path d="M10 9.6l5.6 5.6" stroke={color} strokeWidth={1.9} fill="none" />
        </>
      ) : null}
      {name === 'type' ? (
        <>
          <Path d="M6 8h11M6 8V6.5M17 8V6.5M11.5 8v14M9 22h5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d="M17 12h6M20 12v10M18.5 22h3" stroke={color} strokeWidth={1.7} strokeLinecap="round" fill="none" />
        </>
      ) : null}
      {name === 'undo' ? (
        <>
          <Path d="M10 8L6 12l4 4" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d="M6 12h10.5a5.5 5.5 0 0 1 5.5 5.5v1" stroke={color} strokeWidth={1.9} strokeLinecap="round" fill="none" />
        </>
      ) : null}
      {name === 'redo' ? (
        <>
          <Path d="M18 8l4 4-4 4" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d="M22 12H11.5A5.5 5.5 0 0 0 6 17.5v1" stroke={color} strokeWidth={1.9} strokeLinecap="round" fill="none" />
        </>
      ) : null}
      {name === 'more' ? (
        <Path
          d="M7 9h14M11 9V7.5a1.2 1.2 0 0 1 1.2-1.2h3.6a1.2 1.2 0 0 1 1.2 1.2V9M9 9v12.5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9"
          {...outline}
        />
      ) : null}
      {name === 'hand' ? (
        <Path
          d="M11 13V7.5a1.7 1.7 0 0 1 3.4 0V13m0-1.5a1.7 1.7 0 0 1 3.4 0V14m0-1a1.7 1.7 0 0 1 3.3 0v4.5c0 3.3-2.4 5.8-6 5.8-2.4 0-4-1-5.4-2.8l-3-4a1.7 1.7 0 0 1 2.5-2.2L11 17V13Z"
          stroke={color}
          strokeWidth={1.7}
          strokeLinejoin="round"
          fill="none"
        />
      ) : null}
      {name === 'chevronRight' ? (
        <Path d="M11 7l6 7-6 7" stroke={color} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ) : null}
      {name === 'chevronLeft' ? (
        <Path d="M17 7l-6 7 6 7" stroke={color} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ) : null}
      {name === 'chevronUp' ? (
        <Path d="M7 17.5l7-7 7 7" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ) : null}
      {name === 'chevronDown' ? (
        <Path d="M7 10.5l7 7 7-7" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ) : null}
      {name === 'select' ? (
        <Ellipse cx="14" cy="14" rx="9" ry="8" stroke={color} strokeWidth={1.9} strokeDasharray="3.2 3.4" fill="none" />
      ) : null}
      {name === 'insert' ? (
        <>
          <Circle cx="14" cy="14" r="9.5" stroke={color} strokeWidth={1.9} fill="none" />
          <Path d="M14 9.5v9M9.5 14h9" stroke={color} strokeWidth={1.9} strokeLinecap="round" fill="none" />
        </>
      ) : null}
      {name === 'duplicate' ? (
        <>
          <Rect x="9" y="9" width="13" height="13" rx="2.4" stroke={color} strokeWidth={1.8} fill="none" />
          <Path d="M6 17V7.5A1.5 1.5 0 0 1 7.5 6H17" stroke={color} strokeWidth={1.8} strokeLinecap="round" fill="none" />
        </>
      ) : null}
      {name === 'trash' ? (
        <Path
          d="M7 9h14M11 9V7.5a1.2 1.2 0 0 1 1.2-1.2h3.6a1.2 1.2 0 0 1 1.2 1.2V9M9 9v12.5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9"
          {...outline}
        />
      ) : null}
    </Svg>
  );
}

/**
 * Vertical navy gradient fill (#1E2E50 → #16233F) that matches the design's
 * `linear-gradient(180deg, …)` toolbar surface. Rendered as an absolute-fill
 * layer inside an `overflow: hidden`, rounded container so it clips correctly.
 * Uses react-native-svg (already a dependency) — no native gradient module.
 */
function NavySurfaceBase({ width, height }: { width?: number; height?: number }) {
  const gradientId = useId().replace(/:/g, '_');
  const surfaceWidth = width ?? '100%';
  const surfaceHeight = height ?? '100%';
  return (
    <View style={styles.navySurfaceLayer} pointerEvents="none">
      <Svg width={surfaceWidth} height={surfaceHeight} style={StyleSheet.absoluteFillObject}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={TOOLBAR_NAVY_TOP} />
            <Stop offset="1" stopColor={TOOLBAR_NAVY_BOTTOM} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={surfaceWidth} height={surfaceHeight} fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  );
}

/** Drag-handle grip — design `.grip`: two columns of three 3pt dots. */
function GripDotsBase() {
  return (
    <View style={styles.gripDots}>
      <View style={styles.gripCol}>
        <View style={styles.gripDot} />
        <View style={styles.gripDot} />
        <View style={styles.gripDot} />
      </View>
      <View style={styles.gripCol}>
        <View style={styles.gripDot} />
        <View style={styles.gripDot} />
        <View style={styles.gripDot} />
      </View>
    </View>
  );
}

function SelectionShapeIconBase({
  shape,
  color = TOOLBAR_ICON_IDLE,
}: {
  shape: SelectionShape;
  color?: string;
}) {
  if (shape === 'rect') {
    return (
      <Svg width={25} height={25} viewBox="0 0 28 28">
        <Rect
          x="6"
          y="7"
          width="16"
          height="14"
          rx="2.5"
          stroke={color}
          strokeWidth={1.9}
          strokeDasharray="3 3"
          fill="none"
        />
        <Path d="M9 7H6v3M19 7h3v3M6 18v3h3M22 18v3h-3" stroke={color} strokeWidth={1.9} strokeLinecap="round" fill="none" />
      </Svg>
    );
  }

  return (
    <Svg width={25} height={25} viewBox="0 0 28 28">
      <Path
        d="M7.6 14.8c-2.1-4.2 2.3-8 7.1-7.3 5.7.8 8.1 5.2 5.8 9.3-2.1 3.8-7.7 5.3-11.5 2.8-1.7-1.1-2.5-2.6-1.4-4.8Z"
        stroke={color}
        strokeWidth={1.9}
        strokeDasharray="3.2 3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M8.7 19.3l-2.1 3.2" stroke={color} strokeWidth={1.7} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

type NotebookImageObjectProps = {
  image: NoteImage;
  selected: boolean;
  moveOffset: NotePoint;
  onSelect: (id: string) => void;
  /** Cumulative pan translation + cumulative pinch scale for this interaction, relative to its start. */
  onTransform: (id: string, translationX: number, translationY: number, scale: number) => void;
  /** Cumulative drag of a grabbed corner handle from this interaction's start. */
  onCornerResize: (id: string, corner: ImageCorner, translationX: number, translationY: number) => void;
  onGestureStart: (id: string) => void;
  onGestureEnd: () => void;
};

const IMAGE_CORNERS: ImageCorner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

/**
 * Direct image manipulation. Built on react-native-gesture-handler (not
 * PanResponder, which could not reliably recognise a two-finger pinch in the
 * Simulator):
 *   - Tap         -> select
 *   - Pan on body -> one-finger move (small 3pt threshold; centroid pan ignored while pinching)
 *   - Pan on a selected-image corner handle -> resize from that corner (opposite corner pinned)
 *   - Pinch       -> resize around centre, aspect preserved, min/max clamped
 * A single Pan distinguishes corner-resize vs body-move by where it started, so it
 * never fights the body drag and needs no extra gesture/arbitration. Pan + Pinch are
 * Simultaneous; their cumulative values are pushed together to the parent, which
 * composes them from a single baseline. Exactly one undo snapshot per interaction.
 */
function NotebookImageObjectBase({
  image,
  selected,
  moveOffset,
  onSelect,
  onTransform,
  onCornerResize,
  onGestureStart,
  onGestureEnd,
}: NotebookImageObjectProps) {
  const activeRef = useRef(0);
  const panTranslationRef = useRef({ x: 0, y: 0 });
  const pinchScaleRef = useRef(1);
  const panStartedRef = useRef(false);
  const pinchStartedRef = useRef(false);
  const startedCornersRef = useRef(new Set<ImageCorner>());
  // Live values read by the gestures. The gesture objects are built ONCE (empty deps)
  // and read everything through refs, so a re-render mid-drag (the image geometry or
  // scroll-lock state changing) never rebuilds them.
  const imageIdRef = useRef(image.id);
  imageIdRef.current = image.id;
  const handlersRef = useRef({ onSelect, onTransform, onCornerResize, onGestureStart, onGestureEnd });
  handlersRef.current = { onSelect, onTransform, onCornerResize, onGestureStart, onGestureEnd };

  // Image gestures must decide stylus eligibility on RNGH's UI thread, because
  // GestureStateManager.fail() is synchronous-only. The image edit callbacks
  // deliberately remain on JS (they update React state), reached explicitly
  // through runOnJS after that early decision.
  const resetImageGesture = useCallback(() => {
    panTranslationRef.current = { x: 0, y: 0 };
    pinchScaleRef.current = 1;
  }, []);
  const beginImageGesture = useCallback(() => {
    if (activeRef.current === 0) {
      resetImageGesture();
      handlersRef.current.onGestureStart(imageIdRef.current);
    }
    activeRef.current += 1;
  }, [resetImageGesture]);
  const settleImageGesture = useCallback(() => {
    activeRef.current = Math.max(0, activeRef.current - 1);
    if (activeRef.current === 0) {
      handlersRef.current.onGestureEnd();
      resetImageGesture();
    }
  }, [resetImageGesture]);
  const pushImageTransform = useCallback(() => {
    handlersRef.current.onTransform(
      imageIdRef.current,
      panTranslationRef.current.x,
      panTranslationRef.current.y,
      pinchScaleRef.current,
    );
  }, []);
  const selectImageFromGesture = useCallback(() => {
    handlersRef.current.onSelect(imageIdRef.current);
  }, []);
  const beginPanFromGesture = useCallback(() => {
    panStartedRef.current = true;
    if (__DEV__) console.info('[NotebookImageAction] image-pan-activated', { imageId: imageIdRef.current });
    beginImageGesture();
  }, [beginImageGesture]);
  const updatePanFromGesture = useCallback((translationX: number, translationY: number, numberOfPointers: number) => {
    if (numberOfPointers > 1) return;
    panTranslationRef.current = { x: translationX, y: translationY };
    pushImageTransform();
  }, [pushImageTransform]);
  const finishPanFromGesture = useCallback(() => {
    if (!panStartedRef.current) return;
    panStartedRef.current = false;
    settleImageGesture();
  }, [settleImageGesture]);
  const beginPinchFromGesture = useCallback(() => {
    pinchStartedRef.current = true;
    beginImageGesture();
  }, [beginImageGesture]);
  const updatePinchFromGesture = useCallback((scale: number) => {
    pinchScaleRef.current = scale;
    pushImageTransform();
  }, [pushImageTransform]);
  const finishPinchFromGesture = useCallback(() => {
    if (!pinchStartedRef.current) return;
    pinchStartedRef.current = false;
    settleImageGesture();
  }, [settleImageGesture]);
  const beginCornerFromGesture = useCallback((corner: ImageCorner) => {
    startedCornersRef.current.add(corner);
    if (__DEV__) console.info('[NotebookImageAction] image-corner-activated', { corner, imageId: imageIdRef.current });
    handlersRef.current.onGestureStart(imageIdRef.current);
  }, []);
  const updateCornerFromGesture = useCallback((corner: ImageCorner, translationX: number, translationY: number) => {
    handlersRef.current.onCornerResize(imageIdRef.current, corner, translationX, translationY);
  }, []);
  const finishCornerFromGesture = useCallback((corner: ImageCorner) => {
    if (!startedCornersRef.current.delete(corner)) return;
    handlersRef.current.onGestureEnd();
  }, []);
  const traceImageGestureTouch = useCallback((source: string, pointerType: PointerType, rejected: boolean) => {
    if (__DEV__) {
      console.info('[NotebookImageAction] image-gesture-touches-down', {
        source,
        imageId: imageIdRef.current,
        pointerType,
        rejected,
      });
    }
  }, []);

  // body gesture (tap = select, pan = move, pinch = resize) + one Pan per corner handle.
  // The corner handles are separate fixed-size views (below), so resizing the image never
  // changes the view a corner gesture is attached to — the drag is never cancelled and so
  // never restarts as a stray move. Each corner is hardcoded, so there is no misclassification.
  const { bodyGesture, cornerGestures } = useMemo(() => {
    // Apple Pencil must draw ink through an image, never select/move/resize
    // it — the paper model is image-below, ink-above, but finger owns image
    // manipulation and Pencil owns the ink canvas regardless of z-order.
    // onTouchesDown fires (and can fail the gesture) for ANY gesture type,
    // not only manual-activation ones, so this works on tap/pan the same as
    // drawGesture's own manual check below.
    //
    // Pencil-starts-inside-image investigation: this is now the single
    // source of truth for "did this image's own gesture even SEE the
    // touch-down, and what did it decide" — logged for every touch-down
    // (not just stylus rejections), tagged by which of tap/pan/corner
    // observed it, so a physical capture can directly answer whether the
    // image-side gestures are correctly rejecting the stylus (in which case
    // the missing continuous ink must be a drawGesture-side/native
    // touch-ownership issue) or not rejecting it at all.
    const makeFailIfStylus = (source: string) => (event: { pointerType: PointerType }, manager: { fail: () => void }) => {
      'worklet';
      const isStylus = event.pointerType === PointerType.STYLUS;
      runOnJS(traceImageGestureTouch)(source, event.pointerType, isStylus);
      if (isStylus) manager.fail();
    };

    const tap = Gesture.Tap()
      .maxDuration(260)
      .maxDistance(IMAGE_TAP_MAX_DISTANCE)
      .hitSlop(IMAGE_HIT_SLOP)
      .onTouchesDown(makeFailIfStylus('tap'))
      .onEnd(() => {
        'worklet';
        runOnJS(selectImageFromGesture)();
      });

    // A corner drag is a single, self-contained gesture (one finger, one handle),
    // so it opens/commits the interaction DIRECTLY rather than through the shared
    // active-count used by the simultaneous body-pan + pinch. This guarantees one
    // onGestureStart and one onGestureEnd — i.e. exactly one undo entry per drag.
    //
    // A manualActivation attempt (explicit distance-based manager.activate()
    // instead of the built-in .minDistance() auto-activation) was tried here
    // to close a suspected native-thread activation race, and reverted: it
    // physically broke normal finger dragging without fixing the Pencil-
    // starts-inside-image case it targeted — proof the real mechanism is
    // something else (under investigation; see drawGesture's touch-on-image
    // trace). Back to plain auto-activation, exactly as it worked before
    // that attempt, plus the onTouchesDown-based stylus rejection.
    const makeCornerGesture = (corner: ImageCorner) => {
      return Gesture.Pan()
        .minDistance(IMAGE_DRAG_MIN_DISTANCE)
        .onTouchesDown(makeFailIfStylus(`corner-${corner}`))
        .onStart(() => {
          'worklet';
          runOnJS(beginCornerFromGesture)(corner);
        })
        .onUpdate((event) => {
          'worklet';
          runOnJS(updateCornerFromGesture)(corner, event.translationX, event.translationY);
        })
        .onFinalize(() => {
          'worklet';
          runOnJS(finishCornerFromGesture)(corner);
        });
    };
    const corners: Record<ImageCorner, ReturnType<typeof makeCornerGesture>> = {
      topLeft: makeCornerGesture('topLeft'),
      topRight: makeCornerGesture('topRight'),
      bottomLeft: makeCornerGesture('bottomLeft'),
      bottomRight: makeCornerGesture('bottomRight'),
    };

    // Reverted to plain auto-activation — see makeCornerGesture's comment
    // above for why (the manualActivation attempt broke finger dragging
    // without fixing the case it targeted).
    const pan = Gesture.Pan()
      .minDistance(IMAGE_DRAG_MIN_DISTANCE)
      .averageTouches(true)
      .hitSlop(IMAGE_HIT_SLOP)
      .onTouchesDown(makeFailIfStylus('pan'))
      // A touch that belongs to a corner handle must not also move the body.
      .requireExternalGestureToFail(
        corners.topLeft,
        corners.topRight,
        corners.bottomLeft,
        corners.bottomRight,
      )
      .onStart(() => {
        'worklet';
        runOnJS(beginPanFromGesture)();
      })
      .onUpdate((event) => {
        'worklet';
        runOnJS(updatePanFromGesture)(event.translationX, event.translationY, event.numberOfPointers);
      })
      .onFinalize(() => {
        'worklet';
        runOnJS(finishPanFromGesture)();
      });

    const pinch = Gesture.Pinch()
      .onStart(() => {
        'worklet';
        runOnJS(beginPinchFromGesture)();
      })
      .onUpdate((event) => {
        'worklet';
        runOnJS(updatePinchFromGesture)(event.scale);
      })
      .onFinalize(() => {
        'worklet';
        runOnJS(finishPinchFromGesture)();
      });

    return {
      bodyGesture: Gesture.Race(tap, Gesture.Simultaneous(pan, pinch)),
      cornerGestures: corners,
    };
  }, [beginCornerFromGesture, beginPanFromGesture, beginPinchFromGesture, finishCornerFromGesture, finishPanFromGesture, finishPinchFromGesture, selectImageFromGesture, traceImageGestureTouch, updateCornerFromGesture, updatePanFromGesture, updatePinchFromGesture]);

  const offsetX = selected ? moveOffset.x : 0;
  const offsetY = selected ? moveOffset.y : 0;
  const left = image.x + offsetX;
  const top = image.y + offsetY;
  const cornerCenters: Record<ImageCorner, { x: number; y: number }> = {
    topLeft: { x: left, y: top },
    topRight: { x: left + image.width, y: top },
    bottomLeft: { x: left, y: top + image.height },
    bottomRight: { x: left + image.width, y: top + image.height },
  };

  return (
    <>
      <GestureDetector gesture={bodyGesture}>
        <View
          collapsable={false}
          style={[
            styles.imageObject,
            { left, top, width: image.width, height: image.height },
            selected && styles.imageObjectSelected,
          ]}
        >
          <RNImage source={{ uri: image.uri }} style={styles.imageObjectMedia} resizeMode="contain" />
        </View>
      </GestureDetector>
      {selected
        ? IMAGE_CORNERS.map((corner) => (
            <GestureDetector key={corner} gesture={cornerGestures[corner]}>
              <View
                collapsable={false}
                style={[
                  styles.imageCornerHit,
                  {
                    left: cornerCenters[corner].x - IMAGE_CORNER_HANDLE_HALF,
                    top: cornerCenters[corner].y - IMAGE_CORNER_HANDLE_HALF,
                  },
                ]}
              >
                <View style={styles.imageHandleDot} />
              </View>
            </GestureDetector>
          ))
        : null}
    </>
  );
}

function ModeIconBase({
  mode,
  active,
  color: colorOverride,
  size,
}: {
  mode: CanvasMode;
  active: boolean;
  color?: string;
  size?: number;
}) {
  const color = colorOverride ?? (active ? colors.pearlWhite : colors.deepNavy);
  const glyphName: ToolbarGlyphName =
    mode === 'write'
      ? 'pen'
      : mode === 'highlight'
        ? 'highlighter'
        : mode === 'type'
          ? 'type'
          : mode === 'erase'
            ? 'eraser'
            : mode === 'select'
              ? 'select'
              : mode === 'insert'
                ? 'insert'
                : 'hand';
  return <ToolbarGlyph name={glyphName} color={color} size={size} />;
}

// Memoized pure presentational components. The canvas re-renders on every
// drawing frame (ActiveInkHost) and on every tool/toolbar state change;
// these leaves take stable props, so memo keeps each render from reconciling
// the whole toolbar (SVG glyphs, navy gradient) and every image object.
const ToolbarGlyph = memo(ToolbarGlyphBase);
const NavySurface = memo(NavySurfaceBase);
const GripDots = memo(GripDotsBase);
const SelectionShapeIcon = memo(SelectionShapeIconBase);
const ModeIcon = memo(ModeIconBase);
const NotebookImageObject = memo(NotebookImageObjectBase);

type NotebookCanvasProps = {
  strokes: NoteStroke[];
  text: string;
  onStrokesChange: (strokes: NoteStroke[]) => void;
  onTextChange: (text: string) => void;
  /** Image objects placed on the canvas. */
  images?: NoteImage[];
  onImagesChange?: (images: NoteImage[]) => void;
  /** When false: read-only — no toolbar, no input. Defaults to true. */
  editable?: boolean;
  /** Show the fixed top-right Undo/Redo control (lecture notes editor). Defaults to false. */
  showFixedHistory?: boolean;
  /** Other floating overlays, in this canvas container's coordinate space. */
  avoidRects?: NotebookOverlayRect[];
  style?: ViewStyle;
};

/**
 * The editable notebook page. Handwriting strokes flow through
 * `onStrokesChange` on stroke end; typed text flows through `onTextChange`.
 * The in-progress stroke and in-progress erase are kept local so a drag never
 * touches the parent until it ends.
 */
export const NotebookCanvas = memo(function NotebookCanvas({
  strokes,
  text,
  onStrokesChange,
  onTextChange,
  images: rawImages,
  onImagesChange: rawOnImagesChange,
  editable = true,
  showFixedHistory = false,
  avoidRects = [],
  style,
}: NotebookCanvasProps) {
  const t = useT();
  const images = useMemo(() => rawImages ?? [], [rawImages]);
  const onImagesChange = rawOnImagesChange ?? NOOP_IMAGES_CHANGE;
  const [mode, setMode] = useState<CanvasMode>(DEFAULT_TOOLBAR_PREFERENCES.mode);
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1].value);
  const [highlighterColor, setHighlighterColor] = useState(HIGHLIGHTER_COLORS[0].value);
  const [highlighterWidth, setHighlighterWidth] = useState(HIGHLIGHTER_WIDTHS[1].value);
  const [eraserSizeKey, setEraserSizeKey] = useState<EraserSizeKey>(
    DEFAULT_TOOLBAR_PREFERENCES.eraserSize,
  );
  const [toolbarCollapsed, setToolbarCollapsed] = useState(
    DEFAULT_TOOLBAR_PREFERENCES.collapsed,
  );
  const toolbarCollapsedRef = useRef(DEFAULT_TOOLBAR_PREFERENCES.collapsed);
  const [toolbarDock, setToolbarDock] = useState<NotebookToolbarDock>(
    DEFAULT_TOOLBAR_PREFERENCES.dock,
  );
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 });
  const [toolbarPreferencesLoaded, setToolbarPreferencesLoaded] = useState(false);
  const eraserRadius = ERASER_SIZES.find((option) => option.key === eraserSizeKey)?.radius ?? 26;
  const [, setTemporaryEraser] = useState(false);
  // Suppressed ids are visual-only during an erase. They are committed to the
  // parent document at gesture end, but remain hidden until that committed
  // snapshot acknowledges their absence so a stale render cannot flash ink
  // back into view.
  const [erasedIds, setErasedIds] = useState<Set<string>>(() => new Set());
  const [erasePoint, setErasePoint] = useState<NotePoint | null>(null);
  /**
   * Snapshot-based undo/redo history. Each completed content action pushes the
   * pre-action snapshot ({strokes, images, text}) onto the undo stack; Undo
   * restores it (pushing the current state to the redo stack); a new action
   * clears the redo stack. In-memory only (bounded), document state still
   * persists through the parent callbacks.
   */
  const undoStackRef = useRef<NotebookSnapshot[]>([]);
  const redoStackRef = useRef<NotebookSnapshot[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  /** Leading-edge flag so a typing burst coalesces into one history entry. */
  const textBurstRef = useRef(false);
  const textHistoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Transient "Pen" / "Eraser" badge shown after a Pencil double-tap. */
  const [toolToast, setToolToast] = useState<DrawingMode | 'erase' | null>(null);
  /** IDs of currently selected strokes or images. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** Points drawn for the active lasso selection (cleared after commit). */
  const [lassoPoints, setLassoPoints] = useState<NotePoint[]>([]);
  const [selectionShape, setSelectionShape] = useState<SelectionShape>('lasso');
  const [selectionRect, setSelectionRect] = useState<NotebookOverlayRect | null>(null);
  /** Offset applied to selected objects while a move drag is in progress. */
  const [selectionMoveOffset, setSelectionMoveOffset] = useState<NotePoint>({ x: 0, y: 0 });
  /** Disable page scrolling only while a confirmed stylus stroke is live (React mirror). */
  const [stylusStrokeActive, setStylusStrokeActive] = useState(false);
  /** Disable page scrolling while an image is being dragged or pinch-resized. */
  const [imageManipulationActive, setImageManipulationActive] = useState(false);
  /** Page pinch-zoom scale (session-local; does not rewrite stored stroke points). */
  const [canvasScale, setCanvasScale] = useState(NOTEBOOK_DEFAULT_SCALE);
  /** Horizontal pan paired with scale for focal-point zoom (Notability-style). */
  const zoomScale = useSharedValue(NOTEBOOK_DEFAULT_SCALE);
  const zoomX = useSharedValue(0);
  const zoomY = useSharedValue(0);
  const nativeScrollY = useSharedValue(0);
  const zoomHolding = useSharedValue(false);
  const zoomActive = useSharedValue(false);
  const zoomBlocked = useSharedValue(false);
  const zoomStart = useSharedValue({ scale: 1, x: 0, y: 0, focalX: 0, focalY: 0 });
  const zoomGeometry = useSharedValue({ width: 0, height: 0, contentHeight: 0 });
  const pendingZoomScroll = useRef<number | null>(null);
  const paperTransform = useAnimatedStyle(() => ({
    transform: [
      { translateX: zoomX.value },
      // Compensate actual native offset until the final scroll position lands.
      { translateY: zoomHolding.value ? nativeScrollY.value - zoomY.value : 0 },
      { scale: zoomScale.value },
    ],
  }));

  // Latest-value refs so the memoized gesture never sees a stale closure.
  const penColorRef = useRef(penColor);
  penColorRef.current = penColor;
  const penWidthRef = useRef(penWidth);
  penWidthRef.current = penWidth;
  const highlighterColorRef = useRef(highlighterColor);
  highlighterColorRef.current = highlighterColor;
  const highlighterWidthRef = useRef(highlighterWidth);
  highlighterWidthRef.current = highlighterWidth;
  const eraserRadiusRef = useRef(eraserRadius);
  eraserRadiusRef.current = eraserRadius;
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const onStrokesChangeRef = useRef(onStrokesChange);
  onStrokesChangeRef.current = onStrokesChange;
  const textRef = useRef(text);
  textRef.current = text;
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const previousDrawingToolRef = useRef<DrawingMode>('write');
  const temporaryEraserRef = useRef(false);
  /** Strokes erased during the current erase drag (committed on release). */
  const erasedIdsRef = useRef<Set<string>>(new Set());
  /** All visual suppressions awaiting the parent stroke snapshot. */
  const suppressedEraseIdsRef = useRef<Set<string>>(new Set());
  const lastErasePointRef = useRef<NotePoint | null>(null);
  const eraseRenderFrameRef = useRef<number | null>(null);
  const eraseCursorFrameRef = useRef<number | null>(null);
  const pendingEraseCursorPointRef = useRef<NotePoint | null>(null);
  const strokeHitIndex = useMemo(
    () => strokes.map((stroke) => ({ stroke, bounds: strokeBounds(stroke.points) })),
    [strokes],
  );
  const strokeHitIndexRef = useRef(strokeHitIndex);
  strokeHitIndexRef.current = strokeHitIndex;

  // A committed parent snapshot is the acknowledgement that makes a visual
  // erase durable. Until then, keep the stroke suppressed even if an older
  // render arrives first; Undo explicitly clears this state through
  // applySnapshot above.
  useEffect(() => {
    if (suppressedEraseIdsRef.current.size === 0) return;
    const present = new Set(strokes.map((stroke) => stroke.id));
    let changed = false;
    for (const id of suppressedEraseIdsRef.current) {
      if (!present.has(id)) {
        suppressedEraseIdsRef.current.delete(id);
        changed = true;
      }
    }
    if (changed) setErasedIds(new Set(suppressedEraseIdsRef.current));
  }, [strokes]);
  /** True between a Pencil touch-down and the drawing gesture finishing. */
  const drawingRef = useRef(false);
  /**
   * Live ink host — owns active-stroke React state so parent canvas / completed
   * strokes do not re-render on every Pencil sample.
   */
  const activeInkRef = useRef<ActiveInkHandle>(null);
  /**
   * id of the touch that started the live stroke. Only that touch lifting ends
   * the stroke — a resting palm or any other touch is ignored.
   */
  const activeTouchIdRef = useRef<number | null>(null);
  /** Pencil-over-image investigation: one-shot-per-stroke counters, logged
   * once at stroke end — never per-sample, so this stays cheap even for a
   * fast, long stroke. */
  const strokeMoveSampleCountRef = useRef(0);
  const strokeStartedOverImageRef = useRef<string | null>(null);
  /** Current page offset so viewport-local Pencil coordinates map onto the long paper. */
  const scrollOffsetYRef = useRef(0);
  const scrollViewRef = useRef<ComponentRef<typeof GestureScrollView>>(null);
  /** Sync scroll lock (stroke / palm grace / pinch) — must not wait for React render. */
  const stylusStrokeLockRef = useRef(false);
  const palmGraceActiveRef = useRef(false);
  const palmGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinchActiveRef = useRef(false);
  const canvasScaleRef = useRef(NOTEBOOK_DEFAULT_SCALE);
  canvasScaleRef.current = canvasScale;
  const canvasTranslateXRef = useRef(0);
  const imageManipulationActiveRef = useRef(false);
  imageManipulationActiveRef.current = imageManipulationActive;
  /** Live page geometry (set each render) so stable callbacks can read it without re-creating. */
  const pageGeomRef = useRef({ pageHeight: PAGE_HEIGHT, pageStride: PAGE_HEIGHT + PAGE_GAP, totalPages: 1, canvasHeight: PAGE_HEIGHT });

  const applyNotebookScrollEnabled = useCallback(() => {
    zoomBlocked.value = stylusStrokeLockRef.current || palmGraceActiveRef.current || imageManipulationActiveRef.current;
    const locked = shouldLockNotebookScroll({
      strokeActive: stylusStrokeLockRef.current,
      palmGrace: palmGraceActiveRef.current,
      pinchActive: pinchActiveRef.current,
      imageManipulation: imageManipulationActiveRef.current,
    });
    scrollViewRef.current?.setNativeProps({ scrollEnabled: !locked });
  }, [zoomBlocked]);

  const clearPalmGraceTimer = useCallback(() => {
    if (palmGraceTimerRef.current) {
      clearTimeout(palmGraceTimerRef.current);
      palmGraceTimerRef.current = null;
    }
  }, []);

  // One-shot diagnostics for the palm/double-tap viewport-jump investigation.
  // No polling: these only fire on genuine state transitions (lock begin/end,
  // double-tap) or when a scroll is observed WHILE the lock should be
  // preventing one — that last case is the actual smoking gun to look for.
  const lastLockedScrollYRef = useRef<number | null>(null);
  const beginStylusScrollLock = useCallback(() => {
    if (__DEV__) {
      console.info('[NotebookViewport] stylus-lock-begin', {
        scrollYBefore: scrollOffsetYRef.current,
        wasPalmGrace: palmGraceActiveRef.current,
      });
    }
    clearPalmGraceTimer();
    palmGraceActiveRef.current = false;
    stylusStrokeLockRef.current = true;
    setStylusStrokeActive(true);
    lastLockedScrollYRef.current = scrollOffsetYRef.current;
    applyNotebookScrollEnabled();
  }, [applyNotebookScrollEnabled, clearPalmGraceTimer]);

  // Second-round diagnostic: the first round proved every captured
  // pencil-double-tap fired with strokeActive/palmGrace both already false —
  // i.e. the app's own scroll lock had fully released BEFORE the double-tap,
  // so a scroll happening mid-lock was never going to be the finding. This
  // arms a short, bounded, one-shot watch (not polling) at the two moments
  // protection actually lapses — grace-timer expiry and double-tap itself —
  // and reportNotebookScroll below checks it, so a jump landing in that
  // unprotected gap (palm still resting, nothing blocking it) gets caught
  // with its exact delta instead of only "no lock was on."
  const POST_UNLOCK_WATCH_MS = 1200;
  const postUnlockWatchRef = useRef<{ until: number; baselineY: number; reason: string } | null>(null);
  const armPostUnlockWatch = useCallback((reason: string) => {
    if (!__DEV__) return;
    postUnlockWatchRef.current = {
      until: Date.now() + POST_UNLOCK_WATCH_MS,
      baselineY: scrollOffsetYRef.current,
      reason,
    };
  }, []);

  const endStylusScrollLock = useCallback(
    (opts?: { grace?: boolean }) => {
      if (__DEV__) {
        console.info('[NotebookViewport] stylus-lock-end', {
          scrollYAtEnd: scrollOffsetYRef.current,
          scrollYAtLockBegin: lastLockedScrollYRef.current,
          grace: Boolean(opts?.grace),
        });
      }
      lastLockedScrollYRef.current = null;
      stylusStrokeLockRef.current = false;
      setStylusStrokeActive(false);
      clearPalmGraceTimer();
      if (opts?.grace) {
        palmGraceActiveRef.current = true;
        applyNotebookScrollEnabled();
        palmGraceTimerRef.current = setTimeout(() => {
          palmGraceTimerRef.current = null;
          palmGraceActiveRef.current = false;
          applyNotebookScrollEnabled();
          armPostUnlockWatch('grace-expired');
        }, NOTEBOOK_PALM_GRACE_MS);
        return;
      }
      palmGraceActiveRef.current = false;
      applyNotebookScrollEnabled();
    },
    [applyNotebookScrollEnabled, armPostUnlockWatch, clearPalmGraceTimer],
  );

  useEffect(
    () => () => {
      clearPalmGraceTimer();
    },
    [clearPalmGraceTimer],
  );
  const toolbarPosition = useRef(new Animated.ValueXY({ x: TOOLBAR_EDGE_MARGIN, y: TOOLBAR_EDGE_MARGIN })).current;
  const toolbarTransition = useRef(
    new Animated.Value(DEFAULT_TOOLBAR_PREFERENCES.collapsed ? 0 : 1),
  ).current;
  const transitionToolbarCollapsed = useCallback((nextCollapsed: boolean) => {
    if (!shouldStartToolbarTransition(toolbarCollapsedRef.current, nextCollapsed)) return;
    toolbarCollapsedRef.current = nextCollapsed;
    LayoutAnimation.configureNext({
      duration: TOOLBAR_ANIMATION_MS,
      update: { type: LayoutAnimation.Types.easeInEaseOut },
    });
    setToolbarCollapsed(nextCollapsed);
  }, []);
  const toolbarPositionRef = useRef({ x: TOOLBAR_EDGE_MARGIN, y: TOOLBAR_EDGE_MARGIN });
  const toolbarDragStartRef = useRef(toolbarPositionRef.current);
  const toolbarTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const toolbarDraggingRef = useRef(false);
  const toolbarContextScrollActiveRef = useRef(false);
  const toolbarSuppressPressUntilRef = useRef(0);
  /** Latest drag finger position in container coordinates, for edge-intent snapping. */
  const toolbarDragFingerRef = useRef<{ x: number; y: number } | null>(null);
  /** Container (Canvas) top-left in window/page coordinates, measured on layout. */
  const containerRef = useRef<View>(null);
  const containerOriginRef = useRef({ x: 0, y: 0 });
  const avoidRectsRef = useRef(avoidRects);
  avoidRectsRef.current = avoidRects;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const onImagesChangeRef = useRef(onImagesChange);
  onImagesChangeRef.current = onImagesChange;
  const containerSizeRef = useRef(containerSize);
  containerSizeRef.current = containerSize;
  const selectedIdsRef = useRef<Set<string>>(new Set());
  selectedIdsRef.current = selectedIds;
  const selectionShapeRef = useRef<SelectionShape>('lasso');
  selectionShapeRef.current = selectionShape;
  /** 'lasso'/'rect' while drawing a selection shape; 'move' while dragging selected objects. */
  const selectActionRef = useRef<'idle' | 'lasso' | 'rect' | 'move'>('idle');
  const lassoPointsRef = useRef<NotePoint[]>([]);
  const selectionRectStartRef = useRef<NotePoint | null>(null);
  const selectionRectEndRef = useRef<NotePoint | null>(null);
  const selectionMoveOffsetRef = useRef<NotePoint>({ x: 0, y: 0 });
  const selectionMoveStartRef = useRef<NotePoint>({ x: 0, y: 0 });
  const imageGestureStartRef = useRef<{
    id: string;
    image: NoteImage;
    snapshot: NotebookSnapshot;
    changed: boolean;
    committed: boolean;
  } | null>(null);
  /** Auto-releases the page-scroll lock shortly after image-gesture updates stop. */
  const imageScrollLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedObjectCount = useMemo(
    () =>
      strokes.reduce((count, stroke) => count + (selectedIds.has(stroke.id) ? 1 : 0), 0) +
      images.reduce((count, image) => count + (selectedIds.has(image.id) ? 1 : 0), 0),
    [strokes, images, selectedIds],
  );
  const hasSelection = selectedObjectCount > 0;
  const avoidRectsSignature = JSON.stringify(avoidRects);
  const effectiveToolbarCollapsed =
    toolbarCollapsed || (containerSize.width > 0 && containerSize.width < NARROW_TOOLBAR_WIDTH);
  // Text mode shows no context row (no "Body / tap the page" prompt) — keeps the
  // toolbar compact; tapping the canvas focuses the text input directly.
  const toolbarHasContext = !effectiveToolbarCollapsed && mode !== 'scroll' && mode !== 'type';
  const toolbarVertical = toolbarDockIsVertical(toolbarDock);
  const toolbarOnRight = toolbarDock === 'rightCenter';
  const collapsedToolbarSize = useMemo(
    () =>
      toolbarVertical
        ? { width: TOOLBAR_COLLAPSED_HEIGHT, height: TOOLBAR_COLLAPSED_WIDTH }
        : { width: TOOLBAR_COLLAPSED_WIDTH, height: TOOLBAR_COLLAPSED_HEIGHT },
    [toolbarVertical],
  );
  const toolbarContextWidth = toolbarHasContext
    ? Math.min(
        TOOLBAR_VERTICAL_CONTEXT_WIDTH,
        Math.max(
          260,
          containerSize.width -
            TOOLBAR_VERTICAL_RAIL_WIDTH -
            TOOLBAR_VERTICAL_ACTION_WIDTH -
            TOOLBAR_RIGHT_PILL_GAP * 3 -
            TOOLBAR_EDGE_MARGIN * 2,
        ),
      )
    : 0;
  const contextFade = useRef(new Animated.Value(1)).current;
  const expandedToolbarWidth =
    mode === 'write' || mode === 'highlight' || mode === 'select' || mode === 'insert'
      ? TOOLBAR_WIDTHS.drawing
      : mode === 'erase'
        ? TOOLBAR_WIDTHS.erase
        : TOOLBAR_WIDTHS.compact;
  const expandedToolbarHeight =
    TOOLBAR_PRIMARY_HEIGHT + (toolbarHasContext ? TOOLBAR_CONTEXT_HEIGHT : 0);
  const verticalRailHeight =
    22 +
    PRIMARY_TOOLS.length * 48 +
    44 +
    44 +
    TOOLBAR_VERTICAL_BUTTON_GAP * (PRIMARY_TOOLS.length + 1) +
    2;
  const toolbarVisualSize = useMemo(
    () => {
      if (effectiveToolbarCollapsed) {
        return collapsedToolbarSize;
      }
      if (toolbarVertical) {
        return {
          width: TOOLBAR_VERTICAL_RAIL_WIDTH + toolbarContextWidth,
          height: verticalRailHeight,
        };
      }
      return {
        width: Math.min(
          expandedToolbarWidth,
          Math.max(TOOLBAR_COLLAPSED_WIDTH, containerSize.width - TOOLBAR_EDGE_MARGIN * 2),
        ),
        height: expandedToolbarHeight,
      };
    },
    [
      containerSize.width,
      effectiveToolbarCollapsed,
      expandedToolbarHeight,
      expandedToolbarWidth,
      toolbarContextWidth,
      toolbarVertical,
      verticalRailHeight,
      collapsedToolbarSize,
    ],
  );
  const getToolbarFootprintForDock = useCallback(
    (dock: NotebookToolbarDock) => {
      const dockIsVertical = toolbarDockIsVertical(dock);
      if (effectiveToolbarCollapsed) {
        return dockIsVertical
          ? { width: TOOLBAR_MINI_CAPSULE_WIDTH, height: TOOLBAR_MINI_CAPSULE_HEIGHT }
          : { width: TOOLBAR_COLLAPSED_WIDTH, height: TOOLBAR_COLLAPSED_HEIGHT };
      }

      if (dockIsVertical) {
        // Two-column capsule (tool column + inward context column) + separate action
        // capsules stacked below. The action capsules are narrower than the capsule, so
        // width is the capsule's; height adds the history capsule (+ selection when shown).
        const hasContext = mode !== 'scroll' && mode !== 'type';
        const contextWidth =
          mode === 'insert'
            ? TOOLBAR_VERTICAL_CONTEXT_WIDE
            : TOOLBAR_VERTICAL_CONTEXT_NARROW;
        return {
          width:
            TOOLBAR_VERTICAL_TOOL_COL_WIDTH +
            (hasContext ? TOOLBAR_VERTICAL_COL_DIVIDER + contextWidth : 0),
          height:
            TOOLBAR_VERTICAL_CAPSULE_HEIGHT +
            TOOLBAR_VERTICAL_GROUP_GAP +
            TOOLBAR_VERTICAL_ACTION_HEIGHT,
        };
      }

      // Selection Duplicate/Delete is no longer a toolbar pill (it floats above the
      // selected image), so the toolbar footprint never grows with the selection.
      const rightPillWidth = TOOLBAR_HISTORY_PILL_WIDTH;
      return {
        width: Math.min(
          expandedToolbarWidth,
          Math.max(TOOLBAR_COLLAPSED_WIDTH, containerSize.width - TOOLBAR_EDGE_MARGIN * 2),
        ) + TOOLBAR_RIGHT_PILL_GAP + rightPillWidth,
        height: expandedToolbarHeight,
      };
    },
    [
      containerSize.width,
      effectiveToolbarCollapsed,
      expandedToolbarHeight,
      expandedToolbarWidth,
      mode,
    ],
  );
  const toolbarFrameSize = useMemo(
    () => getToolbarFootprintForDock(toolbarDock),
    [getToolbarFootprintForDock, toolbarDock],
  );
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const validIds = new Set([
      ...strokes.map((stroke) => stroke.id),
      ...images.map((image) => image.id),
    ]);
    let changed = false;
    const next = new Set<string>();
    selectedIds.forEach((id) => {
      if (validIds.has(id)) next.add(id);
      else changed = true;
    });
    if (!changed) return;
    selectedIdsRef.current = next;
    setSelectedIds(next);
  }, [strokes, images, selectedIds]);
  const expandedContentOpacity = toolbarTransition.interpolate({
    inputRange: [0, 0.35, 1],
    outputRange: [0, 0, 1],
  });
  const collapsedContentOpacity = toolbarTransition.interpolate({
    inputRange: [0, 0.7, 1],
    outputRange: [1, 0.18, 0],
  });
  const toolbarScale = toolbarTransition.interpolate({
    inputRange: [0, 1],
    outputRange: [0.98, 1],
  });
  /** Pending tool-toast hide timer. */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Whether native Apple Pencil double-tap is compiled into this build. */
  const doubleTapAvailable = useMemo(() => isPencilDoubleTapAvailable(), []);

  useEffect(() => {
    const footprint = getToolbarFootprintForDock(toolbarDock);
    setToolbarSize((current) =>
      current.width === footprint.width && current.height === footprint.height ? current : footprint,
    );
  }, [getToolbarFootprintForDock, toolbarDock]);

  useEffect(() => {
    toolbarTransition.stopAnimation();
    Animated.timing(toolbarTransition, {
      toValue: effectiveToolbarCollapsed ? 0 : 1,
      duration: TOOLBAR_ANIMATION_MS,
      easing: TOOLBAR_EASING,
      useNativeDriver: true,
    }).start();
  }, [effectiveToolbarCollapsed, toolbarTransition]);

  const chooseToolbarDock = useCallback(
    (
      sourcePoint: { x: number; y: number },
      preferredDock: NotebookToolbarDock = toolbarDock,
      // When true (layout re-clamp), keep the current region if it is still valid.
      // When false (drag release), always snap to the nearest valid region to the drop point.
      preferCurrent = true,
    ): NotebookToolbarDock => {
      if (
        containerSize.width <= 0 ||
        containerSize.height <= 0 ||
        toolbarSize.width <= 0 ||
        toolbarSize.height <= 0
      ) {
        return preferredDock;
      }

      const validDocks = TOOLBAR_DOCKS.filter((dock) => {
        const footprint = getToolbarFootprintForDock(dock);
        if (
          toolbarDockIsVertical(dock) &&
          footprint.height > containerSize.height - TOOLBAR_EDGE_MARGIN * 2
        ) {
          return false;
        }
        const point = toolbarDockPoint(dock, containerSize, footprint);
        const rect = toolbarRect(point, footprint);
        return !avoidRectsRef.current.some((avoidRect) =>
          rectsOverlap(rect, avoidRect, TOOLBAR_COLLISION_GAP),
        );
      });
      const candidates = validDocks.length > 0 ? validDocks : TOOLBAR_DOCKS;
      if (preferCurrent && validDocks.includes(preferredDock)) return preferredDock;

      return candidates.reduce((nearest, dock) => {
        const nearestPoint = toolbarDockPoint(nearest, containerSize, getToolbarFootprintForDock(nearest));
        const dockPoint = toolbarDockPoint(dock, containerSize, getToolbarFootprintForDock(dock));
        const nearestDistance = Math.hypot(
          nearestPoint.x - sourcePoint.x,
          nearestPoint.y - sourcePoint.y,
        );
        const dockDistance = Math.hypot(dockPoint.x - sourcePoint.x, dockPoint.y - sourcePoint.y);
        return dockDistance < nearestDistance ? dock : nearest;
      }, candidates[0]);
    },
    [containerSize, getToolbarFootprintForDock, toolbarDock, toolbarSize],
  );

  /**
   * Decide the dock when the user RELEASES a toolbar drag.
   *
   * `chooseToolbarDock` compares the toolbar's top-left corner to each anchor by
   * Euclidean distance. For a wide horizontal toolbar that biases toward the
   * top/bottom anchors: dragging the toolbar BODY onto the right edge leaves the
   * top-left near the `topRight`/`bottomRight` anchors, so `rightCenter` rarely
   * wins — the reported "sometimes stays horizontal" bug.
   *
   * Instead we read the release FINGER position (container coords) and apply an
   * explicit edge-intent rule: a finger inside the left/right activation band
   * snaps to that side edge (vertical layout) and wins over top/bottom corners.
   * The accepted dock alone determines orientation — no stale orientation state.
   */
  const resolveReleaseDock = useCallback((): NotebookToolbarDock => {
    const cw = containerSize.width;
    const ch = containerSize.height;
    if (cw <= 0 || ch <= 0 || toolbarSize.width <= 0 || toolbarSize.height <= 0) {
      return toolbarDock;
    }

    const validDocks = TOOLBAR_DOCKS.filter((dock) => {
      const footprint = getToolbarFootprintForDock(dock);
      if (toolbarDockIsVertical(dock) && footprint.height > ch - TOOLBAR_EDGE_MARGIN * 2) {
        return false;
      }
      const point = toolbarDockPoint(dock, containerSize, footprint);
      const rect = toolbarRect(point, footprint);
      return !avoidRectsRef.current.some((avoidRect) =>
        rectsOverlap(rect, avoidRect, TOOLBAR_COLLISION_GAP),
      );
    });
    const candidates = validDocks.length > 0 ? validDocks : TOOLBAR_DOCKS;
    const isValid = (dock: NotebookToolbarDock) => candidates.includes(dock);
    const nearestValidTo = (point: { x: number; y: number }) =>
      candidates.reduce((nearest, dock) => {
        const nearestPoint = toolbarDockPoint(nearest, containerSize, getToolbarFootprintForDock(nearest));
        const dockPoint = toolbarDockPoint(dock, containerSize, getToolbarFootprintForDock(dock));
        const nd = Math.hypot(nearestPoint.x - point.x, nearestPoint.y - point.y);
        const dd = Math.hypot(dockPoint.x - point.x, dockPoint.y - point.y);
        return dd < nd ? dock : nearest;
      }, candidates[0]);
    const anchorOf = (dock: NotebookToolbarDock) =>
      toolbarDockPoint(dock, containerSize, getToolbarFootprintForDock(dock));

    // Release intent point: the finger location (container coords). Fall back to
    // the toolbar centre if no finger sample was captured during the drag.
    const footprint = getToolbarFootprintForDock(toolbarDock);
    const release = toolbarDragFingerRef.current ?? {
      x: toolbarPositionRef.current.x + footprint.width / 2,
      y: toolbarPositionRef.current.y + footprint.height / 2,
    };

    const sideZone = Math.max(TOOLBAR_SIDE_EDGE_ZONE_MIN, cw * TOOLBAR_SIDE_EDGE_ZONE_RATIO);
    const vEdgeZone = Math.max(TOOLBAR_VERT_EDGE_ZONE_MIN, ch * TOOLBAR_VERT_EDGE_ZONE_RATIO);
    const nearRight = release.x >= cw - sideZone;
    const nearLeft = release.x <= sideZone;
    const nearTop = release.y <= vEdgeZone;
    const nearBottom = release.y >= ch - vEdgeZone;

    // Side-edge intent wins over top/bottom corners.
    if (nearRight && !nearLeft) {
      return isValid('rightCenter') ? 'rightCenter' : nearestValidTo(anchorOf('rightCenter'));
    }
    if (nearLeft && !nearRight) {
      return isValid('leftCenter') ? 'leftCenter' : nearestValidTo(anchorOf('leftCenter'));
    }

    const band: 'Left' | 'Center' | 'Right' =
      release.x < cw / 3 ? 'Left' : release.x > (cw * 2) / 3 ? 'Right' : 'Center';
    if (nearTop) {
      const cand = `top${band}` as NotebookToolbarDock;
      return isValid(cand) ? cand : nearestValidTo(release);
    }
    if (nearBottom) {
      const cand = `bottom${band}` as NotebookToolbarDock;
      return isValid(cand) ? cand : nearestValidTo(release);
    }

    // Released away from any edge: nearest valid anchor to the finger.
    return nearestValidTo(release);
  }, [containerSize, getToolbarFootprintForDock, toolbarDock, toolbarSize]);

  const moveToolbarToDock = useCallback(
    (dock: NotebookToolbarDock, animated: boolean) => {
      if (
        containerSize.width <= 0 ||
        containerSize.height <= 0 ||
        toolbarSize.width <= 0 ||
        toolbarSize.height <= 0
      ) {
        return;
      }
      const footprint = getToolbarFootprintForDock(dock);
      const point = toolbarDockPoint(dock, containerSize, footprint);
      toolbarPositionRef.current = point;
      const animation = Animated.timing(toolbarPosition, {
        toValue: point,
        duration: animated ? 150 : 0,
        useNativeDriver: true,
      });
      animation.start();
    },
    [containerSize, getToolbarFootprintForDock, toolbarPosition, toolbarSize],
  );

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(TOOLBAR_STORAGE_KEY)
      .then((raw) => {
        if (!active || !raw) return;
        const stored = JSON.parse(raw) as Partial<ToolbarPreferences>;
        if (typeof stored.collapsed === 'boolean') {
          toolbarCollapsedRef.current = stored.collapsed;
          setToolbarCollapsed(stored.collapsed);
        }
        if (TOOLBAR_DOCKS.includes(stored.dock as NotebookToolbarDock)) {
          setToolbarDock(stored.dock as NotebookToolbarDock);
        }
        if (DRAW_MODES.some((tool) => tool.key === stored.mode) || stored.mode === 'scroll') {
          const storedMode = stored.mode as CanvasMode;
          modeRef.current = storedMode;
          setMode(storedMode);
          if (storedMode === 'write' || storedMode === 'highlight') {
            previousDrawingToolRef.current = storedMode;
          }
        }
        if (ERASER_SIZES.some((size) => size.key === stored.eraserSize)) {
          setEraserSizeKey(stored.eraserSize as EraserSizeKey);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setToolbarPreferencesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!toolbarPreferencesLoaded) return;
    const preferences: ToolbarPreferences = {
      collapsed: toolbarCollapsed,
      dock: toolbarDock,
      mode,
      eraserSize: eraserSizeKey,
    };
    AsyncStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify(preferences)).catch(() => {});
  }, [eraserSizeKey, mode, toolbarCollapsed, toolbarDock, toolbarPreferencesLoaded]);

  useEffect(() => {
    if (
      containerSize.width <= 0 ||
      containerSize.height <= 0 ||
      toolbarSize.width <= 0 ||
      toolbarSize.height <= 0
    ) {
      return;
    }
    // Keep the toolbar in its logical snap region. If the region's footprint now
    // overlaps the caption/recording overlay (avoid-rects) or the toolbar grew
    // (context row, expand), re-pick the nearest still-valid region and re-clamp.
    const preferredPoint = toolbarDockPoint(toolbarDock, containerSize, toolbarSize);
    const nextDock = chooseToolbarDock(preferredPoint, toolbarDock);
    if (nextDock !== toolbarDock) setToolbarDock(nextDock);
    moveToolbarToDock(nextDock, true);
  }, [
    avoidRectsSignature,
    chooseToolbarDock,
    containerSize,
    effectiveToolbarCollapsed,
    moveToolbarToDock,
    toolbarDock,
    toolbarSize,
  ]);

  const moveToolbarDrag = useCallback(
    (dx: number, dy: number) => {
      const dragBoundsFootprint = TOOLBAR_DOCKS.reduce(
        (smallest, dock) => {
          const footprint = getToolbarFootprintForDock(dock);
          return {
            width: Math.min(smallest.width, footprint.width),
            height: Math.min(smallest.height, footprint.height),
          };
        },
        getToolbarFootprintForDock(toolbarDock),
      );
      const maxX = Math.max(
        TOOLBAR_EDGE_MARGIN,
        containerSize.width - dragBoundsFootprint.width - TOOLBAR_EDGE_MARGIN,
      );
      const maxY = Math.max(
        TOOLBAR_EDGE_MARGIN,
        containerSize.height - dragBoundsFootprint.height - TOOLBAR_EDGE_MARGIN,
      );
      const point = {
        x: clamp(toolbarDragStartRef.current.x + dx, TOOLBAR_EDGE_MARGIN, maxX),
        y: clamp(toolbarDragStartRef.current.y + dy, TOOLBAR_EDGE_MARGIN, maxY),
      };
      toolbarPositionRef.current = point;
      toolbarPosition.setValue(point);
    },
    [
      containerSize.height,
      containerSize.width,
      getToolbarFootprintForDock,
      toolbarDock,
      toolbarPosition,
    ],
  );

  const finishToolbarDrag = useCallback(() => {
    if (!toolbarDraggingRef.current) return;
    toolbarDraggingRef.current = false;
    toolbarSuppressPressUntilRef.current = Date.now() + 200;
    // Release -> edge-intent snap based on the finger position. The accepted dock
    // alone determines orientation (rightCenter/leftCenter => vertical).
    const nextDock = resolveReleaseDock();
    toolbarDragFingerRef.current = null;
    setToolbarDock(nextDock);
    moveToolbarToDock(nextDock, true);
  }, [moveToolbarToDock, resolveReleaseDock]);

  const releaseToolbarContextScrollLock = useCallback(() => {
    setTimeout(() => {
      toolbarContextScrollActiveRef.current = false;
    }, 80);
  }, []);

  const contextScrollHandlers = useMemo(
    () => ({
      onTouchStart: () => {
        toolbarContextScrollActiveRef.current = true;
        toolbarTouchStartRef.current = null;
      },
      onTouchEnd: releaseToolbarContextScrollLock,
      onTouchCancel: releaseToolbarContextScrollLock,
      onScrollBeginDrag: () => {
        toolbarContextScrollActiveRef.current = true;
        toolbarTouchStartRef.current = null;
      },
      onScrollEndDrag: releaseToolbarContextScrollLock,
      onMomentumScrollEnd: releaseToolbarContextScrollLock,
    }),
    [releaseToolbarContextScrollLock],
  );

  const toolbarDragTouchHandlers = useMemo(
    () => ({
      onTouchStart: (event: { nativeEvent: { touches: { pageX: number; pageY: number }[] } }) => {
        if (toolbarContextScrollActiveRef.current) return;
        const touch = event.nativeEvent.touches[0];
        if (!touch) return;
        toolbarTouchStartRef.current = { pageX: touch.pageX, pageY: touch.pageY };
        toolbarDragStartRef.current = { ...toolbarPositionRef.current };
        toolbarDraggingRef.current = false;
        toolbarDragFingerRef.current = {
          x: touch.pageX - containerOriginRef.current.x,
          y: touch.pageY - containerOriginRef.current.y,
        };
      },
      onTouchMove: (event: { nativeEvent: { touches: { pageX: number; pageY: number }[] } }) => {
        if (toolbarContextScrollActiveRef.current) return;
        const touch = event.nativeEvent.touches[0];
        const start = toolbarTouchStartRef.current;
        if (!touch || !start) return;
        toolbarDragFingerRef.current = {
          x: touch.pageX - containerOriginRef.current.x,
          y: touch.pageY - containerOriginRef.current.y,
        };
        const dx = touch.pageX - start.pageX;
        const dy = touch.pageY - start.pageY;
        if (!toolbarDraggingRef.current) {
          if (Math.hypot(dx, dy) <= TOOLBAR_DRAG_THRESHOLD) return;
          toolbarDraggingRef.current = true;
          toolbarSuppressPressUntilRef.current = Date.now() + 200;
        }
        moveToolbarDrag(dx, dy);
      },
      onTouchEnd: () => {
        toolbarTouchStartRef.current = null;
        finishToolbarDrag();
      },
      onTouchCancel: () => {
        toolbarTouchStartRef.current = null;
        finishToolbarDrag();
      },
    }),
    [finishToolbarDrag, moveToolbarDrag],
  );

  const toolbarDragResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          !toolbarContextScrollActiveRef.current &&
          Math.hypot(gesture.dx, gesture.dy) > TOOLBAR_DRAG_THRESHOLD,
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          !toolbarContextScrollActiveRef.current &&
          Math.hypot(gesture.dx, gesture.dy) > TOOLBAR_DRAG_THRESHOLD,
        onPanResponderGrant: (event) => {
          if (toolbarContextScrollActiveRef.current) return;
          toolbarDraggingRef.current = true;
          toolbarSuppressPressUntilRef.current = Date.now() + 200;
          toolbarDragStartRef.current = { ...toolbarPositionRef.current };
          toolbarDragFingerRef.current = {
            x: event.nativeEvent.pageX - containerOriginRef.current.x,
            y: event.nativeEvent.pageY - containerOriginRef.current.y,
          };
        },
        onPanResponderMove: (event, gesture) => {
          if (!toolbarDraggingRef.current) return;
          toolbarDragFingerRef.current = {
            x: event.nativeEvent.pageX - containerOriginRef.current.x,
            y: event.nativeEvent.pageY - containerOriginRef.current.y,
          };
          moveToolbarDrag(gesture.dx, gesture.dy);
        },
        onPanResponderRelease: finishToolbarDrag,
        onPanResponderTerminate: finishToolbarDrag,
        onPanResponderTerminationRequest: () => false,
      }),
    [finishToolbarDrag, moveToolbarDrag],
  );

  const disabledToolbarPanGesture = useMemo(() => Gesture.Pan().enabled(false), []);

  const toolbarPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(TOOLBAR_DRAG_THRESHOLD)
        .onStart((event) => {
          toolbarDraggingRef.current = true;
          toolbarSuppressPressUntilRef.current = Date.now() + 200;
          toolbarDragStartRef.current = { ...toolbarPositionRef.current };
          toolbarDragFingerRef.current = {
            x: event.absoluteX - containerOriginRef.current.x,
            y: event.absoluteY - containerOriginRef.current.y,
          };
        })
        .onUpdate((event) => {
          toolbarDragFingerRef.current = {
            x: event.absoluteX - containerOriginRef.current.x,
            y: event.absoluteY - containerOriginRef.current.y,
          };
          moveToolbarDrag(event.translationX, event.translationY);
        })
        .onEnd(finishToolbarDrag)
        .onFinalize(finishToolbarDrag),
    [finishToolbarDrag, moveToolbarDrag],
  );

  const runToolbarPress = useCallback((action: () => void) => {
    if (toolbarDraggingRef.current || Date.now() < toolbarSuppressPressUntilRef.current) return;
    action();
  }, []);

  /** Briefly show the current drawing tool badge with a light haptic tick. */
  const showToolToast = useCallback((tool: DrawingMode | 'erase') => {
    setToolToast(tool);
    Haptics.selectionAsync().catch(() => {});
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToolToast(null), TOOL_TOAST_MS);
  }, []);

  const changeMode = useCallback((next: CanvasMode) => {
    modeRef.current = next;
    temporaryEraserRef.current = false;
    setTemporaryEraser(false);
    if (next === 'write' || next === 'highlight') {
      previousDrawingToolRef.current = next;
    }
    if (next !== 'select') {
      // Leave any active selection behind when switching tools.
      selectedIdsRef.current = new Set();
      setSelectedIds(new Set());
      lassoPointsRef.current = [];
      setLassoPoints([]);
    }
    setMode(next);
  }, []);

  const restoreTemporaryEraserIfNeeded = useCallback(() => {
    if (!temporaryEraserRef.current) return;
    const restored = previousDrawingToolRef.current;
    temporaryEraserRef.current = false;
    setTemporaryEraser(false);
    modeRef.current = restored;
    setMode(restored);
    showToolToast(restored);
  }, [showToolToast]);

  // ---- Undo / Redo snapshot history ----

  const captureSnapshot = useCallback(
    (): NotebookSnapshot =>
      cloneSnapshot({
        strokes: strokesRef.current,
        images: imagesRef.current,
        text: textRef.current,
      }),
    [],
  );

  const updateHistoryFlags = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  /**
   * Record the current content as a new undo entry — call this once at the
   * start of a completed action, before mutating state. Clears the redo stack
   * (a new action invalidates redo) and the text-burst flag.
   */
  const endTextHistoryBurst = useCallback(() => {
    if (textHistoryTimerRef.current) {
      clearTimeout(textHistoryTimerRef.current);
      textHistoryTimerRef.current = null;
    }
    textBurstRef.current = false;
  }, []);

  const pushUndoSnapshot = useCallback((snapshot: NotebookSnapshot) => {
    undoStackRef.current.push(cloneSnapshot(snapshot));
    if (undoStackRef.current.length > HISTORY_MAX) undoStackRef.current.shift();
  }, []);

  const pushRedoSnapshot = useCallback((snapshot: NotebookSnapshot) => {
    redoStackRef.current.push(cloneSnapshot(snapshot));
    if (redoStackRef.current.length > HISTORY_MAX) redoStackRef.current.shift();
  }, []);

  const recordHistory = useCallback(() => {
    endTextHistoryBurst();
    undoStackRef.current.push(captureSnapshot());
    if (undoStackRef.current.length > HISTORY_MAX) undoStackRef.current.shift();
    redoStackRef.current = [];
    updateHistoryFlags();
  }, [captureSnapshot, endTextHistoryBurst, updateHistoryFlags]);

  /** Replace all content with a snapshot, clearing transient selection/erase. */
  const applySnapshot = useCallback((snap: NotebookSnapshot) => {
    const next = cloneSnapshot(snap);
    onStrokesChangeRef.current(next.strokes);
    onImagesChangeRef.current(next.images);
    onTextChangeRef.current(snap.text);
    selectedIdsRef.current = new Set();
    setSelectedIds(new Set());
    erasedIdsRef.current.clear();
    suppressedEraseIdsRef.current.clear();
    lastErasePointRef.current = null;
    if (eraseRenderFrameRef.current !== null) cancelAnimationFrame(eraseRenderFrameRef.current);
    eraseRenderFrameRef.current = null;
    if (eraseCursorFrameRef.current !== null) cancelAnimationFrame(eraseCursorFrameRef.current);
    eraseCursorFrameRef.current = null;
    pendingEraseCursorPointRef.current = null;
    setErasedIds(new Set());
    setErasePoint(null);
  }, []);

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    endTextHistoryBurst();
    pushRedoSnapshot(captureSnapshot());
    applySnapshot(undoStackRef.current.pop()!);
    updateHistoryFlags();
  }, [captureSnapshot, applySnapshot, endTextHistoryBurst, pushRedoSnapshot, updateHistoryFlags]);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    endTextHistoryBurst();
    pushUndoSnapshot(captureSnapshot());
    applySnapshot(redoStackRef.current.pop()!);
    updateHistoryFlags();
  }, [captureSnapshot, applySnapshot, endTextHistoryBurst, pushUndoSnapshot, updateHistoryFlags]);

  /** Text edit — coalesce a typing burst into one undo entry (leading edge). */
  const handleTextChange = useCallback(
    (next: string) => {
      if (next === textRef.current) return;
      if (!textBurstRef.current) {
        pushUndoSnapshot(captureSnapshot());
        redoStackRef.current = [];
        textBurstRef.current = true;
        updateHistoryFlags();
      }
      if (textHistoryTimerRef.current) clearTimeout(textHistoryTimerRef.current);
      textHistoryTimerRef.current = setTimeout(endTextHistoryBurst, TEXT_HISTORY_DEBOUNCE_MS);
      onTextChangeRef.current(next);
    },
    [captureSnapshot, endTextHistoryBurst, pushUndoSnapshot, updateHistoryFlags],
  );

  const findImageAtPoint = useCallback((point: NotePoint) => {
    for (let index = imagesRef.current.length - 1; index >= 0; index -= 1) {
      const image = imagesRef.current[index];
      if (
        point.x >= image.x &&
        point.x <= image.x + image.width &&
        point.y >= image.y &&
        point.y <= image.y + image.height
      ) {
        return image;
      }
    }
    return null;
  }, []);

  const selectImage = useCallback((id: string) => {
    const image = imagesRef.current.find((img) => img.id === id);
    if (!image) return;
    if (__DEV__) {
      console.info('[NotebookSelection] image-tap-select', { id, mode: modeRef.current, viaHandler: 'NotebookImageObject Tap gesture -> onSelect' });
    }
    selectedIdsRef.current = new Set([id]);
    setSelectedIds(new Set([id]));
  }, []);

  /**
   * Lock page scrolling for the duration of a direct manipulation, and arm a
   * debounced auto-release. The release is re-armed on every gesture update, so the
   * lock always clears shortly after the drag stops — even for a corner-handle drag
   * whose end callback can be missed when its small view re-positions mid-gesture.
   */
  const holdImageScrollLock = useCallback(() => {
    setImageManipulationActive(true);
    imageManipulationActiveRef.current = true;
    applyNotebookScrollEnabled();
    if (imageScrollLockTimerRef.current) clearTimeout(imageScrollLockTimerRef.current);
    imageScrollLockTimerRef.current = setTimeout(() => {
      imageScrollLockTimerRef.current = null;
      imageManipulationActiveRef.current = false;
      setImageManipulationActive(false);
      applyNotebookScrollEnabled();
    }, 220);
  }, [applyNotebookScrollEnabled]);

  const beginImageGesture = useCallback(
    (id: string) => {
      const image = imagesRef.current.find((img) => img.id === id);
      if (!image) return;
      selectedIdsRef.current = new Set([id]);
      setSelectedIds(new Set([id]));
      holdImageScrollLock();
      imageGestureStartRef.current = {
        id,
        image: cloneImage(image),
        snapshot: captureSnapshot(),
        changed: false,
        committed: false,
      };
    },
    [captureSnapshot, holdImageScrollLock],
  );

  /**
   * Push the pre-gesture snapshot exactly once per interaction, on the FIRST real
   * change (leading edge). This makes the undo entry depend only on an update
   * actually happening — never on a gesture's onEnd/onFinalize, which can be missed
   * when a handle view re-positions mid-drag. Repeated drags each capture a fresh
   * baseline in beginImageGesture, so each completed drag is exactly one undo step.
   */
  const commitImageHistoryOnce = useCallback(() => {
    const start = imageGestureStartRef.current;
    if (!start || start.committed) return;
    start.committed = true;
    endTextHistoryBurst();
    pushUndoSnapshot(start.snapshot);
    redoStackRef.current = [];
    updateHistoryFlags();
  }, [endTextHistoryBurst, pushUndoSnapshot, updateHistoryFlags]);

  /**
   * Single combined transform for one direct-manipulation interaction.
   *
   * `translationX/Y` is the cumulative one-finger pan and `scale` the cumulative
   * pinch scale, both relative to the geometry captured at gesture start. They are
   * applied together — scale around the baseline centre (aspect preserved, min/max
   * clamped), then translate, then clamp on-page — so pan and pinch never fight and
   * a two-finger pinch does not jump. One interaction commits exactly one undo step.
   */
  const updateImageTransform = useCallback(
    (id: string, translationX: number, translationY: number, scale: number) => {
      const start = imageGestureStartRef.current;
      if (!start || start.id !== id) return;
      const width = containerSizeRef.current.width;
      const canvasH = pageGeomRef.current.canvasHeight;
      const scaled = resizeImageAroundCenter(start.image, scale, width, canvasH);
      const nextImage = clampImageGeometry(
        { ...scaled, x: scaled.x + translationX, y: scaled.y + translationY },
        width,
        canvasH,
      );
      const changed =
        Math.abs(nextImage.x - start.image.x) > 0.5 ||
        Math.abs(nextImage.y - start.image.y) > 0.5 ||
        Math.abs(nextImage.width - start.image.width) > 0.5 ||
        Math.abs(nextImage.height - start.image.height) > 0.5;
      if (!changed) return;
      start.changed = true;
      commitImageHistoryOnce();
      holdImageScrollLock();
      onImagesChangeRef.current(
        imagesRef.current.map((img) => (img.id === id ? nextImage : img)),
      );
    },
    [commitImageHistoryOnce, holdImageScrollLock],
  );

  /**
   * Corner-handle resize. `translationX/Y` is the cumulative drag of the grabbed
   * corner from the gesture start; the opposite corner stays pinned and aspect is
   * preserved. Shares the same begin/end interaction as move/pinch, so it commits
   * exactly one undo snapshot per completed drag.
   */
  const resizeImageFromCornerGesture = useCallback(
    (id: string, corner: ImageCorner, translationX: number, translationY: number) => {
      const start = imageGestureStartRef.current;
      if (!start || start.id !== id) return;
      const nextImage = resizeImageFromCorner(
        start.image,
        corner,
        translationX,
        translationY,
        containerSizeRef.current.width,
        pageGeomRef.current.canvasHeight,
      );
      const changed =
        Math.abs(nextImage.x - start.image.x) > 0.5 ||
        Math.abs(nextImage.y - start.image.y) > 0.5 ||
        Math.abs(nextImage.width - start.image.width) > 0.5 ||
        Math.abs(nextImage.height - start.image.height) > 0.5;
      if (!changed) return;
      start.changed = true;
      commitImageHistoryOnce();
      holdImageScrollLock();
      onImagesChangeRef.current(
        imagesRef.current.map((img) => (img.id === id ? nextImage : img)),
      );
    },
    [commitImageHistoryOnce, holdImageScrollLock],
  );

  // History is committed on the first change (commitImageHistoryOnce); end-of-gesture
  // (when it fires) releases the scroll lock immediately and clears the baseline.
  const endImageGesture = useCallback(() => {
    if (imageScrollLockTimerRef.current) {
      clearTimeout(imageScrollLockTimerRef.current);
      imageScrollLockTimerRef.current = null;
    }
    imageManipulationActiveRef.current = false;
    setImageManipulationActive(false);
    applyNotebookScrollEnabled();
    imageGestureStartRef.current = null;
  }, [applyNotebookScrollEnabled]);

  // ---- Selection engine helpers ----

  const commitLasso = useCallback(() => {
    const lasso = lassoPointsRef.current;
    if (lasso.length < 3) return;
    const newIds = new Set<string>();
    for (const stroke of strokesRef.current) {
      if (stroke.points.some((pt) => pointInPolygon(pt, lasso))) newIds.add(stroke.id);
    }
    for (const img of imagesRef.current) {
      const corners: NotePoint[] = [
        { x: img.x, y: img.y },
        { x: img.x + img.width, y: img.y },
        { x: img.x, y: img.y + img.height },
        { x: img.x + img.width, y: img.y + img.height },
      ];
      if (corners.some((c) => pointInPolygon(c, lasso))) newIds.add(img.id);
    }
    selectedIdsRef.current = newIds;
    setSelectedIds(new Set(newIds));
  }, []);

  const commitRectSelection = useCallback(() => {
    const start = selectionRectStartRef.current;
    const end = selectionRectEndRef.current;
    if (!start || !end) return;
    const rect = rectFromPoints(start, end);
    if (rect.width < 3 || rect.height < 3) return;
    const newIds = new Set<string>();
    for (const stroke of strokesRef.current) {
      if (stroke.points.some((pt) => pointInRect(pt, rect))) newIds.add(stroke.id);
    }
    for (const img of imagesRef.current) {
      if (rectsOverlap(rect, imageRect(img))) newIds.add(img.id);
    }
    selectedIdsRef.current = newIds;
    setSelectedIds(new Set(newIds));
  }, []);

  const commitMove = useCallback(() => {
    const { x: dx, y: dy } = selectionMoveOffsetRef.current;
    if (dx === 0 && dy === 0) return;
    const ids = selectedIdsRef.current;
    const movesStroke = strokesRef.current.some((stroke) => ids.has(stroke.id));
    const movesImage = imagesRef.current.some((image) => ids.has(image.id));
    if (!movesStroke && !movesImage) return;
    recordHistory();
    const newStrokes = strokesRef.current.map((s) =>
      ids.has(s.id)
        ? { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
        : s,
    );
    onStrokesChangeRef.current(newStrokes);
    const newImages = imagesRef.current.map((img) =>
      ids.has(img.id) ? { ...img, x: img.x + dx, y: img.y + dy } : img,
    );
    onImagesChangeRef.current(newImages);
  }, [recordHistory]);

  // Commit the in-progress stroke (read synchronously from the active-ink host)
  // as its own new stroke, then clear it. A 1-point stroke is kept — it renders as a dot.
  const commitStroke = useCallback(() => {
    const pts = activeInkRef.current?.getPoints() ?? [];
    if (pts.length > 0) {
      const isHighlighter = modeRef.current === 'highlight';
      const stroke: NoteStroke = {
        id: makeStrokeId(),
        tool: isHighlighter ? 'highlighter' : 'pen',
        color: isHighlighter ? highlighterColorRef.current : penColorRef.current,
        width: isHighlighter ? highlighterWidthRef.current : penWidthRef.current,
        opacity: isHighlighter ? 0.34 : 1,
        // Copy on commit so later ActiveInk clears cannot mutate the saved stroke.
        points: pts.map((point) => ({ ...point })),
        createdAt: new Date().toISOString(),
      };
      recordHistory();
      onStrokesChangeRef.current([...strokesRef.current, stroke]);
    }
    activeInkRef.current?.clear();
  }, [recordHistory]);

  const publishEraseSuppression = useCallback((immediate = false) => {
    const publish = () => {
      eraseRenderFrameRef.current = null;
      setErasedIds(new Set(suppressedEraseIdsRef.current));
    };
    if (immediate) {
      if (eraseRenderFrameRef.current !== null) cancelAnimationFrame(eraseRenderFrameRef.current);
      publish();
      return;
    }
    if (eraseRenderFrameRef.current === null) {
      eraseRenderFrameRef.current = requestAnimationFrame(publish);
    }
  }, []);

  // The cursor is decorative. Coalesce it to a frame so high-frequency Pencil
  // samples never re-render the full SVG merely to move this ring.
  const publishEraseCursor = useCallback((point: NotePoint | null, immediate = false) => {
    const publish = () => {
      eraseCursorFrameRef.current = null;
      setErasePoint(pendingEraseCursorPointRef.current);
    };
    pendingEraseCursorPointRef.current = point;
    if (immediate) {
      if (eraseCursorFrameRef.current !== null) cancelAnimationFrame(eraseCursorFrameRef.current);
      eraseCursorFrameRef.current = null;
      publish();
      return;
    }
    if (eraseCursorFrameRef.current === null) {
      eraseCursorFrameRef.current = requestAnimationFrame(publish);
    }
  }, []);

  // Each sampled movement represents a swept capsule, not a discrete point.
  // Bounds are precomputed only when committed strokes change; the expensive
  // segment test therefore runs only for nearby candidates during a drag.
  const eraseAt = useCallback((from: NotePoint, to: NotePoint) => {
    let changed = false;
    for (const { stroke, bounds } of strokeHitIndexRef.current) {
      if (erasedIdsRef.current.has(stroke.id)) continue;
      const threshold = eraserRadiusRef.current + Math.max(1, stroke.width / 2);
      if (!sweepMayReachBounds(from, to, bounds, threshold)) continue;
      if (strokeNearSweep(stroke, from, to, eraserRadiusRef.current)) {
        erasedIdsRef.current.add(stroke.id);
        suppressedEraseIdsRef.current.add(stroke.id);
        changed = true;
      }
    }
    if (changed) publishEraseSuppression();
  }, [publishEraseSuppression]);

  const commitErase = useCallback(() => {
    if (erasedIdsRef.current.size > 0) {
      const removed = new Set(erasedIdsRef.current);
      recordHistory();
      onStrokesChangeRef.current(strokesRef.current.filter((s) => !removed.has(s.id)));
    }
    erasedIdsRef.current.clear();
    lastErasePointRef.current = null;
    // Do NOT clear visual suppression here. The parent/cache update is
    // asynchronous; clearing first was the one-frame resurrection path.
    publishEraseSuppression(true);
    publishEraseCursor(null, true);
  }, [publishEraseCursor, publishEraseSuppression, recordHistory]);

  /**
   * End the live stroke: commit whichever drag was in progress (the other
   * commit is a no-op) and clear every piece of in-progress state. Idempotent —
   * safe to call from onTouchesUp, onTouchesCancelled and onFinalize together.
   */
  const endStroke = useCallback(() => {
    if (!drawingRef.current) return;
    if (__DEV__ && (modeRef.current === 'write' || modeRef.current === 'highlight')) {
      console.info('[NotebookImageAction] ink-stroke-end', {
        startedOverImageId: strokeStartedOverImageRef.current,
        moveSampleCount: strokeMoveSampleCountRef.current,
      });
    }
    drawingRef.current = false;
    activeTouchIdRef.current = null;
    endStylusScrollLock({ grace: true });
    if (modeRef.current === 'select') {
      if (selectActionRef.current === 'lasso') commitLasso();
      else if (selectActionRef.current === 'rect') commitRectSelection();
      else if (selectActionRef.current === 'move') commitMove();
      selectActionRef.current = 'idle';
      lassoPointsRef.current = [];
      selectionRectStartRef.current = null;
      selectionRectEndRef.current = null;
      setLassoPoints([]);
      setSelectionRect(null);
      selectionMoveOffsetRef.current = { x: 0, y: 0 };
      setSelectionMoveOffset({ x: 0, y: 0 });
      return;
    }
    commitStroke();
    commitErase();
    restoreTemporaryEraserIfNeeded();
  }, [commitLasso, commitMove, commitRectSelection, commitStroke, commitErase, restoreTemporaryEraserIfNeeded, endStylusScrollLock]);

  /** Discard the in-progress stroke without committing it (used on tool change). */
  const abortStroke = useCallback(() => {
    drawingRef.current = false;
    activeTouchIdRef.current = null;
    activeInkRef.current?.clear();
    const abortedEraseIds = new Set(erasedIdsRef.current);
    erasedIdsRef.current.clear();
    for (const id of abortedEraseIds) suppressedEraseIdsRef.current.delete(id);
    lastErasePointRef.current = null;
    selectActionRef.current = 'idle';
    lassoPointsRef.current = [];
    selectionRectStartRef.current = null;
    selectionRectEndRef.current = null;
    selectionMoveOffsetRef.current = { x: 0, y: 0 };
    imageGestureStartRef.current = null;
    endStylusScrollLock({ grace: false });
    publishEraseCursor(null, true);
    publishEraseSuppression(true);
    setLassoPoints([]);
    setSelectionRect(null);
    setSelectionMoveOffset({ x: 0, y: 0 });
  }, [endStylusScrollLock, publishEraseCursor, publishEraseSuppression]);

  const touchToCanvasPoint = useCallback((touchX: number, touchY: number) => {
    return screenToCanvasPoint(
      touchX,
      touchY,
      scrollOffsetYRef.current,
      canvasScaleRef.current,
      canvasTranslateXRef.current,
    );
  }, []);

  /**
   * The draw / erase gesture.
   *
   * `manualActivation` lets us inspect the pointer type on touch-down before
   * deciding what the drag means: confirmed stylus input activates the gesture
   * (drawing or erasing), while every non-stylus pointer fails immediately so the
   * underlying ScrollView scrolls instead — that is what keeps finger scrolling
   * working with no manual mode switch.
   *
   * Stylus activation also locks ScrollView synchronously via setNativeProps so
   * a resting palm cannot scroll during the React render gap.
   */
  const drawGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .manualActivation(true)
        .onTouchesDown((event, manager) => {
          // An extra touch landing on top of a live stroke (e.g. a resting
          // palm) — keep the current stroke and ignore the extra finger.
          // Scroll is already natively locked for the stylus session.
          if (event.numberOfTouches > 1) return;

          const activeMode = modeRef.current;
          const touch = event.changedTouches[0] ?? event.allTouches[0];
          const point = touch ? touchToCanvasPoint(touch.x, touch.y) : null;

          // The floating Copy/Delete action bar renders as a sibling inside
          // this same gesture-wrapped canvas, positioned just outside the
          // image's own rect (above or below it) — from findImageAtPoint's
          // perspective a touch on those buttons IS "blank paper". Proven
          // root cause of "Copy/Delete unreliable": this touch-down handler
          // fires (and, below, deselected) for that touch too, unmounting
          // the action bar (imageActionBar depends on selectedIds) before
          // the button's own onPress can fire on touch-up.
          //
          // Bounds are recomputed here, inline, from the same refs the rest
          // of this handler already reads (selectedIdsRef/imagesRef/
          // selectionMoveOffsetRef/containerSizeRef/pageGeomRef — all
          // declared well before this gesture's useMemo, unlike a ref that
          // mirrors the imageActionBar render-time useMemo, which crashed
          // ("imageActionBarRef.current of undefined") in physical testing.
          // Kept in exact sync with imageActionBar's own layout math (same
          // clamp/gap/edge constants) rather than reusing that memo's
          // OUTPUT, precisely to avoid depending on it from this closure.
          const bar = (() => {
            if (!editableRef.current || selectedIdsRef.current.size !== 1) return null;
            const selectedId = Array.from(selectedIdsRef.current)[0];
            const img = imagesRef.current.find((image) => image.id === selectedId);
            if (!img) return null;
            const cw = containerSizeRef.current.width;
            const ch = pageGeomRef.current.canvasHeight;
            if (cw <= 0 || ch <= 0) return null;
            const offset = selectionMoveOffsetRef.current;
            const leftWithOffset = img.x + offset.x;
            const topWithOffset = img.y + offset.y;
            const centerX = leftWithOffset + img.width / 2;
            const maxLeft = Math.max(IMAGE_ACTION_BAR_EDGE, cw - IMAGE_ACTION_BAR_WIDTH - IMAGE_ACTION_BAR_EDGE);
            const left = clamp(centerX - IMAGE_ACTION_BAR_WIDTH / 2, IMAGE_ACTION_BAR_EDGE, maxLeft);
            const above = topWithOffset - IMAGE_ACTION_BAR_HEIGHT - IMAGE_ACTION_BAR_GAP;
            const below = topWithOffset + img.height + IMAGE_ACTION_BAR_GAP;
            const preferredTop = above < IMAGE_ACTION_BAR_EDGE ? below : above;
            const maxTop = Math.max(IMAGE_ACTION_BAR_EDGE, ch - IMAGE_ACTION_BAR_HEIGHT - IMAGE_ACTION_BAR_EDGE);
            const top = clamp(preferredTop, IMAGE_ACTION_BAR_EDGE, maxTop);
            return { left, top };
          })();
          const barHit =
            point !== null && bar !== null &&
            point.x >= bar.left && point.x <= bar.left + IMAGE_ACTION_BAR_WIDTH &&
            point.y >= bar.top && point.y <= bar.top + IMAGE_ACTION_BAR_HEIGHT;

          // A tap on blank paper deselects — checked FIRST, before any
          // mode gate, because several modes (Scroll, Type, and crucially
          // Insert — the mode the toolbar stays in right after placing an
          // image, since nothing resets it back to Write) return early via
          // manager.fail() a few lines below and never reached this at all
          // in the previous attempt. Select mode is still excluded: it owns
          // deselection itself further down using the full selection
          // bounding box (strokes + images, with padding), which is more
          // permissive than "exactly on an image" — running this check for
          // Select would wrongly drop a stroke-only or padding-zone
          // selection before that logic decides whether the tap landed
          // inside it.
          if (__DEV__ && selectedIdsRef.current.size > 0) {
            const hitImage = point ? findImageAtPoint(point) : null;
            const before = Array.from(selectedIdsRef.current);
            const willDeselect = activeMode !== 'select' && point !== null && !hitImage && !barHit;
            console.info('[NotebookSelection] touch-down-with-selection', {
              mode: activeMode,
              pointerType: event.pointerType,
              numberOfTouches: event.numberOfTouches,
              selectedIdsBefore: before,
              hitImageId: hitImage?.id ?? null,
              barHit,
              willDeselect,
            });
          }
          if (activeMode !== 'select' && point && selectedIdsRef.current.size > 0 && !findImageAtPoint(point) && !barHit) {
            selectedIdsRef.current = new Set();
            setSelectedIds(new Set());
            if (__DEV__) {
              console.info('[NotebookSelection] deselected-on-blank-tap', { mode: activeMode });
            }
          }

          // The action bar is UI chrome, never canvas content, in every
          // mode — including Select, where (unlike the deselect check
          // above) nothing else would have stopped this gesture from
          // activating on it: findImageAtPoint is null there (no image),
          // so Select mode's own tap-outside-image handling below would
          // otherwise treat a button tap as the start of a fresh
          // rect/lasso selection, consuming the touch before the button's
          // native onPress ever gets it.
          if (barHit) {
            manager.fail();
            return;
          }

          // First touch of a fresh gesture. If a previous stroke somehow never
          // finalized, commit and clear it NOW, so this new touch starts a
          // brand-new stroke and can never extend the old one.
          if (drawingRef.current) endStroke();

          if (activeMode !== 'write' && activeMode !== 'highlight' && activeMode !== 'erase' && activeMode !== 'select') {
            manager.fail();
            return;
          }

          // Draw/erase modes require a stylus; select mode accepts any pointer.
          // While a stylus session / palm grace is active, non-stylus touches
          // still fail the draw gesture but ScrollView stays locked.
          if (activeMode !== 'select' && event.pointerType !== PointerType.STYLUS) {
            manager.fail();
            return;
          }

          if (!touch || !point) {
            manager.fail();
            return;
          }

          // An image normally claims touches inside its bounds (its own
          // tap/pan gestures handle select/move — see failIfStylus in
          // NotebookImageObjectBase, the other half of this contract). The
          // one exception is a stylus actively drawing/highlighting/erasing:
          // Apple Pencil must ink straight through an image, never be
          // treated as touching it. Select mode is NOT exempted here — a
          // Pencil tap in Select mode should still select the image, same
          // as a finger would.
          const stylusDrawingOverImage = activeMode !== 'select' && event.pointerType === PointerType.STYLUS;
          const hitImageForInkRouting = findImageAtPoint(point);
          if (__DEV__ && hitImageForInkRouting) {
            console.info('[NotebookImageAction] touch-on-image', {
              imageId: hitImageForInkRouting.id,
              pointerType: event.pointerType,
              mode: activeMode,
              routedTo: stylusDrawingOverImage ? 'ink' : 'image-gesture',
            });
          }
          if (hitImageForInkRouting && !stylusDrawingOverImage) {
            manager.fail();
            return;
          }

          manager.activate();
          if (__DEV__) {
            console.info('[NotebookImageAction] canvas-gesture-activated', {
              touchId: touch.id,
              startedOverImageId: hitImageForInkRouting?.id ?? null,
              pointerType: event.pointerType,
              mode: activeMode,
            });
          }
          drawingRef.current = true;
          activeTouchIdRef.current = touch.id;
          beginStylusScrollLock();

          if (activeMode === 'select') {
            const ids = selectedIdsRef.current;
            let inBounds = false;
            if (ids.size > 0) {
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (const s of strokesRef.current) {
                if (!ids.has(s.id)) continue;
                for (const p of s.points) {
                  if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
                  if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
                }
              }
              for (const img of imagesRef.current) {
                if (!ids.has(img.id)) continue;
                if (img.x < minX) minX = img.x; if (img.y < minY) minY = img.y;
                if (img.x + img.width > maxX) maxX = img.x + img.width;
                if (img.y + img.height > maxY) maxY = img.y + img.height;
              }
              const pad = 12;
              inBounds = Number.isFinite(minX) &&
                point.x >= minX - pad && point.x <= maxX + pad &&
                point.y >= minY - pad && point.y <= maxY + pad;
            }
            if (inBounds) {
              selectActionRef.current = 'move';
              selectionMoveStartRef.current = point;
              selectionMoveOffsetRef.current = { x: 0, y: 0 };
            } else {
              if (selectionShapeRef.current === 'rect') {
                selectActionRef.current = 'rect';
                selectionRectStartRef.current = point;
                selectionRectEndRef.current = point;
                setSelectionRect(rectFromPoints(point, point));
              } else {
                selectActionRef.current = 'lasso';
                lassoPointsRef.current = [point];
                setLassoPoints([point]);
              }
              selectedIdsRef.current = new Set();
              setSelectedIds(new Set());
            }
            return;
          }

          if (activeMode === 'write' || activeMode === 'highlight') {
            strokeMoveSampleCountRef.current = 0;
            strokeStartedOverImageRef.current = hitImageForInkRouting?.id ?? null;
            activeInkRef.current?.begin(point);
          } else {
            erasedIdsRef.current.clear();
            lastErasePointRef.current = point;
            publishEraseCursor(point);
            eraseAt(point, point);
          }
        })
        .onTouchesMove((event) => {
          if (!drawingRef.current) return;
          const touch =
            event.changedTouches.find((t) => t.id === activeTouchIdRef.current) ??
            event.allTouches.find((t) => t.id === activeTouchIdRef.current);
          if (!touch) return;
          const point = touchToCanvasPoint(touch.x, touch.y);

          if (modeRef.current === 'select') {
            if (selectActionRef.current === 'lasso') {
              const pts = lassoPointsRef.current;
              const last = pts[pts.length - 1];
              if (last && Math.hypot(point.x - last.x, point.y - last.y) < MIN_POINT_DISTANCE) return;
              const next = [...pts, point];
              lassoPointsRef.current = next;
              setLassoPoints(next);
            } else if (selectActionRef.current === 'rect') {
              const start = selectionRectStartRef.current;
              if (!start) return;
              selectionRectEndRef.current = point;
              setSelectionRect(rectFromPoints(start, point));
            } else if (selectActionRef.current === 'move') {
              const start = selectionMoveStartRef.current;
              const offset = { x: point.x - start.x, y: point.y - start.y };
              selectionMoveOffsetRef.current = offset;
              setSelectionMoveOffset({ ...offset });
            }
            return;
          }

          if (modeRef.current === 'write' || modeRef.current === 'highlight') {
            strokeMoveSampleCountRef.current += 1;
            activeInkRef.current?.append(point);
          } else if (modeRef.current === 'erase') {
            const previous = lastErasePointRef.current ?? point;
            lastErasePointRef.current = point;
            publishEraseCursor(point);
            eraseAt(previous, point);
          }
        })
        .onTouchesUp((event) => {
          if (!drawingRef.current) return;
          if (event.changedTouches.some((t) => t.id === activeTouchIdRef.current)) {
            endStroke();
          }
        })
        .onTouchesCancelled((event) => {
          if (!drawingRef.current) return;
          if (event.changedTouches.some((t) => t.id === activeTouchIdRef.current)) {
            endStroke();
          }
        })
        .onFinalize(() => {
          endStroke();
        }),
    [beginStylusScrollLock, endStroke, eraseAt, findImageAtPoint, publishEraseCursor, touchToCanvasPoint],
  );

  const beginPageZoom = useCallback(() => {
    pinchActiveRef.current = true;
    applyNotebookScrollEnabled();
  }, [applyNotebookScrollEnabled]);

  const settlePageZoom = useCallback(() => {
    const y = pendingZoomScroll.current;
    if (y === null) return;
    pendingZoomScroll.current = null;
    scrollOffsetYRef.current = y;
    scrollViewRef.current?.scrollTo({ y, animated: false });
    if (Math.abs(nativeScrollY.value - y) < 0.5) zoomHolding.value = false;
    pinchActiveRef.current = false;
    applyNotebookScrollEnabled();
  }, [applyNotebookScrollEnabled, nativeScrollY, zoomHolding]);

  const commitPageZoom = useCallback((scale: number, x: number, y: number) => {
    canvasTranslateXRef.current = x;
    pendingZoomScroll.current = y;
    if (scale === canvasScaleRef.current) {
      settlePageZoom();
    } else {
      canvasScaleRef.current = scale;
      setCanvasScale(scale);
      // The paper's onLayout settles the native offset after the height commits.
    }
  }, [settlePageZoom]);

  /** Active pinch changes only a UI-thread transform; document geometry stays fixed. */
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onStart((event) => {
          if (zoomBlocked.value) return;
          zoomActive.value = true;
          zoomStart.value = {
            scale: zoomScale.value, x: zoomX.value,
            y: zoomHolding.value ? zoomY.value : nativeScrollY.value,
            focalX: event.focalX, focalY: event.focalY,
          };
          zoomY.value = zoomStart.value.y;
          zoomHolding.value = true;
          runOnJS(beginPageZoom)();
        })
        .onUpdate((event) => {
          if (!zoomActive.value || zoomBlocked.value) return;
          const start = zoomStart.value;
          const geometry = zoomGeometry.value;
          const next = applyPinchZoomFromStart({
            startScale: start.scale, startTranslateX: start.x,
            startScrollY: start.y, startFocalX: start.focalX,
            startFocalY: start.focalY, focalX: event.focalX,
            focalY: event.focalY, gestureScale: event.scale,
            viewportWidth: geometry.width, viewportHeight: geometry.height,
            contentWidth: geometry.width, contentHeight: geometry.contentHeight,
          });
          zoomScale.value = next.scale;
          zoomX.value = next.translateX;
          zoomY.value = next.scrollY;
        })
        .onFinalize(() => {
          if (!zoomActive.value) return;
          zoomActive.value = false;
          runOnJS(commitPageZoom)(zoomScale.value, zoomX.value, zoomY.value);
        }),
    [beginPageZoom, commitPageZoom, nativeScrollY, zoomActive, zoomBlocked, zoomGeometry, zoomHolding, zoomScale, zoomStart, zoomX, zoomY],
  );

  const notebookGestures = useMemo(
    () => Gesture.Simultaneous(pinchGesture, drawGesture),
    [pinchGesture, drawGesture],
  );

  // A tool change must never leave a half-finished stroke behind for the next
  // gesture to extend — drop any in-progress stroke whenever the mode changes.
  useEffect(() => {
    abortStroke();
  }, [mode, abortStroke]);

  // Context row swaps fade rather than cut, per the toolbar motion spec.
  // MUST use the native driver: contextFade is combined with `toolbarTransition`
  // (native-driven, line ~1651) via Animated.multiply for the context panel's
  // opacity, so the shared opacity node lives on the native side. Animating
  // contextFade with the JS driver threw "Attempting to run JS driven animation
  // on animated node that has been moved to native earlier", which crashed
  // NotebookCanvas (visible as the garbled Mini screen). Opacity is
  // native-driver-safe, so both animations now agree.
  useEffect(() => {
    contextFade.setValue(0);
    Animated.timing(contextFade, {
      toValue: 1,
      duration: TOOLBAR_ANIMATION_MS,
      easing: TOOLBAR_EASING,
      useNativeDriver: true,
    }).start();
  }, [mode, contextFade]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (textHistoryTimerRef.current) clearTimeout(textHistoryTimerRef.current);
    },
    [],
  );

  // Apple Pencil double-tap enters a temporary eraser from Pen/Highlighter.
  // It restores only after the Pencil gesture ends, so continuous erasing
  // works while the Pencil stays down.
  const handleDoubleTap = useCallback(() => {
    const current = modeRef.current;
    if (__DEV__) {
      console.info('[NotebookViewport] pencil-double-tap', {
        toolBefore: current,
        scrollY: scrollOffsetYRef.current,
        strokeActive: stylusStrokeLockRef.current,
        palmGrace: palmGraceActiveRef.current,
      });
    }
    armPostUnlockWatch('double-tap');
    if (current === 'write' || current === 'highlight') {
      previousDrawingToolRef.current = current;
      temporaryEraserRef.current = true;
      setTemporaryEraser(true);
      modeRef.current = 'erase';
      setMode('erase');
      showToolToast('erase');
      return;
    }
    if (current === 'erase') {
      const restored = temporaryEraserRef.current
        ? previousDrawingToolRef.current
        : previousDrawingToolRef.current ?? 'write';
      temporaryEraserRef.current = false;
      setTemporaryEraser(false);
      modeRef.current = restored;
      setMode(restored);
      showToolToast(restored);
    }
  }, [armPostUnlockWatch, showToolToast]);

  useEffect(() => {
    if (!editable) return;
    // No-op subscription in Expo Go / web / Android — callback simply never fires.
    return addPencilDoubleTapListener(handleDoubleTap);
  }, [editable, handleDoubleTap]);

  const pageForScroll = useCallback((scrollY: number) => {
    const { pageStride: stride, totalPages: tp } = pageGeomRef.current;
    const scale = canvasScaleRef.current || NOTEBOOK_DEFAULT_SCALE;
    const viewportH = containerSizeRef.current.height || 0;
    const centerY = (scrollY + viewportH / 2) / scale;
    return clamp(Math.floor(centerY / Math.max(stride, 1)) + 1, 1, tp);
  }, []);

  const clearPage = useCallback(() => {
    if (strokes.length === 0 && text.length === 0 && images.length === 0) return;
    // Use the page indicator's scale-aware target; object assignment stays unchanged.
    const { pageStride: stride, pageHeight: ph } = pageGeomRef.current;
    const pageIdx = pageForScroll(scrollOffsetYRef.current) - 1;
    const bandTop = pageIdx * stride;
    const bandBottom = bandTop + ph;
    const strokeCenterY = (s: NoteStroke) => {
      let mn = Infinity;
      let mx = -Infinity;
      for (const p of s.points) {
        if (p.y < mn) mn = p.y;
        if (p.y > mx) mx = p.y;
      }
      return mn === Infinity ? 0 : (mn + mx) / 2;
    };
    const remainingStrokes = strokes.filter((s) => {
      const c = strokeCenterY(s);
      return c < bandTop || c >= bandBottom;
    });
    const remainingImages = images.filter((im) => {
      const c = im.y + im.height / 2;
      return c < bandTop || c >= bandBottom;
    });
    // Typed text is a single continuous field (not page-split); only clear it
    // when clearing page 1, where the text begins.
    const clearsText = pageIdx === 0 && text.length > 0;
    if (
      remainingStrokes.length === strokes.length &&
      remainingImages.length === images.length &&
      !clearsText
    ) {
      return;
    }
    Alert.alert(
      t('tools.clearPage'),
      t('tools.clearPageDetail', { typed: pageIdx === 0 ? t('tools.andTyped') : '', page: pageIdx + 1 }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.clear'),
          style: 'destructive',
          onPress: () => {
            recordHistory();
            if (remainingStrokes.length !== strokes.length) onStrokesChange(remainingStrokes);
            if (remainingImages.length !== images.length) onImagesChange(remainingImages);
            if (clearsText) onTextChange('');
            selectedIdsRef.current = new Set();
            setSelectedIds(new Set());
          },
        },
      ],
    );
  }, [strokes, text, images, onStrokesChange, onTextChange, onImagesChange, recordHistory, pageForScroll, t]);

  const deleteSelectedObjects = useCallback(() => {
    if (__DEV__) console.info('[NotebookImageAction] delete callback-entered', { selectedIds: Array.from(selectedIdsRef.current) });
    const ids = selectedIdsRef.current;
    if (ids.size === 0) {
      if (__DEV__) console.info('[NotebookImageAction] delete callback-completed', { result: 'no-op: empty selection' });
      return false;
    }

    const hasSelectedStroke = strokesRef.current.some((stroke) => ids.has(stroke.id));
    const hasSelectedImage = imagesRef.current.some((image) => ids.has(image.id));
    if (!hasSelectedStroke && !hasSelectedImage) {
      if (__DEV__) console.info('[NotebookImageAction] delete callback-completed', { result: 'no-op: selection ids stale' });
      return false;
    }

    recordHistory();
    if (hasSelectedStroke) {
      onStrokesChangeRef.current(strokesRef.current.filter((stroke) => !ids.has(stroke.id)));
    }
    if (hasSelectedImage) {
      onImagesChangeRef.current(imagesRef.current.filter((image) => !ids.has(image.id)));
    }
    selectedIdsRef.current = new Set();
    setSelectedIds(new Set());
    selectionMoveOffsetRef.current = { x: 0, y: 0 };
    setSelectionMoveOffset({ x: 0, y: 0 });
    if (__DEV__) console.info('[NotebookImageAction] delete callback-completed', { result: 'removed', removedIds: Array.from(ids) });
    return true;
  }, [recordHistory]);

  const handleTrashPress = useCallback(() => {
    if (deleteSelectedObjects()) return;
    clearPage();
  }, [clearPage, deleteSelectedObjects]);

  const duplicateSelected = useCallback(() => {
    if (__DEV__) console.info('[NotebookImageAction] copy callback-entered', { selectedIds: Array.from(selectedIdsRef.current) });
    const ids = selectedIdsRef.current;
    if (ids.size === 0) {
      if (__DEV__) console.info('[NotebookImageAction] copy callback-completed', { result: 'no-op: empty selection' });
      return;
    }
    const OFFSET = 18;
    const newIds = new Set<string>();
    const extraStrokes: NoteStroke[] = [];
    for (const s of strokesRef.current) {
      if (!ids.has(s.id)) continue;
      const newId = makeStrokeId();
      newIds.add(newId);
      extraStrokes.push({
        ...s,
        id: newId,
        points: s.points.map((p) => ({ x: p.x + OFFSET, y: p.y + OFFSET })),
        createdAt: new Date().toISOString(),
      });
    }
    const extraImages: NoteImage[] = [];
    for (const img of imagesRef.current) {
      if (!ids.has(img.id)) continue;
      const newId = makeImageId();
      newIds.add(newId);
      extraImages.push(
        clampImageGeometry(
          { ...img, id: newId, x: img.x + OFFSET, y: img.y + OFFSET, createdAt: new Date().toISOString() },
          containerSizeRef.current.width,
          pageGeomRef.current.canvasHeight,
        ),
      );
    }
    if (extraStrokes.length === 0 && extraImages.length === 0) {
      if (__DEV__) console.info('[NotebookImageAction] copy callback-completed', { result: 'no-op: selection ids stale' });
      return;
    }
    recordHistory();
    if (extraStrokes.length > 0) onStrokesChangeRef.current([...strokesRef.current, ...extraStrokes]);
    if (extraImages.length > 0) onImagesChangeRef.current([...imagesRef.current, ...extraImages]);
    selectedIdsRef.current = newIds;
    setSelectedIds(new Set(newIds));
    if (__DEV__) {
      console.info('[NotebookImageAction] copy callback-completed', {
        result: 'duplicated',
        newIds: Array.from(newIds),
        duplicatedImageUris: extraImages.map((img) => img.uri),
      });
    }
  }, [recordHistory]);

  const pickImage = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.85,
    });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    const MAX_W = 380;
    const aspect = (asset.height ?? MAX_W) / (asset.width ?? MAX_W);
    const displayW = Math.min(MAX_W, asset.width ?? MAX_W);
    const displayH = displayW * aspect;
    // Insert at the CURRENTLY VISIBLE viewport position, in canvas/paper
    // coordinates — never assume scale===1 or scrollOffsetY is already in
    // canvas units. scrollOffsetYRef is the ScrollView's raw contentOffset,
    // i.e. SCREEN-scaled pixels (the paper renders at canvasHeight *
    // canvasScale) — using it directly as a canvas-space y (the previous
    // behavior) put the image at the wrong canvas position by exactly the
    // zoom factor, worst at minimum zoom, which is exactly the physical
    // failure reported (insert while zoomed out on page 2 landed on page 1).
    // Route through the SAME screenToCanvasPoint transform every touch uses,
    // so this always matches wherever the user is actually looking.
    const cs = containerSizeRef.current;
    const displayScreenW = displayW * canvasScaleRef.current;
    const screenX = Math.max(MARGIN_X, (cs.width - displayScreenW) / 2);
    const screenY = 60;
    const canvasAnchor = screenToCanvasPoint(
      screenX,
      screenY,
      scrollOffsetYRef.current,
      canvasScaleRef.current,
      canvasTranslateXRef.current,
    );
    const cx = canvasAnchor.x;
    const cy = canvasAnchor.y;
    const imageId = makeImageId();
    // The picker's asset.uri is transient (picker-owned temp/cache location,
    // not guaranteed to survive relaunch or cache eviction). Copy it into a
    // Youmi Lens-owned durable location before it ever becomes canonical
    // state — see lib/notebookImageStorage.ts. On failure, fall back to the
    // transient URI so this insertion isn't silently dropped (the image
    // still shows for the current session); the dev warning inside
    // persistNotebookImage makes a failed copy diagnosable rather than a
    // silent future data loss.
    const durableUri = await persistNotebookImage(asset.uri, imageId);
    const img: NoteImage = clampImageGeometry(
      {
        id: imageId,
        uri: durableUri ?? asset.uri,
        x: cx,
        y: cy,
        width: displayW,
        height: displayH,
        createdAt: new Date().toISOString(),
      },
      cs.width,
      pageGeomRef.current.canvasHeight,
    );
    recordHistory();
    onImagesChangeRef.current([...imagesRef.current, img]);
    selectedIdsRef.current = new Set([img.id]);
    setSelectedIds(new Set([img.id]));
  }, [recordHistory]);

  const canClear = strokes.length > 0 || images.length > 0 || text.length > 0;

  // Bounding box of all selected objects in canvas coordinates (for the selection overlay).
  const selectionBounds = useMemo(() => {
    if (selectedIds.size === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      if (!selectedIds.has(s.id)) continue;
      for (const p of s.points) {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }
    }
    for (const img of images) {
      if (!selectedIds.has(img.id)) continue;
      if (img.x < minX) minX = img.x; if (img.y < minY) minY = img.y;
      if (img.x + img.width > maxX) maxX = img.x + img.width;
      if (img.y + img.height > maxY) maxY = img.y + img.height;
    }
    if (!Number.isFinite(minX)) return null;
    const pad = 8;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }, [selectedIds, strokes, images]);

  const selectedImageForActions = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const selectedId = Array.from(selectedIds)[0];
    return images.find((image) => image.id === selectedId) ?? null;
  }, [images, selectedIds]);

  // Floating Duplicate/Delete bar position (canvas coordinates) — sits directly
  // above the selected image, horizontally centred over it. Rendered inside the
  // scrolling paper so it tracks the object as it moves/resizes/scrolls. Clamped
  // to the page width and visible canvas height; flips below only when the image
  // is too close to the top edge to leave room above.
  const imageActionBar = useMemo(() => {
    if (!editable || !selectedImageForActions) return null;
    const cw = containerSize.width;
    const ch = pageGeomRef.current.canvasHeight;
    if (cw <= 0 || ch <= 0) return null;
    const leftWithOffset = selectedImageForActions.x + selectionMoveOffset.x;
    const topWithOffset = selectedImageForActions.y + selectionMoveOffset.y;
    const centerX = leftWithOffset + selectedImageForActions.width / 2;
    const maxLeft = Math.max(IMAGE_ACTION_BAR_EDGE, cw - IMAGE_ACTION_BAR_WIDTH - IMAGE_ACTION_BAR_EDGE);
    const left = clamp(
      centerX - IMAGE_ACTION_BAR_WIDTH / 2,
      IMAGE_ACTION_BAR_EDGE,
      maxLeft,
    );
    const above = topWithOffset - IMAGE_ACTION_BAR_HEIGHT - IMAGE_ACTION_BAR_GAP;
    const below = topWithOffset + selectedImageForActions.height + IMAGE_ACTION_BAR_GAP;
    const preferredTop = above < IMAGE_ACTION_BAR_EDGE ? below : above;
    const maxTop = Math.max(IMAGE_ACTION_BAR_EDGE, ch - IMAGE_ACTION_BAR_HEIGHT - IMAGE_ACTION_BAR_EDGE);
    const top = clamp(preferredTop, IMAGE_ACTION_BAR_EDGE, maxTop);
    return { left, top };
  }, [editable, selectedImageForActions, selectionMoveOffset, containerSize.width]);

  // Committed strokes split into unselected (stable) and selected (rendered in a transform group).
  const { unselectedShapes, selectedShapes } = useMemo(
    () => {
      const visible = strokes.filter((s) => !erasedIds.has(s.id));
      const unsel = [
        ...visible.filter((s) => s.tool === 'highlighter' && !selectedIds.has(s.id)).map((s) => <StrokeShape key={s.id} stroke={s} />),
        ...visible.filter((s) => s.tool !== 'highlighter' && !selectedIds.has(s.id)).map((s) => <StrokeShape key={s.id} stroke={s} />),
      ];
      const sel = visible
        .filter((s) => selectedIds.has(s.id))
        .flatMap((s) => [
          <StrokeShape key={`${s.id}_hl`} stroke={{ ...s, width: s.width + 5, color: '#5F86E8', opacity: 0.28 }} />,
          <StrokeShape key={s.id} stroke={s} />,
        ]);
      return { unselectedShapes: unsel, selectedShapes: sel };
    },
    [strokes, erasedIds, selectedIds],
  );

  // ---- Page geometry (continuous canvas divided into A4-like sheets) ----
  const pageWidth = containerSize.width;
  const pageHeight = pageWidth > 0 ? Math.round(pageWidth * PAGE_ASPECT) : PAGE_HEIGHT;
  const pageStride = pageHeight + PAGE_GAP;
  /**
   * Lowest y actually reached by content, used to derive the page count.
   *
   * Strokes and images contribute their real positions. Typed text is ONE
   * global string with no reliable per-line geometry, so it is counted as
   * page-1 content only (a tiny positive y) — never its measured/layer height.
   * Using the TextInput's content/frame height here caused a feedback loop
   * (taller canvas -> taller input -> larger reported height -> more pages)
   * that ran the count up to absurd values like 1 / 112 from a single keystroke.
   */
  const contentBottomY = useMemo(() => {
    let m = 0;
    for (const s of strokes) for (const p of s.points) if (p.y > m) m = p.y;
    for (const im of images) {
      const b = im.y + im.height;
      if (b > m) m = b;
    }
    if (text.length > 0) m = Math.max(m, 1);
    return m;
  }, [strokes, images, text]);
  // Sheets that contain content, plus exactly one trailing blank sheet. A blank
  // notebook is a single page; the moment content reaches the last sheet, the
  // derived count grows by one, so a fresh blank page appears automatically.
  // The min(..., MAX) is a defensive safety net only — normal use never hits it.
  const MAX_NOTEBOOK_PAGES = 999;
  const contentPages = contentBottomY > 0 ? Math.floor(contentBottomY / pageStride) + 1 : 0;
  const totalPages = Math.min(contentPages === 0 ? 1 : contentPages + 1, MAX_NOTEBOOK_PAGES);
  const canvasHeight = totalPages * pageHeight + (totalPages - 1) * PAGE_GAP;
  pageGeomRef.current = { pageHeight, pageStride, totalPages, canvasHeight };
  useEffect(() => {
    zoomGeometry.value = { width: containerSize.width, height: containerSize.height, contentHeight: canvasHeight };
  }, [canvasHeight, containerSize.width, containerSize.height, zoomGeometry]);

  const sheetLineCount = pageHeight > 52 ? Math.floor((pageHeight - 52) / LINE_GAP) : 0;
  const pageSheets = useMemo(
    () =>
      Array.from({ length: totalPages }).map((_, i) => (
        <View
          key={`sheet_${i}`}
          style={[styles.pageSheet, { top: i * pageStride, height: pageHeight }]}
          pointerEvents="none"
        >
          <View style={styles.sheetRuled} pointerEvents="none">
            {Array.from({ length: sheetLineCount }).map((_, j) => (
              <View key={j} style={styles.ruleLine} />
            ))}
          </View>
          <View style={styles.sheetMargin} pointerEvents="none" />
        </View>
      )),
    [totalPages, pageStride, pageHeight, sheetLineCount],
  );

  // ---- Scroll-time page indicator (bottom-right capsule, auto-hides) ----
  const [pageBadge, setPageBadge] = useState({ visible: false, page: 1 });
  const pageBadgeOpacity = useRef(new Animated.Value(0)).current;
  const pageBadgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPageBadge = useCallback(
    (page: number) => {
      setPageBadge({ visible: true, page });
      Animated.timing(pageBadgeOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
      if (pageBadgeTimerRef.current) clearTimeout(pageBadgeTimerRef.current);
      pageBadgeTimerRef.current = setTimeout(() => {
        Animated.timing(pageBadgeOpacity, { toValue: 0, duration: 320, useNativeDriver: true }).start(
          ({ finished }) => {
            if (finished) setPageBadge((b) => ({ ...b, visible: false }));
          },
        );
      }, 1100);
    },
    [pageBadgeOpacity],
  );
  useEffect(
    () => () => {
      if (pageBadgeTimerRef.current) clearTimeout(pageBadgeTimerRef.current);
    },
    [],
  );

  const isEmpty =
    strokes.length === 0 && !stylusStrokeActive && text.length === 0 && images.length === 0;

  const handleContainerLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
    // Page origin lets us map drag finger pageX/pageY into container coordinates
    // for edge-intent snapping (see resolveReleaseDock).
    containerRef.current?.measureInWindow((x, y) => {
      if (typeof x === 'number' && typeof y === 'number') {
        containerOriginRef.current = { x, y };
      }
    });
  };

  /**
   * Side-docked vertical toolbar (Concept C). A purpose-built layout — independent of the
   * horizontal JSX. The primary rail is fixed-size and never resizes when tools change; the
   * inward context card, the history mini-rail and the selection cluster are separate navy
   * surfaces. The active indicator is an inward-edge bar (no underline). Left vs right mirror
   * via `toolbarOnRight`. Only built when the toolbar is actually docked left/right.
   */
  const verticalActiveIndicatorStyle = [
    styles.vActiveIndicator,
    toolbarOnRight ? styles.vActiveIndicatorRight : styles.vActiveIndicatorLeft,
  ];
  // toolbarHasContext already excludes scroll + type.
  const verticalHasContext = toolbarHasContext;
  const verticalContextWidth =
    mode === 'insert'
      ? TOOLBAR_VERTICAL_CONTEXT_WIDE
      : TOOLBAR_VERTICAL_CONTEXT_NARROW;
  const verticalToolbar = !toolbarVertical ? null : effectiveToolbarCollapsed ? (
    // ---- Minimized capsule: grip · current tool · inward expand chevron (purpose-built) ----
    <View
      style={[styles.toolbarSurface, styles.vMiniCapsule]}
      {...toolbarDragResponder.panHandlers}
      {...toolbarDragTouchHandlers}
    >
      <NavySurface />
      <View accessibilityLabel={t('tools.moveNotebook')} accessibilityRole="adjustable" style={styles.vMiniGrip}>
        <GripDots />
      </View>
      <View style={styles.vMiniCur}>
        <ModeIcon mode={mode} active color={colors.pearlWhite} size={24} />
      </View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('tools.expandNotebook')}
        onPress={() => runToolbarPress(() => transitionToolbarCollapsed(false))}
        hitSlop={TOOLBAR_ICON_HIT_SLOP}
        {...toolbarDragResponder.panHandlers}
        {...toolbarDragTouchHandlers}
        style={styles.vMiniExpand}
      >
        <ToolbarGlyph
          name={toolbarOnRight ? 'chevronLeft' : 'chevronRight'}
          color="rgba(255,255,255,0.6)"
          size={18}
        />
      </PressableScale>
    </View>
  ) : (
    <View style={[styles.vEdgeColumn, toolbarOnRight ? styles.vEdgeColumnRight : null]}>
      {/* MAIN CAPSULE — two narrow columns (tools + active-tool context) in one navy shell */}
      <View
        style={[styles.toolbarSurface, styles.vCapsule, toolbarOnRight ? styles.vCapsuleRight : null]}
      >
        <NavySurface />
        {/* Primary tool column — nearest the screen edge */}
        <View
          style={styles.vToolColumn}
          {...toolbarDragResponder.panHandlers}
          {...toolbarDragTouchHandlers}
        >
          {PRIMARY_TOOLS.map((tool) => {
            const active = mode === tool.key;
            return (
              <Pressable
                key={tool.key}
                accessibilityRole="button"
                accessibilityLabel={t('tools.toolA11y', { tool: t(`tools.${tool.key}`) })}
                accessibilityState={{ selected: active }}
                onPress={() => runToolbarPress(() => changeMode(tool.key))}
                hitSlop={TOOLBAR_ICON_HIT_SLOP}
                {...toolbarDragResponder.panHandlers}
                {...toolbarDragTouchHandlers}
                style={({ pressed }) => [styles.vRailButton, pressed && styles.toolbarPressed]}
              >
                {active ? <View style={styles.vActiveChip} /> : null}
                <ModeIcon
                  mode={tool.key}
                  active={active}
                  color={active ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE}
                  size={25}
                />
                {active ? <View style={verticalActiveIndicatorStyle} /> : null}
              </Pressable>
            );
          })}
          <View style={styles.vRailDivider} />
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('tools.hand')}
            accessibilityState={{ selected: mode === 'scroll' }}
            onPress={() => runToolbarPress(() => changeMode(mode === 'scroll' ? 'write' : 'scroll'))}
            hitSlop={TOOLBAR_ICON_HIT_SLOP}
            {...toolbarDragResponder.panHandlers}
            {...toolbarDragTouchHandlers}
            style={styles.vRailIconButton}
          >
            {mode === 'scroll' ? <View style={styles.vActiveChip} /> : null}
            <ToolbarGlyph name="hand" color={mode === 'scroll' ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE} />
            {mode === 'scroll' ? <View style={verticalActiveIndicatorStyle} /> : null}
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('tools.minimizeNotebook')}
            onPress={() => runToolbarPress(() => transitionToolbarCollapsed(true))}
            hitSlop={TOOLBAR_ICON_HIT_SLOP}
            {...toolbarDragResponder.panHandlers}
            {...toolbarDragTouchHandlers}
            style={styles.vRailIconButton}
          >
            <ToolbarGlyph name={toolbarOnRight ? 'chevronRight' : 'chevronLeft'} color={TOOLBAR_ICON_IDLE} />
          </PressableScale>
        </View>

        {/* Context column — only the active tool's controls, facing inward toward the Canvas */}
        {verticalHasContext ? (
          <>
            <View style={styles.vColumnDivider} />
            <View style={[styles.vContextColumn, { width: verticalContextWidth }]}>
              {mode === 'write' || mode === 'highlight' ? (
                <ScrollView
                  style={styles.vContextScroll}
                  contentContainerStyle={styles.vContextScrollContent}
                  directionalLockEnabled
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  scrollEventThrottle={16}
                  showsVerticalScrollIndicator={false}
                  {...contextScrollHandlers}
                >
                  <View style={styles.vSwatchColumn}>
                    {(mode === 'highlight' ? HIGHLIGHTER_COLORS : PEN_COLORS).map((option) => {
                      const selectedColor = mode === 'highlight' ? highlighterColor : penColor;
                      const isActive = selectedColor === option.value;
                      return (
                        <Pressable
                          key={option.key}
                          accessibilityRole="button"
                          accessibilityLabel={t('tools.colorA11y', { tool: mode === 'highlight' ? t('tools.highlighter') : t('tools.pen'), color: t(`tools.color.${option.key.toLowerCase()}`) })}
                          accessibilityState={{ selected: isActive }}
                          onPress={() =>
                            runToolbarPress(() =>
                              mode === 'highlight'
                                ? setHighlighterColor(option.value)
                                : setPenColor(option.value),
                            )
                          }
                          style={({ pressed }) => [styles.inkSwatch, pressed && styles.toolbarPressed]}
                        >
                          <View style={[StyleSheet.absoluteFill, styles.inkSwatchFill, { backgroundColor: option.value }]} />
                          {isActive ? <View style={styles.inkSwatchRing} /> : null}
                          {isActive ? <ToolbarGlyph name="pen" color={colors.pearlWhite} size={13} /> : null}
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={styles.vCtxDivider} />
                  <View style={styles.vNibColumn}>
                    {(mode === 'highlight' ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS).map((option) => {
                      const selectedWidth = mode === 'highlight' ? highlighterWidth : penWidth;
                      const active = selectedWidth === option.value;
                      return (
                        <Pressable
                          key={option.key}
                          accessibilityRole="button"
                          accessibilityLabel={t('tools.widthA11y', { tool: mode === 'highlight' ? t('tools.highlighter') : t('tools.pen'), width: t(`tools.size.${option.key.toLowerCase()}`) })}
                          accessibilityState={{ selected: active }}
                          onPress={() =>
                            runToolbarPress(() =>
                              mode === 'highlight'
                                ? setHighlighterWidth(option.value)
                                : setPenWidth(option.value),
                            )
                          }
                          style={({ pressed }) => [styles.nib, active && styles.nibActive, pressed && styles.toolbarPressed]}
                        >
                          <View
                            style={{
                              width: option.dot,
                              height: option.dot,
                              borderRadius: option.dot / 2,
                              backgroundColor: 'rgba(255,255,255,0.92)',
                            }}
                          />
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>
              ) : null}

              {mode === 'erase' ? (
                <View style={styles.vNibColumn}>
                  {ERASER_SIZES.map((option) => {
                    const active = eraserSizeKey === option.key;
                    const dot = option.key === 'small' ? 8 : option.key === 'medium' ? 13 : 19;
                    return (
                      <Pressable
                        key={option.key}
                        accessibilityRole="button"
                        accessibilityLabel={t('tools.eraserA11y', { size: t(`tools.size.${option.key}`) })}
                        accessibilityState={{ selected: active }}
                        onPress={() => runToolbarPress(() => setEraserSizeKey(option.key))}
                        style={({ pressed }) => [styles.nib, active && styles.nibActive, pressed && styles.toolbarPressed]}
                      >
                        <View
                          style={{
                            width: dot,
                            height: dot,
                            borderRadius: dot / 2,
                            backgroundColor: 'rgba(255,255,255,0.92)',
                          }}
                        />
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              {mode === 'select' ? (
                <View style={styles.vSelectShapePanel}>
                  {(['lasso', 'rect'] as SelectionShape[]).map((shape) => {
                    const active = selectionShape === shape;
                    return (
                      <Pressable
                        key={shape}
                        accessibilityRole="button"
                        accessibilityLabel={shape === 'rect' ? t('tools.rectSelection') : t('tools.lassoSelection')}
                        accessibilityState={{ selected: active }}
                        onPress={() => runToolbarPress(() => setSelectionShape(shape))}
                        hitSlop={TOOLBAR_ICON_HIT_SLOP}
                        {...toolbarDragResponder.panHandlers}
                        {...toolbarDragTouchHandlers}
                        style={({ pressed }) => [
                          styles.vShapeButton,
                          active && styles.vShapeButtonActive,
                          pressed && styles.toolbarPressed,
                        ]}
                      >
                        <SelectionShapeIcon
                          shape={shape}
                          color={active ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE}
                        />
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              {mode === 'insert' ? (
                <View style={styles.vCtxPanel}>
                  <Text style={styles.vCtxLabel}>{t('tools.insert')}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('tools.insertPhotos')}
                    onPress={() => runToolbarPress(pickImage)}
                    style={({ pressed }) => [styles.vInsertButton, pressed && styles.toolbarPressed]}
                  >
                    <Svg width={20} height={20} viewBox="0 0 24 24">
                      <Rect x="7" y="7" width="13" height="13" rx="2.2" stroke={colors.pearlWhite} strokeWidth={1.8} fill="none" />
                      <Path d="M4 16V5.5A1.5 1.5 0 0 1 5.5 4H16" stroke={colors.pearlWhite} strokeWidth={1.8} strokeLinecap="round" fill="none" />
                      <Circle cx="11" cy="11.5" r="1.3" fill={colors.pearlWhite} />
                      <Path d="M8 18l3-3 2.2 2.2L16 14l4 4" stroke={colors.pearlWhite} strokeWidth={1.6} strokeLinejoin="round" fill="none" />
                    </Svg>
                    <Text style={styles.vInsertLabel}>{t('tools.photos')}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </>
        ) : null}
      </View>

      {/* History action capsule — separate, narrow, aligned under the tool column */}
      <View
        style={[styles.toolbarSurface, styles.vActionCapsule]}
        {...toolbarDragResponder.panHandlers}
        {...toolbarDragTouchHandlers}
      >
        <NavySurface />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hasSelection ? t('tools.deleteSelected') : t('tools.clearPage')}
          accessibilityState={{ disabled: !canClear }}
          onPress={() => runToolbarPress(handleTrashPress)}
          disabled={!canClear}
          hitSlop={TOOLBAR_ICON_HIT_SLOP}
          {...toolbarDragResponder.panHandlers}
          {...toolbarDragTouchHandlers}
          style={({ pressed }) => [
            styles.vRailIconButton,
            !canClear && styles.iconToolButtonDisabled,
            pressed && canClear && styles.toolbarPressed,
          ]}
        >
          <ToolbarGlyph name="more" color={canClear ? TOOLBAR_ICON_IDLE : TOOLBAR_ICON_DISABLED} />
        </Pressable>
      </View>

      {/* Selection Duplicate/Delete is NOT a toolbar pill — it floats above the
          selected image (see imageActionBar below), so nothing is added here. */}
    </View>
  );

  const reportNotebookScroll = useCallback((y: number) => {
    // Smoking-gun check for the palm/double-tap viewport-jump investigation:
    // scrollEnabled is set false via setNativeProps the moment a stylus
    // stroke or palm-grace window begins, but that is a JS-thread round trip
    // — an already-in-flight native pan (e.g. a palm that touched down
    // before the Pencil) can still deliver scroll events after the lock is
    // considered active. This never fires if the lock is airtight; if it
    // does, y is the exact post-jump offset.
    if (__DEV__ && (stylusStrokeLockRef.current || palmGraceActiveRef.current)) {
      const before = lastLockedScrollYRef.current;
      if (before !== null && Math.abs(y - before) > 0.5) {
        console.info('[NotebookViewport] scroll-during-lock', {
          scrollYBefore: before,
          scrollYNow: y,
          delta: y - before,
          strokeActive: stylusStrokeLockRef.current,
          palmGrace: palmGraceActiveRef.current,
        });
      }
    }
    // Second-round check: a jump landing just AFTER protection lapses
    // (grace expired, or right around a double-tap) rather than during it —
    // see armPostUnlockWatch above for why this is the more likely window.
    if (__DEV__ && postUnlockWatchRef.current) {
      const watch = postUnlockWatchRef.current;
      if (Date.now() > watch.until) {
        postUnlockWatchRef.current = null;
      } else if (Math.abs(y - watch.baselineY) > 0.5) {
        console.info('[NotebookViewport] scroll-after-unlock', {
          reason: watch.reason,
          scrollYBaseline: watch.baselineY,
          scrollYNow: y,
          delta: y - watch.baselineY,
          msSinceArm: POST_UNLOCK_WATCH_MS - (watch.until - Date.now()),
        });
        postUnlockWatchRef.current = null;
      }
    }
    scrollOffsetYRef.current = y;
    showPageBadge(pageForScroll(y));
  }, [pageForScroll, showPageBadge]);
  const notebookScrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      const y = event.contentOffset.y;
      nativeScrollY.value = y;
      if (zoomHolding.value) {
        if (!zoomActive.value && Math.abs(y - zoomY.value) < 0.5) zoomHolding.value = false;
        return;
      }
      runOnJS(reportNotebookScroll)(y);
    },
  });

  return (
    <View ref={containerRef} style={[styles.container, style]} onLayout={handleContainerLayout}>
      {/* ---- Long scrollable paper ----
          The gesture lives on the actual ScrollView, not on an absolute overlay
          above it. That keeps finger touches in the scroll view's hit-test path
          from the beginning; only confirmed stylus input activates drawing. */}
      <GestureDetector gesture={notebookGestures}>
        <AnimatedNotebookScrollView
          ref={scrollViewRef}
          style={styles.scroll}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!stylusStrokeActive && !imageManipulationActive}
          scrollEventThrottle={16}
          onScrollBeginDrag={() => showPageBadge(pageForScroll(scrollOffsetYRef.current))}
          onScroll={notebookScrollHandler}
        >
          <View onLayout={settlePageZoom} style={[styles.paper, { height: canvasHeight * canvasScale }]}>
          <Reanimated.View
            style={[{
              height: canvasHeight,
              width: '100%',
              // RN applies right-to-left: scale about top-left, then translateX
              // → screen = content * scale + translateX (focal-point zoom).
              transformOrigin: 'top left',
            }, paperTransform]}
          >
          {/* Stacked A4-like paper sheets (each its own ruled lines + margin),
              separated by a gap so the notebook reads as paper, not one canvas. */}
          {pageSheets}

          {/* Typed-notes layer. Fills the paper via absolute-fill (no explicit
              height) so its frame never feeds back into the page-count math. */}
          <TextInput
            style={styles.textLayer}
            value={text}
            onChangeText={handleTextChange}
            onBlur={endTextHistoryBurst}
            editable={editable && mode === 'type'}
            pointerEvents={editable && mode === 'type' ? 'auto' : 'none'}
            multiline
            scrollEnabled={false}
            placeholder=""
            textAlignVertical="top"
          />

          {/* Image objects layer */}
          {images.map((img) => {
            const isSel = selectedIds.has(img.id);
            return (
              <NotebookImageObject
                key={img.id}
                image={img}
                selected={isSel}
                moveOffset={selectionMoveOffset}
                onSelect={selectImage}
                onTransform={updateImageTransform}
                onCornerResize={resizeImageFromCornerGesture}
                onGestureStart={beginImageGesture}
                onGestureEnd={endImageGesture}
              />
            );
          })}

          {/* Handwriting + selection overlay (never captures touches).
              Completed ink is memoized separately from live ActiveInkHost so
              each Pencil sample does not rebuild every committed path. */}
          <CompletedStrokeLayer
            canvasHeight={canvasHeight}
            unselectedShapes={unselectedShapes}
            selectedShapes={selectedShapes}
            selectionMoveOffset={selectionMoveOffset}
            erasePoint={erasePoint}
            eraserRadius={eraserRadius}
            showEraseCursor={mode === 'erase'}
            lassoPoints={lassoPoints}
            showLasso={mode === 'select'}
            selectionRect={selectionRect}
            showSelectionRect={mode === 'select'}
            selectionBounds={selectionBounds}
            showSelectionBounds={mode === 'select'}
          />
          <ActiveInkHost
            ref={activeInkRef}
            canvasHeight={canvasHeight}
            tool={mode === 'highlight' ? 'highlighter' : 'pen'}
            color={mode === 'highlight' ? highlighterColor : penColor}
            width={mode === 'highlight' ? highlighterWidth : penWidth}
            opacity={mode === 'highlight' ? 0.34 : 1}
          />

          {/* Floating action bar for the selected object (e.g. an image) — a compact
              dark capsule pinned directly above the selection, like Apple Notes /
              GoodNotes. It lives in the scrolling paper so it follows the object as it
              moves, resizes and scrolls. Not part of the draggable toolbar. */}
          {imageActionBar ? (
            <View
              style={[styles.imageActionBar, { left: imageActionBar.left, top: imageActionBar.top }]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('tools.duplicateImage')}
                onPress={duplicateSelected}
                hitSlop={TOOLBAR_ICON_HIT_SLOP}
                style={({ pressed }) => [styles.imageActionButton, pressed && styles.toolbarPressed]}
              >
                <ToolbarGlyph name="duplicate" color={TOOLBAR_ICON_IDLE} />
              </Pressable>
              <View style={styles.imageActionDivider} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('tools.deleteImage')}
                onPress={deleteSelectedObjects}
                hitSlop={TOOLBAR_ICON_HIT_SLOP}
                style={({ pressed }) => [styles.imageActionButton, pressed && styles.toolbarPressed]}
              >
                <ToolbarGlyph name="trash" color={TOOLBAR_DELETE_RED} />
              </Pressable>
            </View>
          ) : null}

          {/* Empty-state hint */}
          {editable && isEmpty ? (
            <View style={styles.emptyHint} pointerEvents="none">
              <Ionicons name="pencil-outline" size={22} color={colors.mutedBlueGray} />
              <Text style={styles.emptyHintText}>
                {mode === 'scroll'
                  ? t('tools.scrollHint')
                  : t('tools.pencilHint')}
              </Text>
              <Text style={styles.emptyHintSub}>
                {doubleTapAvailable
                  ? t('tools.pencilDoubleTapHint')
                  : t('tools.toolbarHint')}
              </Text>
            </View>
          ) : null}
          </Reanimated.View>
          </View>
        </AnimatedNotebookScrollView>
      </GestureDetector>

      {/* Scroll-time page indicator — bottom-right, compact, auto-hides. */}
      {pageBadge.visible ? (
        <Animated.View style={[styles.pageBadge, { opacity: pageBadgeOpacity }]} pointerEvents="none">
          <Text style={styles.pageBadgeText}>
            {pageBadge.page} / {totalPages}
          </Text>
        </Animated.View>
      ) : null}

      {editable ? (
        <GestureDetector gesture={toolbarVertical ? disabledToolbarPanGesture : toolbarPanGesture}>
          <Animated.View
            pointerEvents="auto"
            style={[
              styles.floatingToolbarWrap,
              toolbarVertical && styles.floatingToolbarWrapVertical,
              toolbarOnRight && styles.floatingToolbarWrapRight,
              { width: toolbarFrameSize.width, height: toolbarFrameSize.height },
              { transform: toolbarPosition.getTranslateTransform() },
            ]}
          >
            {toolbarVertical ? (
              verticalToolbar
            ) : (
              <>
            <Animated.View
              style={[
                styles.toolbarSurface,
                styles.toolbarShell,
                { borderRadius: effectiveToolbarCollapsed ? TOOLBAR_MINIMIZED_RADIUS : TOOLBAR_SHELL_RADIUS },
                {
                  width: toolbarVisualSize.width,
                  height: toolbarVisualSize.height,
                  transform: [{ scale: toolbarScale }],
                },
              ]}
              {...toolbarDragResponder.panHandlers}
              {...toolbarDragTouchHandlers}
            >
              <NavySurface width={toolbarVisualSize.width} height={toolbarVisualSize.height} />
              {/* Minimized tag: grip · current-tool icon · expand chevron (design .tbmin). */}
              <Animated.View
                pointerEvents={effectiveToolbarCollapsed ? 'auto' : 'none'}
                style={[
                  styles.collapsedContent,
                  toolbarVertical && styles.collapsedContentVertical,
                  { opacity: collapsedContentOpacity },
                ]}
              >
                <View
                  accessibilityLabel={t('tools.moveNotebook')}
                  accessibilityRole="adjustable"
                  style={styles.collapsedGrip}
                >
                  <GripDots />
                </View>
                <View style={styles.collapsedCur}>
                  <ModeIcon mode={mode} active color={colors.pearlWhite} size={24} />
                </View>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t('tools.expandNotebook')}
                  onPress={() => runToolbarPress(() => transitionToolbarCollapsed(false))}
                  hitSlop={TOOLBAR_ICON_HIT_SLOP}
                  {...toolbarDragResponder.panHandlers}
                  {...toolbarDragTouchHandlers}
                  style={[
                    styles.collapsedExpand,
                  ]}
                >
                  <ToolbarGlyph
                    name={toolbarVertical ? (toolbarOnRight ? 'chevronRight' : 'chevronLeft') : 'chevronUp'}
                    color="rgba(255,255,255,0.6)"
                    size={18}
                  />
                </PressableScale>
              </Animated.View>

            <Animated.View
              pointerEvents={effectiveToolbarCollapsed ? 'none' : 'auto'}
              style={[
                styles.expandedContent,
                toolbarVertical && styles.expandedContentVertical,
                toolbarOnRight && styles.expandedContentVerticalRight,
                { opacity: expandedContentOpacity },
              ]}
            >
              <View style={[styles.primaryToolbarRow, toolbarVertical && styles.primaryToolbarRail]}>
                <View
                  accessibilityLabel={t('tools.moveNotebook')}
                  accessibilityRole="adjustable"
                  style={[styles.expandedDragHandle, toolbarVertical && styles.expandedDragHandleVertical]}
                >
                  <GripDots />
                </View>

                <View style={[styles.primaryTools, toolbarVertical && styles.primaryToolsVertical]}>
                  {PRIMARY_TOOLS.map((tool) => {
                    const active = mode === tool.key;
                    return (
                      <Pressable
                        key={tool.key}
                        accessibilityRole="button"
                        accessibilityLabel={t('tools.toolA11y', { tool: t(`tools.${tool.key}`) })}
                        accessibilityState={{ selected: active }}
                        onPress={() => runToolbarPress(() => changeMode(tool.key))}
                        hitSlop={TOOLBAR_ICON_HIT_SLOP}
                        {...toolbarDragResponder.panHandlers}
                        {...toolbarDragTouchHandlers}
                        style={({ pressed }) => [styles.toolButton, pressed && styles.toolbarPressed]}
                      >
                        <ModeIcon
                          mode={tool.key}
                          active={active}
                          color={active ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE}
                          size={25}
                        />
                        {active ? (
                          <View
                            style={[
                              styles.toolUnderline,
                              toolbarVertical && styles.toolUnderlineVertical,
                              toolbarOnRight && styles.toolUnderlineVerticalRight,
                            ]}
                          />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>

                <View style={[styles.vDivider, toolbarVertical && styles.hDivider]} />

                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t('tools.hand')}
                  accessibilityState={{ selected: mode === 'scroll' }}
                  onPress={() => runToolbarPress(() => changeMode(mode === 'scroll' ? 'write' : 'scroll'))}
                  hitSlop={TOOLBAR_ICON_HIT_SLOP}
                  {...toolbarDragResponder.panHandlers}
                  {...toolbarDragTouchHandlers}
                  style={styles.iconToolButton}
                >
                  <ToolbarGlyph
                    name="hand"
                    color={mode === 'scroll' ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE}
                  />
                  {mode === 'scroll' ? (
                    <View
                      style={[
                        styles.toolUnderline,
                        toolbarVertical && styles.toolUnderlineVertical,
                        toolbarOnRight && styles.toolUnderlineVerticalRight,
                      ]}
                    />
                  ) : null}
                </PressableScale>

                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t('tools.minimizeNotebook')}
                  onPress={() => runToolbarPress(() => transitionToolbarCollapsed(true))}
                  hitSlop={TOOLBAR_ICON_HIT_SLOP}
                  {...toolbarDragResponder.panHandlers}
                  {...toolbarDragTouchHandlers}
                  style={[
                    styles.collapseButton,
                    toolbarVertical && styles.collapseButtonVertical,
                  ]}
                >
                  <ToolbarGlyph name={toolbarVertical ? 'chevronDown' : 'chevronRight'} color={TOOLBAR_ICON_IDLE} />
                </PressableScale>
              </View>

              {toolbarHasContext ? (
                <Animated.View
                  style={[
                    styles.contextToolbarRow,
                    toolbarVertical && styles.contextToolbarPanel,
                    toolbarVertical && toolbarOnRight && styles.contextToolbarPanelRight,
                    toolbarVertical && { width: toolbarContextWidth },
                    {
                      opacity: Animated.multiply(
                        toolbarTransition.interpolate({
                          inputRange: [0, 0.65, 1],
                          outputRange: [0, 0, 1],
                        }),
                        contextFade,
                      ),
                    },
                  ]}
                >
                  {mode === 'write' || mode === 'highlight' ? (
                    <>
                      <Text style={styles.contextLabel}>{mode === 'highlight' ? t('tools.highlight') : t('tools.pen')}</Text>
                      <View style={styles.swatchGroup}>
                        {(mode === 'highlight' ? HIGHLIGHTER_COLORS : PEN_COLORS).map((option) => {
                          const selectedColor = mode === 'highlight' ? highlighterColor : penColor;
                          const isActive = selectedColor === option.value;
                          return (
                            <Pressable
                              key={option.key}
                              accessibilityRole="button"
                              accessibilityLabel={t('tools.colorA11y', { tool: mode === 'highlight' ? t('tools.highlighter') : t('tools.pen'), color: t(`tools.color.${option.key.toLowerCase()}`) })}
                              accessibilityState={{ selected: isActive }}
                              onPress={() =>
                                runToolbarPress(() =>
                                  mode === 'highlight'
                                    ? setHighlighterColor(option.value)
                                    : setPenColor(option.value),
                                )
                              }
                              {...toolbarDragResponder.panHandlers}
                              {...toolbarDragTouchHandlers}
                              style={({ pressed }) => [styles.inkSwatch, pressed && styles.toolbarPressed]}
                            >
                              <View style={[StyleSheet.absoluteFill, styles.inkSwatchFill, { backgroundColor: option.value }]} />
                              {isActive ? <View style={styles.inkSwatchRing} /> : null}
                              {isActive ? <ToolbarGlyph name="pen" color={colors.pearlWhite} size={13} /> : null}
                            </Pressable>
                          );
                        })}
                      </View>
                      <View style={styles.vDivider} />
                      <View style={styles.nibGroup}>
                        {(mode === 'highlight' ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS).map((option) => {
                          const selectedWidth = mode === 'highlight' ? highlighterWidth : penWidth;
                          const active = selectedWidth === option.value;
                          return (
                            <Pressable
                              key={option.key}
                              accessibilityRole="button"
                              accessibilityLabel={t('tools.widthA11y', { tool: mode === 'highlight' ? t('tools.highlighter') : t('tools.pen'), width: t(`tools.size.${option.key.toLowerCase()}`) })}
                              accessibilityState={{ selected: active }}
                              onPress={() =>
                                runToolbarPress(() =>
                                  mode === 'highlight'
                                    ? setHighlighterWidth(option.value)
                                    : setPenWidth(option.value),
                                )
                              }
                              {...toolbarDragResponder.panHandlers}
                              {...toolbarDragTouchHandlers}
                              style={({ pressed }) => [styles.nib, active && styles.nibActive, pressed && styles.toolbarPressed]}
                            >
                              <View
                                style={{
                                  width: option.dot,
                                  height: option.dot,
                                  borderRadius: option.dot / 2,
                                  backgroundColor: 'rgba(255,255,255,0.92)',
                                }}
                              />
                            </Pressable>
                          );
                        })}
                      </View>
                    </>
                  ) : null}

                  {mode === 'erase' ? (
                    <>
                      <Text style={styles.contextLabel}>{t('tools.size')}</Text>
                      <View style={styles.nibGroup}>
                        {ERASER_SIZES.map((option) => {
                          const active = eraserSizeKey === option.key;
                          const dot = option.key === 'small' ? 8 : option.key === 'medium' ? 13 : 19;
                          return (
                            <Pressable
                              key={option.key}
                              accessibilityRole="button"
                              accessibilityLabel={t('tools.eraserA11y', { size: t(`tools.size.${option.key}`) })}
                              accessibilityState={{ selected: active }}
                              onPress={() => runToolbarPress(() => setEraserSizeKey(option.key))}
                              {...toolbarDragResponder.panHandlers}
                              {...toolbarDragTouchHandlers}
                              style={({ pressed }) => [styles.nib, active && styles.nibActive, pressed && styles.toolbarPressed]}
                            >
                              <View
                                style={{
                                  width: dot,
                                  height: dot,
                                  borderRadius: dot / 2,
                                  backgroundColor: 'rgba(255,255,255,0.92)',
                                }}
                              />
                            </Pressable>
                          );
                        })}
                      </View>
                    </>
                  ) : null}

                  {mode === 'select' ? (
                    <View style={styles.hSelectShapePanel}>
                      {(['lasso', 'rect'] as SelectionShape[]).map((shape) => {
                        const active = selectionShape === shape;
                        return (
                          <Pressable
                            key={shape}
                            accessibilityRole="button"
                            accessibilityLabel={shape === 'rect' ? t('tools.rectSelection') : t('tools.lassoSelection')}
                            accessibilityState={{ selected: active }}
                            onPress={() => runToolbarPress(() => setSelectionShape(shape))}
                            hitSlop={TOOLBAR_ICON_HIT_SLOP}
                            {...toolbarDragResponder.panHandlers}
                            {...toolbarDragTouchHandlers}
                            style={({ pressed }) => [
                              styles.vShapeButton,
                              active && styles.vShapeButtonActive,
                              pressed && styles.toolbarPressed,
                            ]}
                          >
                            <SelectionShapeIcon
                              shape={shape}
                              color={active ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE}
                            />
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}

                  {mode === 'insert' ? (
                    <View style={styles.insertRow}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('tools.insertPhotos')}
                        onPress={() => runToolbarPress(pickImage)}
                        {...toolbarDragResponder.panHandlers}
                        {...toolbarDragTouchHandlers}
                        style={({ pressed }) => [styles.insertButton, pressed && styles.toolbarPressed]}
                      >
                        <Svg width={17} height={17} viewBox="0 0 24 24">
                          <Rect x="7" y="7" width="13" height="13" rx="2.2" stroke={colors.pearlWhite} strokeWidth={1.8} fill="none" />
                          <Path d="M4 16V5.5A1.5 1.5 0 0 1 5.5 4H16" stroke={colors.pearlWhite} strokeWidth={1.8} strokeLinecap="round" fill="none" />
                          <Circle cx="11" cy="11.5" r="1.3" fill={colors.pearlWhite} />
                          <Path d="M8 18l3-3 2.2 2.2L16 14l4 4" stroke={colors.pearlWhite} strokeWidth={1.6} strokeLinejoin="round" fill="none" />
                        </Svg>
                        <Text style={styles.insertButtonLabel}>{t('tools.choosePhotos')}</Text>
                      </Pressable>
                      <Text style={styles.contextHint}>{t('tools.insertHint')}</Text>
                    </View>
                  ) : null}
                </Animated.View>
              ) : null}
            </Animated.View>
          </Animated.View>

          {/* Right-hand actions: history always visible; selection actions appear beside it. */}
          {effectiveToolbarCollapsed ? null : (
            <>
              <View
                style={[
                  styles.toolbarSurface,
                  styles.rightPill,
                  toolbarVertical && styles.actionPillVertical,
                ]}
                {...toolbarDragResponder.panHandlers}
                {...toolbarDragTouchHandlers}
              >
                <NavySurface
                  width={toolbarVertical ? TOOLBAR_VERTICAL_ACTION_WIDTH : TOOLBAR_HISTORY_PILL_WIDTH}
                  height={toolbarVertical ? TOOLBAR_HISTORY_PILL_WIDTH : 60}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={hasSelection ? t('tools.deleteSelected') : t('tools.clearPage')}
                  accessibilityState={{ disabled: !canClear }}
                  onPress={() => runToolbarPress(handleTrashPress)}
                  disabled={!canClear}
                  hitSlop={TOOLBAR_ICON_HIT_SLOP}
                  {...toolbarDragResponder.panHandlers}
                  {...toolbarDragTouchHandlers}
                  style={({ pressed }) => [
                    styles.iconToolButton,
                    !canClear && styles.iconToolButtonDisabled,
                    pressed && canClear && styles.toolbarPressed,
                  ]}
                >
                  <ToolbarGlyph name="more" color={canClear ? TOOLBAR_ICON_IDLE : TOOLBAR_ICON_DISABLED} />
                </Pressable>
              </View>
              {/* Selection Duplicate/Delete is NOT a toolbar pill — it floats above
                  the selected image (see imageActionBar below). */}
            </>
          )}
            </>
            )}
          </Animated.View>
        </GestureDetector>
      ) : null}

      {/* Tool badge — brief feedback after an Apple Pencil double-tap */}
      {editable && toolToast ? (
        <View style={styles.toolToastWrap} pointerEvents="none">
          <View style={styles.toolToast}>
            <ModeIcon mode={toolToast} active />
            <Text style={styles.toolToastText}>
              {toolToast === 'erase' ? t('tools.eraser') : toolToast === 'highlight' ? t('tools.highlighter') : t('tools.pen')}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Fixed Undo/Redo — top-right, parallel to the screen's nav controls.
          Rendered LAST (and with a high zIndex) so it always stays above the
          draggable toolbar, the page indicator and the canvas — it is icon-only
          and NOT part of the draggable toolbar, so it never moves or hides. */}
      {editable && showFixedHistory ? (
        <View style={styles.fixedHistory} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('tools.undo')}
            accessibilityState={{ disabled: !canUndo }}
            onPress={undo}
            disabled={!canUndo}
            hitSlop={TOOLBAR_ICON_HIT_SLOP}
            style={({ pressed }) => [
              styles.fixedHistoryButton,
              pressed && canUndo && styles.toolbarPressed,
            ]}
          >
            <ToolbarGlyph name="undo" color={canUndo ? TOOLBAR_ICON_IDLE : TOOLBAR_ICON_DISABLED} />
          </Pressable>
          <View style={styles.fixedHistoryDivider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('tools.redo')}
            accessibilityState={{ disabled: !canRedo }}
            onPress={redo}
            disabled={!canRedo}
            hitSlop={TOOLBAR_ICON_HIT_SLOP}
            style={({ pressed }) => [
              styles.fixedHistoryButton,
              pressed && canRedo && styles.toolbarPressed,
            ]}
          >
            <ToolbarGlyph name="redo" color={canRedo ? TOOLBAR_ICON_IDLE : TOOLBAR_ICON_DISABLED} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

type HandwritingPreviewProps = {
  strokes: NoteStroke[];
  style?: ViewStyle;
};

/**
 * A read-only, scaled-to-fit preview of handwriting strokes. Used on the
 * Lecture Detail Notes tab. Fits whatever the strokes' extent is, so it works
 * the same for the long page. Renders nothing when there are no strokes.
 */
export function HandwritingPreview({ strokes, style }: HandwritingPreviewProps) {
  const viewBox = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of strokes) {
      for (const point of stroke.points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
    }
    if (!Number.isFinite(minX)) return null;
    const pad = 26;
    return {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(maxX - minX, 1) + pad * 2,
      h: Math.max(maxY - minY, 1) + pad * 2,
    };
  }, [strokes]);

  if (!viewBox) return null;

  return (
    <View style={[styles.previewBox, style]}>
      <Svg
        width="100%"
        height="100%"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {strokes.filter((stroke) => stroke.tool === 'highlighter').map((stroke) => (
          <StrokeShape key={stroke.id} stroke={stroke} />
        ))}
        {strokes.filter((stroke) => stroke.tool !== 'highlighter').map((stroke) => (
          <StrokeShape key={stroke.id} stroke={stroke} />
        ))}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // ---- Independent floating toolbar overlay (unified navy, matches Live Caption) ----
  floatingToolbarWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: TOOLBAR_RIGHT_PILL_GAP,
    overflow: 'visible',
  },
  // Vertical dock: rail edge-column and inward card-column sit side by side, centred on the
  // cross (vertical) axis so the context card aligns with the rail's middle.
  floatingToolbarWrapVertical: {
    alignItems: 'center',
  },
  // Right dock mirrors the layout so the rail still hugs the screen edge.
  floatingToolbarWrapRight: {
    flexDirection: 'row-reverse',
  },
  toolbarSurface: {
    borderWidth: 1,
    borderColor: TOOLBAR_BORDER_COLOR,
    overflow: 'hidden',
    backgroundColor: TOOLBAR_NAVY_BOTTOM,
    shadowColor: 'rgba(8,16,34,0.4)',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 1,
    shadowRadius: 38,
    elevation: 10,
  },
  navySurfaceLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  toolbarShell: {
    borderRadius: TOOLBAR_SHELL_RADIUS,
  },
  collapsedContent: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    gap: 4,
  },
  collapsedContentVertical: {
    flexDirection: 'column',
    paddingHorizontal: 0,
    paddingVertical: 9,
  },
  expandedContent: {
    ...StyleSheet.absoluteFillObject,
  },
  expandedContentVertical: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  expandedContentVerticalRight: {
    flexDirection: 'row-reverse',
  },
  primaryToolbarRow: {
    height: TOOLBAR_PRIMARY_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  primaryToolbarRail: {
    width: TOOLBAR_VERTICAL_RAIL_WIDTH,
    height: '100%',
    flexDirection: 'column',
    alignItems: 'center',
  },
  expandedDragHandle: {
    width: 22,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: 'rgba(255, 255, 255, 0.08)',
  },
  expandedDragHandleVertical: {
    width: '100%',
    height: 22,
    borderRightWidth: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  // Grip — design `.grip`: two columns × three 3pt dots, gap 3.
  gripDots: {
    flexDirection: 'row',
    gap: 3,
  },
  gripCol: {
    gap: 3,
  },
  gripDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255, 255, 255, 0.30)',
  },
  collapsedGrip: {
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingRight: 3,
  },
  // Current-tool tag — design `.tbmin .cur` (46, tinted blue, radius 11).
  collapsedCur: {
    width: 46,
    height: 46,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(95,134,232,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(95,134,232,0.3)',
  },
  collapsedExpand: {
    width: 38,
    height: 46,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryTools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
  },
  primaryToolsVertical: {
    flexDirection: 'column',
    paddingHorizontal: 0,
    paddingVertical: 4,
    gap: TOOLBAR_VERTICAL_BUTTON_GAP,
  },
  /** Primary tool button — design `.tool` (48 × 46, radius 11). */
  toolButton: {
    width: 48,
    height: 46,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Icon button — design `.icbtn` (44 × 44, radius 11). Hand · Minimize · right pill. */
  iconToolButton: {
    width: 44,
    height: 44,
    minWidth: 44,
    minHeight: 44,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolUnderline: {
    position: 'absolute',
    bottom: 3,
    width: 20,
    height: 3,
    borderRadius: 3,
    backgroundColor: TOOLBAR_SELECTED,
  },
  toolUnderlineVertical: {
    top: 13,
    right: 3,
    bottom: undefined,
    width: 3,
    height: 20,
  },
  toolUnderlineVerticalRight: {
    right: undefined,
    left: 3,
  },
  iconToolButtonDisabled: {
    opacity: 0.32,
  },
  vDivider: {
    width: 1,
    height: 30,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
    marginHorizontal: 8,
  },
  hDivider: {
    width: 30,
    height: 1,
    marginHorizontal: 0,
    marginVertical: 8,
  },
  vDividerSmall: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
  },
  contextToolbarRow: {
    height: TOOLBAR_CONTEXT_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 22,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: TOOLBAR_DIVIDER_COLOR,
  },
  contextToolbarPanel: {
    height: '100%',
    justifyContent: 'center',
    flexWrap: 'wrap',
    rowGap: 12,
    borderTopWidth: 0,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: TOOLBAR_DIVIDER_COLOR,
    paddingHorizontal: 18,
  },
  contextToolbarPanelRight: {
    borderLeftWidth: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: TOOLBAR_DIVIDER_COLOR,
  },
  /** Ink swatch row — design `.swatches` gap 11. */
  swatchGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  /** Width / size nib row — design `.nibs` gap 9. */
  nibGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  /** Ink swatch — design `.sw` (28 circle; selected ring sits 4pt outside). */
  inkSwatch: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inkSwatchFill: {
    borderRadius: 14,
  },
  inkSwatchRing: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderRadius: 18,
    borderWidth: 2.5,
    borderColor: TOOLBAR_SELECTED,
  },
  /** Width / eraser-size nib — design `.nib` (38 circle, 2pt selected ring). */
  nib: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  nibActive: {
    borderColor: TOOLBAR_SELECTED,
  },
  contextLabel: {
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '700',
    letterSpacing: 1.05,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.36)',
    marginRight: 3,
  },
  contextHint: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.46)',
  },
  hSelectShapePanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  insertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  insertButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 11,
    paddingHorizontal: 15,
    paddingVertical: 9,
  },
  insertButtonLabel: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.pearlWhite,
  },
  collapseButton: {
    width: 34,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255, 255, 255, 0.08)',
  },
  collapseButtonVertical: {
    width: '100%',
    height: 44,
    borderLeftWidth: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
  },
  toolbarPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.92 }],
  },
  rightPill: {
    width: TOOLBAR_HISTORY_PILL_WIDTH,
    borderRadius: TOOLBAR_SHELL_RADIUS,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 10,
    height: 60,
  },
  actionPillVertical: {
    width: TOOLBAR_VERTICAL_ACTION_WIDTH,
    height: TOOLBAR_HISTORY_PILL_WIDTH,
    flexDirection: 'column',
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  selectionPill: {
    width: TOOLBAR_SELECTION_PILL_WIDTH,
    borderRadius: TOOLBAR_SHELL_RADIUS,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 8,
    height: 60,
  },
  selectionPillVertical: {
    width: TOOLBAR_VERTICAL_ACTION_WIDTH,
    height: TOOLBAR_SELECTION_PILL_WIDTH,
    flexDirection: 'column',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },

  // ==== Side-docked vertical toolbar — compact two-column capsule (reference layout) ====
  // Edge column stacks the main capsule above the separate history / selection capsules,
  // flush to the screen edge.
  vEdgeColumn: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: TOOLBAR_VERTICAL_GROUP_GAP,
  },
  vEdgeColumnRight: {
    alignItems: 'flex-end',
  },
  // Unified capsule = [tool column | divider | context column] in one navy shell.
  vCapsule: {
    flexDirection: 'row',
    alignItems: 'stretch',
    height: TOOLBAR_VERTICAL_CAPSULE_HEIGHT,
    borderRadius: TOOLBAR_SHELL_RADIUS,
  },
  vCapsuleRight: {
    flexDirection: 'row-reverse',
  },
  vToolColumn: {
    width: TOOLBAR_VERTICAL_TOOL_COL_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  /** Primary tool button — 48 × 44, radius 11. */
  vRailButton: {
    width: 48,
    height: 44,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Soft selected chip behind the active tool icon. */
  vActiveChip: {
    position: 'absolute',
    top: 2,
    left: 6,
    right: 6,
    bottom: 2,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    backgroundColor: 'rgba(95,134,232,0.14)',
  },
  /** Inward-edge active indicator (no underline). */
  vActiveIndicator: {
    position: 'absolute',
    top: 11,
    width: 3,
    height: 22,
    borderRadius: 2,
    backgroundColor: TOOLBAR_SELECTED,
  },
  vActiveIndicatorLeft: {
    right: 1,
  },
  vActiveIndicatorRight: {
    left: 1,
  },
  vRailDivider: {
    width: 28,
    height: 1,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
    marginVertical: 2,
  },
  /** Icon button (Hand · Minimize · history · selection) — 44 × 44, radius 11. */
  vRailIconButton: {
    width: 44,
    height: 44,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Full-height hairline between the two columns. */
  vColumnDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
    marginVertical: 16,
  },
  /** Inward context column — width set inline per active tool. */
  vContextColumn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 14,
  },
  vContextScroll: {
    alignSelf: 'stretch',
    flex: 1,
  },
  vContextScrollContent: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  vSwatchColumn: {
    alignItems: 'center',
    gap: 9,
  },
  vNibColumn: {
    alignItems: 'center',
    gap: 9,
  },
  vCtxDivider: {
    width: 26,
    height: StyleSheet.hairlineWidth,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
    marginVertical: 2,
  },
  /** Compact side context panel; Text/Select side modes stay icon-only. */
  vCtxPanel: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 0,
  },
  vSelectShapePanel: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  vShapeButton: {
    width: 40,
    height: 40,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  vShapeButtonActive: {
    backgroundColor: 'rgba(95,134,232,0.14)',
    borderColor: 'rgba(95,134,232,0.42)',
  },
  vCtxLabel: {
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '700',
    letterSpacing: 1.05,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.36)',
  },
  vCtxTitle: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '700',
    color: colors.pearlWhite,
  },
  vCardHint: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
  },
  vCardHintStrong: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '600',
    color: colors.pearlWhite,
    textAlign: 'center',
  },
  vInsertButton: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 12,
  },
  vInsertLabel: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '600',
    color: colors.pearlWhite,
    textAlign: 'center',
  },
  // Separate action capsule (history; reused for the contextual selection actions).
  vActionCapsule: {
    width: TOOLBAR_VERTICAL_TOOL_COL_WIDTH,
    borderRadius: 18,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 8,
  },
  // Minimized capsule — two states of the same component, built for the column.
  vMiniCapsule: {
    width: TOOLBAR_MINI_CAPSULE_WIDTH,
    height: TOOLBAR_MINI_CAPSULE_HEIGHT,
    borderRadius: TOOLBAR_MINIMIZED_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  vMiniGrip: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  vMiniCur: {
    width: 44,
    height: 44,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(95,134,232,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(95,134,232,0.3)',
  },
  vMiniExpand: {
    width: 44,
    height: 34,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ---- Paper ----
  scroll: {
    flex: 1,
    // Gap colour shown between stacked sheets (and on over-scroll).
    backgroundColor: colors.background,
  },
  paper: {
    width: '100%',
    // Height is set dynamically (total of all sheets + gaps). The background is
    // the gap colour so the spacing between sheets reads as separation.
    backgroundColor: colors.background,
  },
  // One paper sheet in the stack. Absolutely positioned by its page index.
  pageSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: colors.paper,
    borderRadius: 6,
    shadowColor: 'rgba(11,31,58,0.18)',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 2,
    overflow: 'hidden',
  },
  sheetRuled: {
    ...StyleSheet.absoluteFillObject,
    paddingTop: 52,
  },
  sheetMargin: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: MARGIN_X,
    width: 2,
    backgroundColor: colors.noteMargin,
  },
  ruled: {
    ...StyleSheet.absoluteFillObject,
    paddingTop: 52,
  },
  ruleLine: {
    height: 1,
    backgroundColor: colors.noteLine,
    marginBottom: LINE_GAP - 1,
  },
  marginLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: MARGIN_X,
    width: 2,
    backgroundColor: colors.noteMargin,
  },
  // Compact scroll-time page indicator (bottom-right).
  pageBadge: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    minWidth: 52,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    // Subtle translucent grey capsule (per the reference screenshot).
    backgroundColor: 'rgba(60,64,72,0.66)',
    shadowColor: 'rgba(8,16,34,0.25)',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 4,
  },
  pageBadgeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.4,
    fontVariant: ['tabular-nums'],
  },
  // Fixed Undo/Redo capsule — top-right, never moves (not the draggable toolbar).
  fixedHistory: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 50,
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    paddingHorizontal: 4,
    borderRadius: 14,
    backgroundColor: TOOLBAR_NAVY_BOTTOM,
    borderWidth: 1,
    borderColor: TOOLBAR_BORDER_COLOR,
    shadowColor: 'rgba(8,16,34,0.32)',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 1,
    shadowRadius: 14,
    elevation: 6,
  },
  fixedHistoryButton: {
    width: 40,
    height: 40,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fixedHistoryDivider: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
  },
  textLayer: {
    ...StyleSheet.absoluteFillObject,
    paddingTop: 18,
    paddingLeft: MARGIN_X + spacing.lg,
    paddingRight: spacing.xl,
    paddingBottom: spacing.xl,
    fontSize: 16,
    lineHeight: 26,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  imageObject: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  imageObjectSelected: {
    borderColor: '#5F86E8',
    backgroundColor: 'rgba(95,134,232,0.04)',
  },
  imageObjectMedia: {
    width: '100%',
    height: '100%',
  },
  // Corner handle: a comfortable ~36pt touch target (its own absolutely-positioned
  // view, NOT clipped by the image) with a small centred dot.
  imageCornerHit: {
    position: 'absolute',
    width: IMAGE_CORNER_HANDLE_HALF * 2,
    height: IMAGE_CORNER_HANDLE_HALF * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageHandleDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#5F86E8',
    // White ring keeps the dot visible against both bright and dark images.
    borderWidth: 2,
    borderColor: colors.pearlWhite,
  },
  imageActionBar: {
    position: 'absolute',
    zIndex: 35,
    width: IMAGE_ACTION_BAR_WIDTH,
    height: IMAGE_ACTION_BAR_HEIGHT,
    borderRadius: 15,
    backgroundColor: TOOLBAR_NAVY_BOTTOM,
    borderWidth: 1,
    borderColor: TOOLBAR_BORDER_COLOR,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: 'rgba(8,16,34,0.32)',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 1,
    shadowRadius: 14,
    elevation: 7,
  },
  imageActionButton: {
    width: 50,
    height: IMAGE_ACTION_BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageActionDivider: {
    width: StyleSheet.hairlineWidth,
    height: 24,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
  },
  emptyHint: {
    position: 'absolute',
    top: 132,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xl,
  },
  emptyHintText: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.mutedBlueGray,
    textAlign: 'center',
  },
  emptyHintSub: {
    fontSize: fontSize.sm,
    fontWeight: '500',
    color: colors.textTertiary,
    textAlign: 'center',
  },
  // ---- Tool badge ----
  toolToastWrap: {
    position: 'absolute',
    top: 84,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  toolToast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.deepNavy,
    ...shadows.soft,
  },
  toolToastText: {
    fontSize: fontSize.sm,
    fontWeight: '800',
    letterSpacing: 0.3,
    color: colors.pearlWhite,
  },

  // ---- Handwriting preview ----
  previewBox: {
    height: 168,
    borderRadius: radius.md,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
});

export default NotebookCanvas;
