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
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
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
  AppState,
  Image as RNImage,
  LayoutChangeEvent,
  Modal,
  Pressable,
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
  Ellipse,
  G,
  Path,
  Rect,
} from 'react-native-svg';
import Reanimated, { runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { strokeBounds, strokeNearSweep, sweepMayReachBounds } from '@/lib/inkEraser.mjs';
import type { NoteImage, NotePoint, NoteStroke } from '@/lib/models';
import { useT } from '@/lib/i18n';
import { SharedAnnotationToolbar } from '@/components/SharedAnnotationToolbar';
import { SharedSelectionShapeContext } from '@/components/SharedSelectionShapeContext';
import { SharedToolbarGlyphPaths, type SharedToolbarGlyphName } from '@/components/SharedToolbarChrome';
import { persistNotebookImage } from '@/lib/notebookImageStorage';
import { LEGACY_STYLE_PEN_WIDTHS, HIGHLIGHTER_WIDTHS as SHARED_HIGHLIGHTER_WIDTHS, NOTEBOOK_ERASER_RADII } from '@/lib/annotationPresets';
import {
  notebookModeToSharedTool,
  notebookSharedTools,
  notebookToolLabel,
  sharedToolToNotebookMode,
} from '@/lib/notebookAnnotationAdapter';
import {
  TOOLBAR_NAVY_BOTTOM,
  TOOLBAR_BORDER_COLOR,
  TOOLBAR_ICON_IDLE,
  TOOLBAR_ICON_DISABLED,
  TOOLBAR_DIVIDER_COLOR,
  TOOLBAR_CHIP_RADIUS,
  TOOLBAR_ICON_HIT_SLOP,
} from '@/lib/sharedToolbarChrome';
import { NotebookPencilSamplerOverlay, type NotebookPencilSampleEvent } from '@/lib/notebookPencilSampler';
import { isPencilKitTestAvailable, PencilKitTestSurface, type PencilKitTestSurfaceRef } from '@/lib/pencilKitTest';
import { notebookInkFileUri } from '@/lib/notebookInkStorage';
import { notebookInkPerf } from '@/lib/notebookInkPerf';
import { recognizeShapeDetailed } from '@/lib/shapeSnap';
import {
  dragShapeHandle, hitTestStructuredStroke, isStructuredStroke, nearestShapeHandle, shapeFromRecognition,
  shapeHandles, shapeToInkPoints, strokeWithShape, translateInkStroke,
  SHAPE_HANDLE_HIT_PT, SHAPE_HANDLE_RADIUS_PT, SHAPE_TAP_MAX_EXTENT_PT, SHAPE_TAP_SELECT_PT,
  type AnnotationShape, type ShapeGeometry,
} from '@/lib/annotationShape';
import { recordShapeSnapAttempt, SHAPE_SNAP_TRACE_ENABLED } from '@/lib/shapeSnapTrace';
import {
  IDLE_SELECTION, selectedIdsOf, selectionReduce,
  type SelectionEvent, type SelectionState,
} from '@/lib/selectionMachine';
import {
  SELECTION_PENCIL_PAD_PT, SELECTION_TOUCH_PAD_PT, boundsCenter, boundsOfPoints, boundsSpan,
  clampSelectionScale, insideSelectionRegion, pinchFactor, routeSelectionTouch,
  scaleInkStroke, scaleSelectedStrokes,
} from '@/lib/selectionTransform';
import { SELECTION_TRACE_ENABLED, traceSelection } from '@/lib/selectionTrace';
import { penTapShapeTarget } from '@/lib/penTapSelect';
import { ShapeHoldTracker, SHAPE_SNAP_HOLD_MS, SHAPE_SNAP_HOLD_TOLERANCE_PT } from '@/lib/shapeSnapHold';
import { appendFreeform, boxFromCorners, selectedInkIds, selectionAcceptsPointer, startFreeform, type SelectionShape } from '@/lib/selectionSemantics';
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

/**
 * PK1 — isolated Apple PencilKit physical spike (see project notes). Gates
 * the "DEV · Apple Pen Test" entry point to the Dev bundle only.
 *
 * `__DEV__` is NOT used here: this Dev IPA is built Release-style (no Metro
 * dependency at runtime), so `__DEV__` is false in it — a prior Dev-only UI
 * incident was invisible on-device for exactly this reason. The app's own
 * embedded bundle identifier, read via expo-constants, is the reliable
 * runtime signal that actually distinguishes the Dev binary from Production.
 */
const PENCILKIT_TEST_DEV_ENABLED = Constants.expoConfig?.ios?.bundleIdentifier === 'com.aydenz.youmilensipad.dev';

/**
 * PK3-A Step 5 — fixed canvas-space registration targets for the owner to
 * draw through with real Apple Pencil, then scroll/zoom away and back to,
 * to detect viewport drift objectively rather than only by feel. Purely
 * visual (plain Views, `pointerEvents="none"`) — never persisted, never
 * part of any stroke/drawing data. Spread far enough vertically that
 * reaching B or C requires a real, substantial scroll from A.
 */
const PK3A_REGISTRATION_TARGETS: { id: string; x: number; y: number }[] = [
  { id: 'A', x: 120, y: 150 },
  { id: 'B', x: 220, y: 1600 },
  { id: 'C', x: 90, y: 3100 },
];

const PEN_COLORS: { key: string; value: string }[] = [
  { key: 'Charcoal', value: '#222630' },
  { key: 'Blue', value: '#2D6BD4' },
  { key: 'Red', value: '#E23B47' },
  { key: 'Orange', value: '#F08A1E' },
  { key: 'Purple', value: '#9B30C9' },
  { key: 'White', value: '#FFFFFF' },
  { key: 'Teal', value: '#1FB58E' },
];

// ---- Navy toolbar tokens — the 10 shared with Course Material now come
// ---- from lib/sharedToolbarChrome.ts (see the import above); only
// ---- TOOLBAR_DELETE_RED is genuinely Notebook-only. ----
const TOOLBAR_DELETE_RED = '#FF8A8A';

// Values sourced from the shared LEGACY_STYLE_PEN_WIDTHS preset table
// (verified identical to Course Material's own pen widths — see PK4-A); only
// `dot` (the preview-dot diameter) is Notebook-local presentation detail.
const PEN_WIDTHS: { key: string; value: number; dot: number }[] = [
  { key: 'Thin', value: LEGACY_STYLE_PEN_WIDTHS.thin, dot: 7 },
  { key: 'Medium', value: LEGACY_STYLE_PEN_WIDTHS.medium, dot: 11 },
  { key: 'Thick', value: LEGACY_STYLE_PEN_WIDTHS.thick, dot: 16 },
];

const HIGHLIGHTER_COLORS: { key: string; value: string }[] = [
  { key: 'Yellow', value: 'rgba(245,210,70,0.9)' },
  { key: 'Green', value: 'rgba(120,215,140,0.85)' },
  { key: 'Pink', value: 'rgba(245,150,190,0.85)' },
  { key: 'Blue', value: 'rgba(120,180,245,0.85)' },
];

// Values sourced from the shared HIGHLIGHTER_WIDTHS preset table (verified
// identical to Course Material's own — see PK4-A).
const HIGHLIGHTER_WIDTHS: { key: string; value: number; dot: number }[] = [
  { key: 'Narrow', value: SHARED_HIGHLIGHTER_WIDTHS.narrow, dot: 8 },
  { key: 'Medium', value: SHARED_HIGHLIGHTER_WIDTHS.medium, dot: 12 },
  { key: 'Wide', value: SHARED_HIGHLIGHTER_WIDTHS.wide, dot: 17 },
];

type EraserSizeKey = 'small' | 'medium' | 'large';

// Radii sourced from the shared NOTEBOOK_ERASER_RADII preset table (verified
// DIFFERENT from Course Material's own eraser radii — see PK4-A; kept as
// Notebook's own table, not unified with Course Material's).
const ERASER_SIZES: { key: EraserSizeKey; label: string; radius: number }[] = [
  { key: 'small', label: 'Small', radius: NOTEBOOK_ERASER_RADII.small },
  { key: 'medium', label: 'Medium', radius: NOTEBOOK_ERASER_RADII.medium },
  { key: 'large', label: 'Large', radius: NOTEBOOK_ERASER_RADII.large },
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
// PK4-C1: all toolbar chrome/layout/dock constants now live in
// components/SharedAnnotationToolbar.tsx, the one authoritative toolbar
// component both Notebook and Course Material render — see the PK4-C1
// report. This key now persists only Notebook's last-used tool + eraser
// preset (not dock/collapsed, which SharedAnnotationToolbar persists itself
// under its own storageKey prop).
const NOTEBOOK_TOOL_PREFERENCES_KEY = 'youmi.notebookToolPrefs.v1';
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
export type NotebookOverlayRect = { x: number; y: number; width: number; height: number };

/** Notebook's own persisted tool preferences — just the last-used tool and
 * eraser preset. Toolbar dock/collapsed state is persisted separately by
 * SharedAnnotationToolbar itself (see NOTEBOOK_TOOLBAR_STORAGE_KEY below). */
type NotebookToolPreferences = {
  mode: CanvasMode;
  eraserSize: EraserSizeKey;
};

const DEFAULT_TOOL_PREFERENCES: NotebookToolPreferences = {
  mode: 'write',
  eraserSize: 'medium',
};

/**
 * Primary row tools, left to right. Hand (scroll) and Minimize are rendered
 * separately after the divider. Derived from the shared, capability-filtered
 * tool registry (lib/notebookAnnotationAdapter.ts) rather than an
 * independently hardcoded array — same 6 tools, same order, as before.
 */
const PRIMARY_TOOLS: { key: CanvasMode; label: string }[] = notebookSharedTools().map((tool) => ({
  key: sharedToolToNotebookMode(tool),
  label: notebookToolLabel(tool),
}));
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

/**
 * Rect (canvas coords) that the floating Duplicate/Delete bar anchors to: the selected
 * image, or the outline bounds of a selected structured shape. Null for anything else.
 */
function selectionActionRect(
  id: string,
  strokes: readonly NoteStroke[],
  images: readonly NoteImage[],
): { x: number; y: number; width: number; height: number } | null {
  const image = images.find((candidate) => candidate.id === id);
  if (image) return { x: image.x, y: image.y, width: image.width, height: image.height };
  const stroke = strokes.find((candidate) => candidate.id === id);
  if (!stroke || !isStructuredStroke(stroke) || stroke.points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of stroke.points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** A structured shape is directly interactive whichever of these tools is active (Select, Pen, Highlighter). */
const isSelectionInteractiveMode = (mode: CanvasMode): boolean => mode === 'select' || mode === 'write' || mode === 'highlight';

type ActiveInkHandle = {
  begin: (point: NotePoint) => void;
  append: (point: NotePoint) => void;
  clear: () => void;
  getPoints: () => NotePoint[];
  /** Shape Snap: replace the live stroke with clean geometry and ignore further samples until the next begin(). */
  freeze: (points: NotePoint[], shape?: AnnotationShape) => void;
  /** The structured shape a Shape Snap produced for the live stroke (null for ordinary handwriting). */
  getShape: () => AnnotationShape | null;
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
    const frozenRef = useRef(false);
    const shapeRef = useRef<AnnotationShape | null>(null);
    const [livePoints, setLivePoints] = useState<NotePoint[]>([]);

    useImperativeHandle(
      ref,
      () => ({
        begin(point: NotePoint) {
          frozenRef.current = false;
          shapeRef.current = null;
          pointsRef.current = [point];
          setLivePoints([point]);
        },
        append(point: NotePoint) {
          if (frozenRef.current) return;
          if (!appendStrokePoint(pointsRef.current, point, MIN_POINT_DISTANCE)) return;
          // Slice so React sees a new points array and StrokeShape rebuilds the path.
          setLivePoints(pointsRef.current.slice());
        },
        freeze(points: NotePoint[], shape?: AnnotationShape) {
          frozenRef.current = true;
          shapeRef.current = shape ?? null;
          pointsRef.current = points;
          setLivePoints(points.slice());
        },
        clear() {
          frozenRef.current = false;
          shapeRef.current = null;
          if (pointsRef.current.length === 0) return;
          pointsRef.current = [];
          setLivePoints([]);
        },
        getPoints() {
          return pointsRef.current;
        },
        getShape() {
          return shapeRef.current;
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
          <StrokeShape stroke={{ points: livePoints, tool, color, width, opacity }} />
        </Svg>
      </View>
    );
  }),
);

type SelectionScaleHandle = {
  /** Snapshot the selected strokes + scale anchor; the host now owns their on-screen geometry. */
  begin: (strokes: NoteStroke[], center: NotePoint) => void;
  /** Live factor (one setState on THIS component only — never the canvas). */
  update: (factor: number) => void;
  end: () => void;
};

/**
 * Live preview of a two-finger scale. Always renders ORIGINAL_GEOMETRY x CURRENT_FACTOR from
 * the begin-time snapshot (immune to store echoes mid-gesture, no accumulation, no drift), keeps
 * pen width, and draws its own selection outline / shape handles from the SCALED geometry.
 */
const SelectionScaleHost = memo(
  forwardRef<SelectionScaleHandle, { canvasHeight: number; scale: number }>(function SelectionScaleHost(
    { canvasHeight, scale },
    ref,
  ) {
    const [session, setSession] = useState<{ strokes: NoteStroke[]; center: NotePoint; factor: number } | null>(null);
    useImperativeHandle(
      ref,
      () => ({
        begin: (strokes, center) => setSession({ strokes, center, factor: 1 }),
        update: (factor) => setSession((current) => (current ? { ...current, factor } : current)),
        end: () => setSession(null),
      }),
      [],
    );
    if (!session) return null;
    const scaled = session.strokes.map((stroke) => scaleInkStroke(stroke, session.center, session.factor));
    const bounds = boundsOfPoints(scaled.flatMap((stroke) => stroke.points));
    const unit = 1 / Math.max(scale, 0.01);
    const pad = 8;
    const single = scaled.length === 1 && isStructuredStroke(scaled[0]) ? scaled[0] : null;
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height={canvasHeight}>
          {scaled.flatMap((stroke) => [
            <StrokeShape key={`${stroke.id}_hl`} stroke={{ ...stroke, width: stroke.width + 5, color: '#5F86E8', opacity: 0.28 }} />,
            <StrokeShape key={stroke.id} stroke={stroke} />,
          ])}
          {bounds && !single ? (
            <Path
              d={`M ${bounds.minX - pad} ${bounds.minY - pad} h ${bounds.maxX - bounds.minX + pad * 2} v ${bounds.maxY - bounds.minY + pad * 2} h ${-(bounds.maxX - bounds.minX + pad * 2)} Z`}
              stroke="#5F86E8"
              strokeWidth={1.5}
              strokeDasharray="6 3"
              strokeLinecap="round"
              fill="rgba(95,134,232,0.06)"
            />
          ) : null}
          {single && single.shape
            ? shapeHandles(single.shape.geometry).map((h, i) => (
                <Circle key={i} cx={h.x} cy={h.y} r={SHAPE_HANDLE_RADIUS_PT * unit} fill="#FFFFFF" stroke="#5F86E8" strokeWidth={2 * unit} />
              ))
            : null}
        </Svg>
      </View>
    );
  }),
);

type ShapeHandlesHandle = {
  /** Start a live handle edit: the host now draws the edited outline itself. */
  begin: (geometry: ShapeGeometry) => void;
  /** Live preview geometry (one setState on THIS component only — never the canvas). */
  update: (geometry: ShapeGeometry) => void;
  end: () => void;
};

type ShapeHandlesHostProps = {
  canvasHeight: number;
  /** The single selected structured stroke, or null. */
  stroke: NoteStroke | null;
  /** Screen points per canvas unit: handle size/hit area are defined in screen points. */
  scale: number;
  moveOffset: NotePoint;
};

/**
 * Structured-shape handles + live edit preview. Handles are UI only (never stored).
 * While a handle is dragged this host owns the outline (the canvas hides the original
 * stroke), and its state is local, so a Pencil drag never re-renders the canvas.
 */
const ShapeHandlesHost = memo(
  forwardRef<ShapeHandlesHandle, ShapeHandlesHostProps>(function ShapeHandlesHost(
    { canvasHeight, stroke, scale, moveOffset },
    ref,
  ) {
    const [preview, setPreview] = useState<ShapeGeometry | null>(null);
    useImperativeHandle(
      ref,
      () => ({
        begin: (geometry) => setPreview(geometry),
        update: (geometry) => setPreview(geometry),
        end: () => setPreview(null),
      }),
      [],
    );
    if (!stroke || !isStructuredStroke(stroke)) return null;
    const geometry = preview ?? stroke.shape.geometry;
    const unit = 1 / Math.max(scale, 0.01);
    const previewPoints = preview ? shapeToInkPoints({ origin: stroke.shape.origin, geometry: preview }) : null;
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height={canvasHeight}>
          <G translateX={moveOffset.x} translateY={moveOffset.y}>
            {previewPoints ? (
              <StrokeShape stroke={{ points: previewPoints, tool: stroke.tool, color: stroke.color, width: stroke.width, opacity: stroke.opacity }} />
            ) : null}
            {shapeHandles(geometry).map((h, i) => (
              <Circle
                key={i}
                cx={h.x}
                cy={h.y}
                r={SHAPE_HANDLE_RADIUS_PT * unit}
                fill="#FFFFFF"
                stroke="#5F86E8"
                strokeWidth={2 * unit}
              />
            ))}
          </G>
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
            d={`M ${lassoPoints.map((p) => `${p.x} ${p.y}`).join(' L ')}`}
            stroke="#5F86E8"
            strokeWidth={1.6}
            strokeDasharray="5 3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ) : null}
        {showSelectionRect && selectionRect ? (
          <Rect
            x={selectionRect.x}
            y={selectionRect.y}
            width={selectionRect.width}
            height={selectionRect.height}
            rx={0}
            stroke="#5F86E8"
            strokeWidth={1.6}
            strokeDasharray="6 4"
            fill="none"
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

const SHARED_TOOLBAR_GLYPH_NAMES: readonly ToolbarGlyphName[] = [
  'pen',
  'highlighter',
  'eraser',
  'undo',
  'redo',
  'hand',
  'more',
  'trash',
  'chevronUp',
  'chevronLeft',
  'chevronRight',
];

/** Maps a local Notebook glyph name to its shared-module counterpart, or
 * `null` for a Notebook-only glyph (select/insert/duplicate/
 * chevronDown). */
function toSharedGlyphName(name: ToolbarGlyphName): SharedToolbarGlyphName | null {
  if (name === 'type') return 'text';
  return SHARED_TOOLBAR_GLYPH_NAMES.includes(name) ? (name as SharedToolbarGlyphName) : null;
}

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
  // The 10 glyphs verified byte-identical to Course Material's own icon set
  // (see the PK4-B0 report) now render through the shared path data — never
  // a second, independently-maintained copy. Notebook's 'type' is the same
  // glyph as the shared vocabulary's 'text'.
  const sharedGlyphName: SharedToolbarGlyphName | null = toSharedGlyphName(name);

  return (
    <Svg width={size} height={size} viewBox="0 0 28 28" accessibilityElementsHidden>
      {sharedGlyphName ? <SharedToolbarGlyphPaths name={sharedGlyphName} color={color} /> : null}
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
    </Svg>
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
  /** PK3-B only — the owning lecture/note's stable id, used to key durable
   * PencilKit ink storage (never the title — see notebookInkStorage.ts).
   * Omit for call sites that never enable the Dev Native Ink Layer; the
   * layer's save/load simply no-ops without it. */
  noteId?: string;
  /** PK3-B only — whether the Notebook editor is the foreground/open surface
   * right now (e.g. the parent's edit-modal `visible` state). Used only to
   * flush a pending PencilKit ink save immediately when the editor is about
   * to leave the foreground; defaults to true so callers that never pass it
   * behave exactly as before (debounce + backgrounding are still enough to
   * eventually persist). Does not affect legacy NoteStroke/text/image save
   * semantics, which remain entirely unchanged. */
  notebookOpen?: boolean;
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
  noteId,
  notebookOpen = true,
}: NotebookCanvasProps) {
  const t = useT();
  const images = useMemo(() => rawImages ?? [], [rawImages]);
  const onImagesChange = rawOnImagesChange ?? NOOP_IMAGES_CHANGE;
  const [mode, setMode] = useState<CanvasMode>(DEFAULT_TOOL_PREFERENCES.mode);
  // PK1 — isolated Apple PencilKit physical spike. Entirely local UI state;
  // no Notebook data is read or written by opening/closing/clearing this.
  const [pencilKitTestOpen, setPencilKitTestOpen] = useState(false);
  const pencilKitTestSurfaceRef = useRef<PencilKitTestSurfaceRef>(null);
  // PK3-A — session-only native ink layer proof inside the REAL Notebook
  // viewport. Entirely local UI state; toggling, drawing, and clearing this
  // never reads or writes NoteStroke/AsyncStorage/cloud data. `Ref` mirror
  // read inside the drawGesture callback below (a plain ref, like modeRef/
  // drawingRef already used there — no gesture dependency-array change needed).
  const [devNativeInkLayerEnabled, setDevNativeInkLayerEnabled] = useState(false);
  const devNativeInkLayerEnabledRef = useRef(false);
  devNativeInkLayerEnabledRef.current = devNativeInkLayerEnabled;
  const devNativeInkSurfaceRef = useRef<PencilKitTestSurfaceRef>(null);

  // PK3-A gesture-ownership fix: the outer Notebook viewport must lock ONLY
  // while a real PencilKit stroke is in progress — not for the whole time
  // the Dev Native Ink Layer toggle is on. This is driven by PencilKit's own
  // authoritative BEGIN/END lifecycle (PKCanvasViewDelegate.
  // canvasViewDidBeginUsingTool/canvasViewDidEndUsingTool — see
  // PencilKitTestModule.swift), not approximated from `mode`.
  const [devNativeInkStrokeActive, setDevNativeInkStrokeActive] = useState(false);
  const devNativeInkStrokeWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDevNativeInkStrokeWatchdog = useCallback(() => {
    if (devNativeInkStrokeWatchdogRef.current != null) {
      clearTimeout(devNativeInkStrokeWatchdogRef.current);
      devNativeInkStrokeWatchdogRef.current = null;
    }
  }, []);
  // Fail-safe only: canvasViewDidEndUsingTool's behavior under an OS-level
  // interruption (app backgrounded, phone call, Control Center mid-stroke)
  // is not documented as guaranteed. This bounded one-shot timer per stroke
  // guarantees the viewport can never be left permanently locked even if a
  // real "end" event is ever lost — it is cleared instantly by any real
  // begin/end event and never produces per-frame work.
  const DEV_NATIVE_INK_STROKE_WATCHDOG_MS = 4000;
  // Ref mirror for the PK3-B save scheduler, declared further down this same
  // component function — see the usage comment below for why a ref indirection
  // (not a direct dependency) is required here.
  const scheduleDevNativeInkSaveRef = useRef<() => void>(() => {});
  const handleDevNativeInkStrokeActiveChange = useCallback(
    (event: { nativeEvent: { active: boolean } }) => {
      clearDevNativeInkStrokeWatchdog();
      const active = event.nativeEvent.active;
      setDevNativeInkStrokeActive(active);
      if (active) {
        devNativeInkStrokeWatchdogRef.current = setTimeout(() => {
          devNativeInkStrokeWatchdogRef.current = null;
          setDevNativeInkStrokeActive(false);
        }, DEV_NATIVE_INK_STROKE_WATCHDOG_MS);
      } else {
        // PK3-B "stroke completion" save trigger (Step 6) — a real PencilKit
        // stroke just ended; schedule a debounced durable save. Read via a
        // ref (like modeRef/devNativeInkLayerEnabledRef elsewhere in this
        // file) rather than a direct dependency, since scheduleDevNativeInk
        // Save's identity changes with `noteId` and this handler must always
        // save to whichever note is current NOW, not the one bound when this
        // memoized callback was first created (Step 12: switching notes must
        // never save a completed stroke to the wrong file).
        scheduleDevNativeInkSaveRef.current();
      }
    },
    [clearDevNativeInkStrokeWatchdog],
  );
  // Fail-safe: toggling the layer off, or switching away from write mode,
  // immediately restores scrolling even if no "end" event ever arrives (e.g.
  // the toggle is flipped mid-stroke, or the user switches tools mid-stroke).
  useEffect(() => {
    if (!devNativeInkLayerEnabled || mode !== 'write') {
      clearDevNativeInkStrokeWatchdog();
      setDevNativeInkStrokeActive(false);
    }
  }, [devNativeInkLayerEnabled, mode, clearDevNativeInkStrokeWatchdog]);
  // Fail-safe: never leak the watchdog timer past unmount.
  useEffect(() => () => clearDevNativeInkStrokeWatchdog(), [clearDevNativeInkStrokeWatchdog]);

  // ---- PK3-B durable PencilKit ink persistence (see the PK3-B report) ----
  // Entirely additive: never reads or writes noteStrokes/noteImages/notes,
  // never touches the `lectures` AsyncStorage array. One raw PKDrawing file
  // per lecture, keyed by `noteId` (never title — see notebookInkStorage.ts
  // and PK3-B Step 12). Bytes never cross the JS bridge, only the `file://`
  // path does (see PencilKitTestModule.swift's saveDrawingAsync).
  type DevNativeInkSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';
  const [devNativeInkSaveState, setDevNativeInkSaveState] = useState<DevNativeInkSaveState>('idle');
  const devNativeInkSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const DEV_NATIVE_INK_SAVE_DEBOUNCE_MS = 900;

  const clearDevNativeInkSaveTimer = useCallback(() => {
    if (devNativeInkSaveTimerRef.current != null) {
      clearTimeout(devNativeInkSaveTimerRef.current);
      devNativeInkSaveTimerRef.current = null;
    }
  }, []);

  /** Durably writes the current native drawing NOW (no debounce) — the
   * "explicit lifecycle flush" trigger: app backgrounding, the Notebook
   * editor leaving the foreground, or the debounce timer itself elapsing. */
  const flushDevNativeInkSave = useCallback(async () => {
    clearDevNativeInkSaveTimer();
    if (!noteId || !devNativeInkLayerEnabledRef.current) return;
    const uri = notebookInkFileUri(noteId);
    if (!uri) return;
    if (isMountedRef.current) setDevNativeInkSaveState('saving');
    try {
      const result = await devNativeInkSurfaceRef.current?.save(uri);
      if (!isMountedRef.current) return;
      setDevNativeInkSaveState(result?.success ? 'saved' : 'failed');
      if (__DEV__ && !result?.success) {
        console.warn('[PK3-B] native ink durable save failed', { noteId });
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setDevNativeInkSaveState('failed');
      if (__DEV__) console.warn('[PK3-B] native ink durable save threw', err);
    }
  }, [clearDevNativeInkSaveTimer, noteId]);

  /** Marks the drawing dirty and schedules a bounded debounce save — the
   * "stroke completion" trigger. Never fires synchronous disk I/O on every
   * Pencil move; only once per completed stroke, coalesced across a rapid
   * burst of strokes into one write after DEV_NATIVE_INK_SAVE_DEBOUNCE_MS
   * of quiet. */
  const scheduleDevNativeInkSave = useCallback(() => {
    setDevNativeInkSaveState('dirty');
    clearDevNativeInkSaveTimer();
    devNativeInkSaveTimerRef.current = setTimeout(() => {
      devNativeInkSaveTimerRef.current = null;
      void flushDevNativeInkSave();
    }, DEV_NATIVE_INK_SAVE_DEBOUNCE_MS);
  }, [clearDevNativeInkSaveTimer, flushDevNativeInkSave]);
  scheduleDevNativeInkSaveRef.current = scheduleDevNativeInkSave;

  // Fail-safe: never leak the debounce timer past unmount.
  useEffect(() => () => clearDevNativeInkSaveTimer(), [clearDevNativeInkSaveTimer]);

  // App-background trigger (Step 6/10) — covers force-kill: entering the App
  // Switcher backgrounds the app BEFORE any swipe-to-kill can happen, so a
  // completed stroke saved here is durable before a kill that follows it.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        void flushDevNativeInkSave();
      }
    });
    return () => subscription.remove();
  }, [flushDevNativeInkSave]);

  // "Leaving Notebook" trigger (Step 6) — flush the instant the editor stops
  // being the foreground surface, regardless of whether the parent's own
  // Cancel/Done draft-discard logic (unrelated, legacy-only) would otherwise
  // discard anything. PencilKit ink is never discardable via that legacy
  // Cancel path — this additive layer commits independently.
  const notebookOpenRef = useRef(notebookOpen);
  useEffect(() => {
    if (notebookOpenRef.current && !notebookOpen) {
      void flushDevNativeInkSave();
    }
    notebookOpenRef.current = notebookOpen;
  }, [notebookOpen, flushDevNativeInkSave]);

  // Note-identity trigger (Step 12) — load the CURRENT note's saved drawing
  // fresh whenever the layer becomes active (first enable, or switching
  // between notes while it's already on). The native surface is unmounted/
  // remounted whenever the layer toggles off/on (see the JSX below), so a
  // remount always starts from a blank canvas already — no explicit clear()
  // is needed here, only a fresh load for whichever note is current now.
  useEffect(() => {
    if (!devNativeInkLayerEnabled) return;
    setDevNativeInkSaveState('idle');
    if (!noteId) return;
    const uri = notebookInkFileUri(noteId);
    if (!uri) return;
    void devNativeInkSurfaceRef.current?.load(uri);
  }, [devNativeInkLayerEnabled, noteId]);

  const [penColor, setPenColor] = useState(PEN_COLORS[0].value);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1].value);
  const [highlighterColor, setHighlighterColor] = useState(HIGHLIGHTER_COLORS[0].value);
  const [highlighterWidth, setHighlighterWidth] = useState(HIGHLIGHTER_WIDTHS[1].value);
  const [eraserSizeKey, setEraserSizeKey] = useState<EraserSizeKey>(
    DEFAULT_TOOL_PREFERENCES.eraserSize,
  );
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [toolPreferencesLoaded, setToolPreferencesLoaded] = useState(false);
  const eraserRadius = ERASER_SIZES.find((option) => option.key === eraserSizeKey)?.radius ?? 26;
  /** SharedAnnotationToolbar's generic SizeOption shape ({key,value,dot}) —
   * adapted from Notebook's own ERASER_SIZES ({key,label,radius}) without
   * changing any accepted radius value. `dot` matches the exact preview-dot
   * sizes the toolbar's context row already used (8/13/19). */
  const sharedEraserSizeOptions = useMemo(
    () =>
      ERASER_SIZES.map((option) => ({
        key: option.key,
        value: option.radius,
        dot: option.key === 'small' ? 8 : option.key === 'medium' ? 13 : 19,
      })),
    [],
  );
  const handleSelectEraserRadius = useCallback((radius: number) => {
    const found = ERASER_SIZES.find((option) => option.radius === radius);
    if (found) setEraserSizeKey(found.key);
  }, []);

  // Notebook's own persisted tool/eraser preset — separate from
  // SharedAnnotationToolbar's own dock/collapsed persistence (different
  // AsyncStorage key, so the two never collide).
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(NOTEBOOK_TOOL_PREFERENCES_KEY)
      .then((raw) => {
        if (!active || !raw) return;
        const stored = JSON.parse(raw) as Partial<NotebookToolPreferences>;
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
        if (active) setToolPreferencesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!toolPreferencesLoaded) return;
    const preferences: NotebookToolPreferences = { mode, eraserSize: eraserSizeKey };
    AsyncStorage.setItem(NOTEBOOK_TOOL_PREFERENCES_KEY, JSON.stringify(preferences)).catch(() => {});
  }, [eraserSizeKey, mode, toolPreferencesLoaded]);
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
  /** Container (Canvas) ref — measured on layout for page/paper geometry. */
  const containerRef = useRef<View>(null);
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
  // ONE authoritative selection state machine (lib/selectionMachine.ts). `selectedIds` state is
  // only its rendering projection: every change goes through dispatchSelection with an explicit
  // event, so ambient things (gesture end, store echo, rerender, handle-drag completion, ...)
  // cannot clear a selection.
  const selectionMachineRef = useRef<SelectionState>(IDLE_SELECTION);
  const dispatchSelection = useCallback((event: SelectionEvent, source?: string) => {
    const before = selectionMachineRef.current;
    const result = selectionReduce(before, event);
    selectionMachineRef.current = result.state;
    if (SELECTION_TRACE_ENABLED) traceSelection('notebook', event, result, before.kind, source);
    const ids = selectedIdsOf(result.state);
    const current = selectedIdsRef.current;
    if (ids.length !== current.size || ids.some((id) => !current.has(id))) {
      const next = new Set(ids);
      selectedIdsRef.current = next;
      setSelectedIds(next);
    }
    return result;
  }, []);
  const selectionShapeRef = useRef<SelectionShape>('lasso');
  selectionShapeRef.current = selectionShape;
  /** 'lasso'/'rect' while drawing a selection shape; 'move' while dragging selected objects. */
  const selectActionRef = useRef<'idle' | 'lasso' | 'rect' | 'move' | 'handle' | 'scale'>('idle');
  // Structured-shape handle edit (Shape System Phase 2). `editingShapeId` hides the
  // original stroke ONLY between drag begin and the store echo of the edit; the live
  // outline is drawn by ShapeHandlesHost from its own state.
  const [editingShapeId, setEditingShapeId] = useState<string | null>(null);
  const shapeHandlesRef = useRef<ShapeHandlesHandle>(null);
  const shapeEditRef = useRef<{
    original: NoteStroke & { shape: AnnotationShape };
    index: number;
    grabOffset: NotePoint;
    geometry: ShapeGeometry;
    changed: boolean;
  } | null>(null);
  const shapeEditAwaitingRef = useRef<NoteStroke | null>(null);
  // Selection manipulation by touch (Selection Interaction Phase): one-finger move / two-finger scale.
  const fingerManipulationRef = useRef(false);
  /** When the live Pen/Highlighter stroke began: a TAP is decided from gesture evidence at Pencil-up. */
  const penStrokeStartedAtRef = useRef(0);
  const [scalingActive, setScalingActive] = useState(false);
  const scaleHostRef = useRef<SelectionScaleHandle>(null);
  const scaleAwaitingRef = useRef<NoteStroke[] | null>(null);
  const scaleSessionRef = useRef<{
    ids: Set<string>;
    originals: NoteStroke[];
    center: NotePoint;
    startDistance: number;
    touchIds: [number, number];
    factor: number;
    span: number;
    unitsPerPt: number;
  } | null>(null);
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
  /** Pending tool-toast hide timer. */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whether native Apple Pencil double-tap is compiled into this build. */
  const doubleTapAvailable = useMemo(() => isPencilDoubleTapAvailable(), []);

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
      // Leave any active selection behind when switching tools — but only when
      // there is actually something to clear. selectedIds is a dependency of
      // the stroke-render memo, so replacing it with a new (still-empty) Set
      // on every ordinary Pen/Eraser/Highlighter/Text switch invalidated that
      // memo and re-filtered every stroke on the page for no reason.
      if (selectedIdsRef.current.size > 0) {
        dispatchSelection({ type: 'TOOL_CHANGE', tool: next }, 'changeMode');
      }
      if (lassoPointsRef.current.length > 0) {
        lassoPointsRef.current = [];
        setLassoPoints([]);
      }
    }
    setMode(next);
  }, [dispatchSelection]);

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
    // Undo/redo keeps the selection for every object that still exists in the restored state.
    dispatchSelection({ type: 'CONTENT_CHANGED', existingIds: [...next.strokes.map((stroke) => stroke.id), ...next.images.map((image) => image.id)] }, 'applySnapshot');
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
  }, [dispatchSelection]);

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
    dispatchSelection({ type: 'SELECT_INK', ids: [id] }, 'image-tap-select');
  }, [dispatchSelection]);

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
      dispatchSelection({ type: 'SELECT_INK', ids: [id] }, 'image-gesture');
      holdImageScrollLock();
      imageGestureStartRef.current = {
        id,
        image: cloneImage(image),
        snapshot: captureSnapshot(),
        changed: false,
        committed: false,
      };
    },
    [captureSnapshot, dispatchSelection, holdImageScrollLock],
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

  /** Selects `ids`; a single structured shape becomes SELECTED_SHAPE (handles), anything else SELECTED_INK. */
  const selectIds = useCallback((ids: string[], source: string) => {
    const only = ids.length === 1 ? strokesRef.current.find((stroke) => stroke.id === ids[0]) : undefined;
    dispatchSelection(only && isStructuredStroke(only) ? { type: 'TAP_SHAPE', id: only.id } : { type: 'SELECT_INK', ids }, source);
  }, [dispatchSelection]);

  /**
   * A select-tool TAP (tiny extent) on a structured shape's outline selects that shape
   * directly (handles appear). Text/ordinary ink are unaffected: only strokes with a
   * `shape` are hit-tested, and only outline-near taps count.
   */
  const trySelectShapeAt = useCallback((point: NotePoint): boolean => {
    const unit = 1 / (canvasScaleRef.current || 1);
    const hit = hitTestStructuredStroke(strokesRef.current, point, SHAPE_TAP_SELECT_PT * unit);
    if (!hit) return false;
    dispatchSelection({ type: 'TAP_SHAPE', id: hit.id }, 'tap-shape');
    return true;
  }, [dispatchSelection]);

  /** Region drags past the tap threshold drop the previous selection (explicit "new selection"). */
  const regionDraggedRef = useRef(false);

  const commitLasso = useCallback(() => {
    const lasso = lassoPointsRef.current;
    const unit = 1 / (canvasScaleRef.current || 1);
    const box = boundsOfPoints(lasso);
    const isTap = !box || boundsSpan(box) < SHAPE_TAP_MAX_EXTENT_PT * unit;
    if (isTap) {
      // A tap selects the shape under it, otherwise it is a blank tap (explicit deselect).
      if (lasso.length > 0 && trySelectShapeAt(lasso[0])) return;
      dispatchSelection({ type: 'REGION_CANCELLED' }, 'lasso-tap');
      dispatchSelection({ type: 'TAP_BLANK' }, 'lasso-tap');
      return;
    }
    const ids = lasso.length < 3 ? new Set<string>() : selectedInkIds(strokesRef.current, 'lasso', lasso);
    dispatchSelection({ type: 'REGION_DRAGGED' }, 'lasso');
    dispatchSelection({ type: 'REGION_COMPLETE', ids: [...ids] }, 'lasso');
    if (ids.size === 1) selectIds([...ids], 'lasso');
  }, [dispatchSelection, selectIds, trySelectShapeAt]);

  const commitRectSelection = useCallback(() => {
    const start = selectionRectStartRef.current;
    const end = selectionRectEndRef.current;
    if (!start || !end) return;
    const rect = boxFromCorners(start, end);
    const tapUnit = 1 / (canvasScaleRef.current || 1);
    if (Math.max(rect.width, rect.height) < SHAPE_TAP_MAX_EXTENT_PT * tapUnit) {
      if (trySelectShapeAt(start)) return;
      dispatchSelection({ type: 'REGION_CANCELLED' }, 'rect-tap');
      dispatchSelection({ type: 'TAP_BLANK' }, 'rect-tap');
      return;
    }
    const ids = rect.width < 3 || rect.height < 3 ? new Set<string>() : selectedInkIds(strokesRef.current, 'rect', [start, end]);
    dispatchSelection({ type: 'REGION_DRAGGED' }, 'rect');
    dispatchSelection({ type: 'REGION_COMPLETE', ids: [...ids] }, 'rect');
    if (ids.size === 1) selectIds([...ids], 'rect');
  }, [dispatchSelection, selectIds, trySelectShapeAt]);

  const finishShapeEditVisuals = useCallback(() => {
    shapeEditAwaitingRef.current = null;
    shapeEditRef.current = null;
    shapeHandlesRef.current?.end();
    setEditingShapeId(null);
  }, []);

  const finishScaleVisuals = useCallback(() => {
    scaleAwaitingRef.current = null;
    scaleSessionRef.current = null;
    scaleHostRef.current?.end();
    setScalingActive(false);
  }, []);

  /** ONE history action for the whole pinch; the preview stays until the store echoes the result. */
  const commitScale = useCallback(() => {
    const session = scaleSessionRef.current;
    scaleSessionRef.current = null;
    if (!session || Math.abs(session.factor - 1) < 0.005) {
      finishScaleVisuals();
      return;
    }
    recordHistory();
    scaleAwaitingRef.current = session.originals;
    onStrokesChangeRef.current(scaleSelectedStrokes(strokesRef.current, session.ids, session.center, session.factor));
    // Fallback: never leave the originals hidden if the store echo is lost.
    setTimeout(() => {
      if (scaleAwaitingRef.current === session.originals) finishScaleVisuals();
    }, 800);
  }, [finishScaleVisuals, recordHistory]);

  /** ONE history action for the whole manipulation; the live preview stays until the store echoes the edit. */
  const commitShapeEdit = useCallback(() => {
    const edit = shapeEditRef.current;
    if (!edit) return;
    if (!edit.changed) {
      finishShapeEditVisuals();
      return;
    }
    recordHistory();
    const edited = strokeWithShape(edit.original, { origin: edit.original.shape.origin, geometry: edit.geometry });
    shapeEditAwaitingRef.current = edit.original;
    onStrokesChangeRef.current(strokesRef.current.map((s) => (s.id === edit.original.id ? edited : s)));
    // Fallback: never leave the original hidden if the store echo is lost.
    setTimeout(() => {
      if (shapeEditAwaitingRef.current === edit.original) finishShapeEditVisuals();
    }, 800);
  }, [finishShapeEditVisuals, recordHistory]);

  const commitMove = useCallback(() => {
    const { x: dx, y: dy } = selectionMoveOffsetRef.current;
    if (dx === 0 && dy === 0) return;
    const ids = selectedIdsRef.current;
    const movesStroke = strokesRef.current.some((stroke) => ids.has(stroke.id));
    const movesImage = imagesRef.current.some((image) => ids.has(image.id));
    if (!movesStroke && !movesImage) return;
    recordHistory();
    const newStrokes = strokesRef.current.map((s) =>
      ids.has(s.id) ? translateInkStroke(s, dx, dy) : s,
    );
    onStrokesChangeRef.current(newStrokes);
    const newImages = imagesRef.current.map((img) =>
      ids.has(img.id) ? { ...img, x: img.x + dx, y: img.y + dy } : img,
    );
    onImagesChangeRef.current(newImages);
  }, [recordHistory]);

  useEffect(() => {
    const awaiting = shapeEditAwaitingRef.current;
    if (!awaiting) return;
    const current = strokes.find((stroke) => stroke.id === awaiting.id);
    if (!current || current !== awaiting) finishShapeEditVisuals();
  }, [strokes, finishShapeEditVisuals]);

  useEffect(() => {
    const awaiting = scaleAwaitingRef.current;
    if (!awaiting) return;
    const settled = awaiting.every((original) => strokes.find((stroke) => stroke.id === original.id) !== original);
    if (settled) finishScaleVisuals();
  }, [strokes, finishScaleVisuals]);

  // Commit the in-progress stroke (read synchronously from the active-ink host)
  // as its own new stroke, then clear it. A 1-point stroke is kept — it renders as a dot.
  const commitStroke = useCallback(() => {
    const commitStartedAt = PENCILKIT_TEST_DEV_ENABLED ? Date.now() : 0;
    const pts = activeInkRef.current?.getPoints() ?? [];
    const snappedShape = activeInkRef.current?.getShape() ?? null;
    // A quick TAP on an existing structured shape selects it (handles appear) instead of leaving a dot. Decided
    // once, here at Pencil-up, from extent + duration; a drag/slow press/snap is ordinary writing. The active
    // tool, colour and width are never touched: this is temporary object manipulation, not a mode switch.
    const tapTarget = penTapShapeTarget(strokesRef.current, {
      points: pts,
      durationMs: Date.now() - penStrokeStartedAtRef.current,
      unitsPerPt: 1 / (canvasScaleRef.current || 1),
      snapped: snappedShape !== null,
    });
    if (tapTarget) {
      dispatchSelection({ type: 'TAP_SHAPE', id: tapTarget.id }, 'pen-tap');
      activeInkRef.current?.clear();
      if (PENCILKIT_TEST_DEV_ENABLED) notebookInkPerf.cancel();
      return;
    }
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
        // Snapped shapes are committed as STRUCTURED shapes; handwriting has no `shape`.
        ...(snappedShape ? { shape: snappedShape } : {}),
        createdAt: new Date().toISOString(),
      };
      recordHistory();
      onStrokesChangeRef.current([...strokesRef.current, stroke]);
      // Writing elsewhere is an explicit "blank" interaction: a shape selected by a tap is released.
      if (selectedIdsRef.current.size > 0) dispatchSelection({ type: 'TAP_BLANK' }, 'ink-committed');
    }
    activeInkRef.current?.clear();
    if (PENCILKIT_TEST_DEV_ENABLED) notebookInkPerf.end(Date.now() - commitStartedAt);
  }, [dispatchSelection, recordHistory]);

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

  // ---- Shape Snap (draw-and-hold) ------------------------------------------
  // Refs only: no React state and no re-render per Pencil sample. A sample is one
  // distance compare; ONE timer is armed per stroke and re-arms itself for the
  // remaining time, so ordinary handwriting never pays for recognition.
  const [shapeHold] = useState(() => new ShapeHoldTracker());
  const shapeHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shapeHoldFireRef = useRef<() => void>(() => {});
  const clearShapeHold = useCallback(() => {
    if (shapeHoldTimerRef.current) {
      clearTimeout(shapeHoldTimerRef.current);
      shapeHoldTimerRef.current = null;
    }
    shapeHold.end();
  }, [shapeHold]);
  const shapeHoldFire = useCallback(() => {
    shapeHoldTimerRef.current = null;
    if (!drawingRef.current || (modeRef.current !== 'write' && modeRef.current !== 'highlight')) return;
    const now = Date.now();
    const remaining = shapeHold.remaining(now);
    if (remaining > 8) {
      shapeHoldTimerRef.current = setTimeout(() => shapeHoldFireRef.current(), remaining);
      return;
    }
    if (!shapeHold.shouldRecognize(now)) return;
    shapeHold.markFired();
    const points = activeInkRef.current?.getPoints() ?? [];
    const scale = canvasScaleRef.current || 1;
    const diagnostics = recognizeShapeDetailed(points, { minSize: 24 / scale });
    if (SHAPE_SNAP_TRACE_ENABLED) {
      recordShapeSnapAttempt({ workspace: 'notebook', points, diagnostics, scale, holdMs: SHAPE_SNAP_HOLD_MS, tolerancePt: SHAPE_SNAP_HOLD_TOLERANCE_PT });
    }
    const shape = diagnostics.result;
    if (!shape) return;
    const structured = shapeFromRecognition(shape, points);
    activeInkRef.current?.freeze(shapeToInkPoints(structured), structured);
    shapeHold.end();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, [shapeHold]);
  shapeHoldFireRef.current = shapeHoldFire;
  const beginShapeHold = useCallback((point: { x: number; y: number }) => {
    if (shapeHoldTimerRef.current) clearTimeout(shapeHoldTimerRef.current);
    shapeHold.begin(point.x, point.y, Date.now());
    shapeHoldTimerRef.current = setTimeout(() => shapeHoldFireRef.current(), SHAPE_SNAP_HOLD_MS);
  }, [shapeHold]);
  const noteShapeHoldSample = useCallback((point: { x: number; y: number }) => {
    const scale = canvasScaleRef.current || 1;
    const unitsPerPt = 1 / scale;
    const moved = shapeHold.sample(point.x, point.y, Date.now(), SHAPE_SNAP_HOLD_TOLERANCE_PT * unitsPerPt, unitsPerPt);
    if (moved && shapeHoldTimerRef.current == null) {
      shapeHoldTimerRef.current = setTimeout(() => shapeHoldFireRef.current(), SHAPE_SNAP_HOLD_MS);
    }
  }, [shapeHold]);

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
    clearShapeHold();
    activeTouchIdRef.current = null;
    // A finger manipulation must release the page immediately (no palm-rest grace for a finger).
    endStylusScrollLock({ grace: !fingerManipulationRef.current });
    fingerManipulationRef.current = false;
    if (modeRef.current === 'select' || selectActionRef.current === 'move' || selectActionRef.current === 'scale' || selectActionRef.current === 'handle') {
      const action = selectActionRef.current;
      if (action === 'lasso') commitLasso();
      else if (action === 'rect') commitRectSelection();
      else if (action === 'move') { commitMove(); dispatchSelection({ type: 'END_MOVE' }, 'move-end'); }
      else if (action === 'scale') { commitScale(); dispatchSelection({ type: 'END_SCALE' }, 'scale-end'); }
      else if (action === 'handle') {
        commitShapeEdit();
        dispatchSelection({ type: 'END_HANDLE' }, 'handle-end');
        activeInkRef.current?.clear();   // Pen/Highlighter froze the live host empty for the edit
      }
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
  }, [clearShapeHold, commitLasso, commitMove, commitRectSelection, commitScale, commitShapeEdit, commitStroke, commitErase, dispatchSelection, restoreTemporaryEraserIfNeeded, endStylusScrollLock]);

  /** Discard the in-progress stroke without committing it (used on tool change). */
  const abortStroke = useCallback(() => {
    if (PENCILKIT_TEST_DEV_ENABLED) notebookInkPerf.cancel();
    drawingRef.current = false;
    clearShapeHold();
    activeTouchIdRef.current = null;
    activeInkRef.current?.clear();
    const abortedEraseIds = new Set(erasedIdsRef.current);
    erasedIdsRef.current.clear();
    for (const id of abortedEraseIds) suppressedEraseIdsRef.current.delete(id);
    lastErasePointRef.current = null;
    if (selectActionRef.current === 'handle') finishShapeEditVisuals();
    if (selectActionRef.current === 'scale') finishScaleVisuals();
    if (selectActionRef.current === 'lasso' || selectActionRef.current === 'rect') dispatchSelection({ type: 'REGION_CANCELLED' }, 'abort');
    else if (selectActionRef.current !== 'idle') dispatchSelection({ type: 'MANIPULATION_CANCELLED' }, 'abort');
    fingerManipulationRef.current = false;
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
  }, [clearShapeHold, dispatchSelection, endStylusScrollLock, finishScaleVisuals, finishShapeEditVisuals, publishEraseCursor, publishEraseSuppression]);

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
   * Natural Pen input foundation (Phase 3B-2): the native sampler
   * (`NotebookPencilSamplerOverlay`) is a pure observer — it never decides
   * whether a touch is drawing. RNGH's `drawGesture` below still owns every
   * activation/mode/lifecycle decision exactly as before; this handler only
   * supplies richer per-sample data (coalesced points + normalized pressure +
   * timestamp, all read from the same native UITouch) for the 'write' (Pen)
   * tool specifically, once RNGH has already confirmed a stroke is active.
   * Highlighter, eraser, select, and scroll are untouched — still driven by
   * RNGH's own onTouchesMove below, exactly as before this module existed.
   * `phase !== 'moved'` samples (began/ended/cancelled) are ignored here:
   * RNGH's onTouchesDown/onTouchesUp remain the sole source of stroke
   * begin/commit, so there is no risk of a double-start or double-end.
   */
  const handleNativePencilSample = useCallback(
    (event: { nativeEvent: NotebookPencilSampleEvent }) => {
      if (modeRef.current !== 'write' || !drawingRef.current) return;
      const { phase, x, y, p, t } = event.nativeEvent;
      if (phase !== 'moved') return;
      const canvasPoint = touchToCanvasPoint(x, y);
      activeInkRef.current?.append({ ...canvasPoint, p, t });
    },
    [touchToCanvasPoint],
  );

  /** Wraps the production Pen sample handler (which a test executes in isolation) with the hold tracker + Dev recorder. */
  const handleNativePencilSampleWrapped = useCallback(
    (event: { nativeEvent: NotebookPencilSampleEvent }) => {
      const { phase, x, y } = event.nativeEvent;
      if (modeRef.current === 'write' && drawingRef.current && phase === 'moved') {
        if (PENCILKIT_TEST_DEV_ENABLED) notebookInkPerf.sample();
        noteShapeHoldSample(touchToCanvasPoint(x, y));
      }
      handleNativePencilSample(event);
    },
    [handleNativePencilSample, noteShapeHoldSample, touchToCanvasPoint],
  );


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
  /**
   * Pencil-down on a HANDLE of the single selected structured shape starts a live reshape. Shared by Select mode
   * and by Pen/Highlighter (a shape selected by a tap stays directly editable without switching tools).
   */
  const beginShapeHandleEdit = useCallback((point: NotePoint): boolean => {
    const ids = selectedIdsRef.current;
    if (ids.size !== 1) return false;
    const selectedShape = strokesRef.current.find((stroke) => ids.has(stroke.id));
    if (!selectedShape || !isStructuredStroke(selectedShape)) return false;
    const unit = 1 / (canvasScaleRef.current || 1);
    const index = nearestShapeHandle(selectedShape.shape.geometry, point, SHAPE_HANDLE_HIT_PT * unit);
    if (index === null) return false;
    const handlePoint = shapeHandles(selectedShape.shape.geometry)[index];
    selectActionRef.current = 'handle';
    shapeEditRef.current = {
      original: selectedShape,
      index,
      grabOffset: { x: handlePoint.x - point.x, y: handlePoint.y - point.y },
      geometry: selectedShape.shape.geometry,
      changed: false,
    };
    dispatchSelection({ type: 'BEGIN_HANDLE' }, 'pencil-handle');
    setEditingShapeId(selectedShape.id);
    shapeHandlesRef.current?.begin(selectedShape.shape.geometry);
    return true;
  }, [dispatchSelection]);

  /** One live handle-drag sample: local preview only (no store write, history or selection state). */
  const updateShapeHandleEdit = useCallback((point: NotePoint) => {
    const edit = shapeEditRef.current;
    if (!edit) return;
    const target = { x: point.x + edit.grabOffset.x, y: point.y + edit.grabOffset.y };
    const geometry = dragShapeHandle(edit.original.shape.geometry, edit.index, target);
    const unit = 1 / (canvasScaleRef.current || 1);
    if (!edit.changed) {
      const original = shapeHandles(edit.original.shape.geometry)[edit.index];
      if (Math.hypot(target.x - original.x, target.y - original.y) < 1.5 * unit) return;
      edit.changed = true;
    }
    edit.geometry = geometry;
    shapeHandlesRef.current?.update(geometry);
  }, []);

  /**
   * Two FINGERS beginning on the selected content start a scale (routeSelectionTouch decides:
   * both must be inside the selected region, otherwise the touches belong to page zoom/pan).
   * A one-finger move already in progress upgrades to the scale when the second finger joins.
   */
  const beginFingerScaleIfEligible = useCallback(
    (
      event: { pointerType: PointerType; allTouches: { id: number; x: number; y: number }[] },
      manager: { activate: () => void },
    ) => {
      if (!isSelectionInteractiveMode(modeRef.current) || event.pointerType === PointerType.STYLUS || !editableRef.current) return;
      if (scaleSessionRef.current || event.allTouches.length !== 2) return;
      const ids = selectedIdsRef.current;
      const selected = strokesRef.current.filter((stroke) => ids.has(stroke.id));
      const region = boundsOfPoints(selected.flatMap((stroke) => stroke.points));
      if (!region) return;
      const first = event.allTouches.find((t) => t.id === activeTouchIdRef.current) ?? event.allTouches[0];
      const second = event.allTouches.find((t) => t !== first)!;
      const p1 = touchToCanvasPoint(first.x, first.y);
      const p2 = touchToCanvasPoint(second.x, second.y);
      const unitsPerPt = 1 / (canvasScaleRef.current || 1);
      const pad = SELECTION_TOUCH_PAD_PT * unitsPerPt;
      const route = routeSelectionTouch({
        pointer: 'touch',
        touchCount: 2,
        hasSelection: true,
        insideSelection: insideSelectionRegion(region, p1, pad),
        secondInsideSelection: insideSelectionRegion(region, p2, pad),
      });
      if (route !== 'selection-scale') return;
      if (drawingRef.current) {
        if (!fingerManipulationRef.current || selectActionRef.current !== 'move') return;
      } else {
        manager.activate();
        drawingRef.current = true;
        activeTouchIdRef.current = first.id;
        fingerManipulationRef.current = true;
        beginStylusScrollLock();
      }
      // Any move preview is discarded: the scale always starts from the ORIGINAL geometry.
      selectionMoveOffsetRef.current = { x: 0, y: 0 };
      setSelectionMoveOffset({ x: 0, y: 0 });
      selectActionRef.current = 'scale';
      const center = boundsCenter(region);
      scaleSessionRef.current = {
        ids: new Set(selected.map((stroke) => stroke.id)),
        originals: selected,
        center,
        startDistance: Math.hypot(p2.x - p1.x, p2.y - p1.y),
        touchIds: [first.id, second.id],
        factor: 1,
        span: boundsSpan(region),
        unitsPerPt,
      };
      dispatchSelection({ type: 'BEGIN_SCALE' }, 'two-finger');
      setScalingActive(true);
      scaleHostRef.current?.begin(selected, center);
    },
    [beginStylusScrollLock, dispatchSelection, touchToCanvasPoint],
  );

  const drawGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .manualActivation(true)
        .onTouchesDown((event, manager) => {
          // An extra touch landing on top of a live stroke (e.g. a resting
          // palm) — keep the current stroke and ignore the extra finger.
          // Scroll is already natively locked for the stylus session.
          if (event.numberOfTouches > 1) {
            beginFingerScaleIfEligible(event, manager);
            return;
          }

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
            const img = selectionActionRect(selectedId, strokesRef.current, imagesRef.current);
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
          // A shape selected by a tap in a DRAWING tool stays while the Pencil is on one of its handles or on its
          // outline (a re-tap); a Pencil-down anywhere else is an explicit "blank" touch. A finger-down never
          // deselects a stroke selection here — a finger TAP is resolved by selectionTapGesture, and dragging
          // must remain page navigation.
          const onSelectedShape = (() => {
            if (!point || selectedIdsRef.current.size !== 1) return false;
            const only = strokesRef.current.find((stroke) => selectedIdsRef.current.has(stroke.id));
            if (!only || !isStructuredStroke(only)) return false;
            const unit = 1 / (canvasScaleRef.current || 1);
            return nearestShapeHandle(only.shape.geometry, point, SHAPE_HANDLE_HIT_PT * unit) !== null ||
              hitTestStructuredStroke([only], point, SHAPE_TAP_SELECT_PT * unit) !== null;
          })();
          const selectionHasImage = imagesRef.current.some((image) => selectedIdsRef.current.has(image.id));
          if (activeMode !== 'select' && point && selectedIdsRef.current.size > 0 && !findImageAtPoint(point) && !barHit &&
              !onSelectedShape && (event.pointerType === PointerType.STYLUS || selectionHasImage)) {
            dispatchSelection({ type: 'TAP_BLANK' }, 'blank-tap-outside-select');
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

          // PK3-A DEV Native Ink Layer: when enabled, Pen ('write') + stylus
          // touches are handed entirely to the embedded PKCanvasView instead
          // — failing here means drawingRef.current never becomes true for
          // this touch, so handleNativePencilSample's existing `!drawingRef.
          // current` guard already prevents any double-ink into the legacy
          // SVG layer. Highlighter/erase/select are untouched — only Pen
          // drawing moves to PencilKit while this Dev toggle is on.
          if (
            devNativeInkLayerEnabledRef.current &&
            activeMode === 'write' &&
            event.pointerType === PointerType.STYLUS
          ) {
            manager.fail();
            return;
          }

          // Drawing and selection regions require Apple Pencil; a finger
          // fails before activation so the ScrollView retains navigation.
          // While a stylus session / palm grace is active, non-stylus touches
          // still fail the draw gesture but ScrollView stays locked.
          // Routing (lib/selectionTransform.routeSelectionTouch): the Pencil creates/moves selections;
          // ONE FINGER that begins inside the selected region moves it; a finger anywhere else
          // fails here so the ScrollView keeps navigating (the page is never locked by a selection).
          const isStylusTouch = event.pointerType === PointerType.STYLUS;
          let fingerSelectionMove = false;
          if (!isStylusTouch && isSelectionInteractiveMode(activeMode) && (activeMode === 'select' || selectedIdsRef.current.size > 0)) {
            const selectedNow = strokesRef.current.filter((stroke) => selectedIdsRef.current.has(stroke.id));
            const region = boundsOfPoints(selectedNow.flatMap((stroke) => stroke.points));
            const route = routeSelectionTouch({
              pointer: 'touch',
              touchCount: 1,
              hasSelection: selectedNow.length > 0,
              insideSelection: point !== null && insideSelectionRegion(region, point, SELECTION_TOUCH_PAD_PT / (canvasScaleRef.current || 1)),
              onHandle: point !== null && selectedNow.length === 1 && isStructuredStroke(selectedNow[0]) &&
                nearestShapeHandle(selectedNow[0].shape.geometry, point, SHAPE_HANDLE_HIT_PT / (canvasScaleRef.current || 1)) !== null,
            });
            if (route !== 'selection-move' && route !== 'shape-handle-edit') {
              manager.fail();
              return;
            }
            fingerSelectionMove = true;
          } else if (!selectionAcceptsPointer(isStylusTouch ? 'stylus' : 'touch')) {
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
          const stylusDrawingOverImage = (activeMode !== 'select' && event.pointerType === PointerType.STYLUS) || fingerSelectionMove;
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
          fingerManipulationRef.current = fingerSelectionMove;
          beginStylusScrollLock();

          // Pen/Highlighter: the Pencil on a HANDLE of the selected shape reshapes it (no tool switch). The live ink
          // host is frozen empty so neither the native sampler nor a hold can draw during the edit.
          if ((activeMode === 'write' || activeMode === 'highlight') && isStylusTouch && beginShapeHandleEdit(point)) {
            activeInkRef.current?.freeze([]);
            return;
          }

          if (activeMode === 'select' || fingerSelectionMove) {
            const ids = selectedIdsRef.current;
            // A handle of the single selected structured shape starts a live reshape (same helper as Pen mode).
            if (beginShapeHandleEdit(point)) return;
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
              // Touch tolerance is defined in SCREEN points (finger is looser than the Pencil).
              const pad = (fingerSelectionMove ? SELECTION_TOUCH_PAD_PT : SELECTION_PENCIL_PAD_PT) / (canvasScaleRef.current || 1);
              inBounds = Number.isFinite(minX) &&
                point.x >= minX - pad && point.x <= maxX + pad &&
                point.y >= minY - pad && point.y <= maxY + pad;
              // Pencil touching ANOTHER structured shape's outline is a (tap-)select of that shape, not a move.
              if (inBounds && !fingerSelectionMove) {
                const otherShape = hitTestStructuredStroke(strokesRef.current, point, SHAPE_TAP_SELECT_PT / (canvasScaleRef.current || 1));
                if (otherShape && !ids.has(otherShape.id)) inBounds = false;
              }
            }
            if (inBounds) {
              selectActionRef.current = 'move';
              selectionMoveStartRef.current = point;
              selectionMoveOffsetRef.current = { x: 0, y: 0 };
              dispatchSelection({ type: 'BEGIN_MOVE' }, fingerSelectionMove ? 'finger' : 'pencil');
            } else {
              // A new region begins. The previous selection is NOT cleared here: it stays until the
              // drag proves this is a region (REGION_DRAGGED) or the tap ends on blank paper (TAP_BLANK).
              regionDraggedRef.current = false;
              if (selectionShapeRef.current === 'rect') {
                selectActionRef.current = 'rect';
                selectionRectStartRef.current = point;
                selectionRectEndRef.current = point;
                setSelectionRect(boxFromCorners(point, point));
              } else {
                selectActionRef.current = 'lasso';
                lassoPointsRef.current = startFreeform(point);
                setLassoPoints(startFreeform(point));
              }
              dispatchSelection({ type: 'BEGIN_REGION', shape: selectionShapeRef.current }, 'touch-down');
            }
            return;
          }

          if (activeMode === 'write' || activeMode === 'highlight') {
            strokeMoveSampleCountRef.current = 0;
            strokeStartedOverImageRef.current = hitImageForInkRouting?.id ?? null;
            if (PENCILKIT_TEST_DEV_ENABLED) notebookInkPerf.begin(activeMode === 'highlight' ? 'highlighter' : 'pen');
            penStrokeStartedAtRef.current = Date.now();
            activeInkRef.current?.begin(point);
            beginShapeHold(point);
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

          if (modeRef.current === 'select' || selectActionRef.current === 'move' || selectActionRef.current === 'scale' || selectActionRef.current === 'handle') {
            if (selectActionRef.current === 'lasso') {
              const pts = lassoPointsRef.current;
              const last = pts[pts.length - 1];
              if (last && Math.hypot(point.x - last.x, point.y - last.y) < MIN_POINT_DISTANCE) return;
              const next = appendFreeform(pts, point);
              lassoPointsRef.current = next;
              setLassoPoints(next);
              if (!regionDraggedRef.current) {
                const box = boundsOfPoints(next);
                if (box && boundsSpan(box) >= SHAPE_TAP_MAX_EXTENT_PT / (canvasScaleRef.current || 1)) {
                  regionDraggedRef.current = true;
                  dispatchSelection({ type: 'REGION_DRAGGED' }, 'lasso-move');
                }
              }
            } else if (selectActionRef.current === 'rect') {
              const start = selectionRectStartRef.current;
              if (!start) return;
              selectionRectEndRef.current = point;
              setSelectionRect(boxFromCorners(start, point));
              if (!regionDraggedRef.current) {
                const dragged = boxFromCorners(start, point);
                if (Math.max(dragged.width, dragged.height) >= SHAPE_TAP_MAX_EXTENT_PT / (canvasScaleRef.current || 1)) {
                  regionDraggedRef.current = true;
                  dispatchSelection({ type: 'REGION_DRAGGED' }, 'rect-move');
                }
              }
            } else if (selectActionRef.current === 'scale') {
              const session = scaleSessionRef.current;
              if (!session) return;
              const a = event.allTouches.find((t) => t.id === session.touchIds[0]);
              const b = event.allTouches.find((t) => t.id === session.touchIds[1]);
              if (!a || !b) return;
              const pa = touchToCanvasPoint(a.x, a.y);
              const pb = touchToCanvasPoint(b.x, b.y);
              const factor = clampSelectionScale(pinchFactor(session.startDistance, Math.hypot(pb.x - pa.x, pb.y - pa.y)), session.span, session.unitsPerPt);
              session.factor = factor;
              scaleHostRef.current?.update(factor);
            } else if (selectActionRef.current === 'handle') {
              updateShapeHandleEdit(point);
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
            // Pen ('write') points now come from the native pencil sampler
            // (handleNativePencilSample) instead — one authoritative sample
            // source per tool. Highlighter is untouched: still appended here.
            if (modeRef.current === 'highlight') {
              if (PENCILKIT_TEST_DEV_ENABLED) notebookInkPerf.sample();
              noteShapeHoldSample(point);
            }
            if (modeRef.current === 'highlight') {
              activeInkRef.current?.append(point);
            }
          } else if (modeRef.current === 'erase') {
            const previous = lastErasePointRef.current ?? point;
            lastErasePointRef.current = point;
            publishEraseCursor(point);
            eraseAt(previous, point);
          }
        })
        .onTouchesUp((event) => {
          if (!drawingRef.current) return;
          const tracked: number[] = scaleSessionRef.current?.touchIds ?? [];
          if (event.changedTouches.some((t) => t.id === activeTouchIdRef.current || tracked.includes(t.id))) {
            endStroke();
          }
        })
        .onTouchesCancelled((event) => {
          if (!drawingRef.current) return;
          const tracked: number[] = scaleSessionRef.current?.touchIds ?? [];
          if (event.changedTouches.some((t) => t.id === activeTouchIdRef.current || tracked.includes(t.id))) {
            endStroke();
          }
        })
        .onFinalize(() => {
          endStroke();
        }),
    [beginFingerScaleIfEligible, beginShapeHandleEdit, beginShapeHold, beginStylusScrollLock, dispatchSelection, endStroke, updateShapeHandleEdit, eraseAt, findImageAtPoint, noteShapeHoldSample, publishEraseCursor, touchToCanvasPoint],
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

  /**
   * Finger TAP in Select: on a structured shape's outline it selects that shape, on blank paper it is the
   * explicit deselect. It never fires for the Pencil (the draw gesture owns Pencil taps), on an image, on the
   * floating Duplicate/Delete bar, or inside the selected region (that belongs to the selection).
   */
  const selectionTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .maxDuration(450)
        .maxDistance(12)
        .onEnd((event, success) => {
          if (!success || !isSelectionInteractiveMode(modeRef.current) || !editableRef.current) return;
          if (event.pointerType === PointerType.STYLUS) return;
          const point = touchToCanvasPoint(event.x, event.y);
          if (findImageAtPoint(point)) return;
          const unit = 1 / (canvasScaleRef.current || 1);
          const ids = selectedIdsRef.current;
          if (ids.size === 1) {
            const only = Array.from(ids)[0];
            const rect = selectionActionRect(only, strokesRef.current, imagesRef.current);
            const cw = containerSizeRef.current.width;
            const ch = pageGeomRef.current.canvasHeight;
            if (rect && cw > 0 && ch > 0) {
              const offset = selectionMoveOffsetRef.current;
              const centerX = rect.x + offset.x + rect.width / 2;
              const maxLeft = Math.max(IMAGE_ACTION_BAR_EDGE, cw - IMAGE_ACTION_BAR_WIDTH - IMAGE_ACTION_BAR_EDGE);
              const left = clamp(centerX - IMAGE_ACTION_BAR_WIDTH / 2, IMAGE_ACTION_BAR_EDGE, maxLeft);
              const above = rect.y + offset.y - IMAGE_ACTION_BAR_HEIGHT - IMAGE_ACTION_BAR_GAP;
              const below = rect.y + offset.y + rect.height + IMAGE_ACTION_BAR_GAP;
              const maxTop = Math.max(IMAGE_ACTION_BAR_EDGE, ch - IMAGE_ACTION_BAR_HEIGHT - IMAGE_ACTION_BAR_EDGE);
              const top = clamp(above < IMAGE_ACTION_BAR_EDGE ? below : above, IMAGE_ACTION_BAR_EDGE, maxTop);
              if (point.x >= left && point.x <= left + IMAGE_ACTION_BAR_WIDTH && point.y >= top && point.y <= top + IMAGE_ACTION_BAR_HEIGHT) return;
            }
          }
          const selected = strokesRef.current.filter((stroke) => ids.has(stroke.id));
          const region = boundsOfPoints(selected.flatMap((stroke) => stroke.points));
          if (insideSelectionRegion(region, point, SELECTION_TOUCH_PAD_PT * unit)) return;
          if (trySelectShapeAt(point)) return;
          if (ids.size > 0) dispatchSelection({ type: 'TAP_BLANK' }, 'finger-blank-tap');
        }),
    [dispatchSelection, findImageAtPoint, touchToCanvasPoint, trySelectShapeAt],
  );

  const notebookGestures = useMemo(
    () => Gesture.Simultaneous(pinchGesture, drawGesture, selectionTapGesture),
    [pinchGesture, drawGesture, selectionTapGesture],
  );

  // A tool change must never leave a half-finished stroke behind for the next
  // gesture to extend — drop any in-progress stroke whenever the mode changes.
  useEffect(() => {
    abortStroke();
  }, [mode, abortStroke]);

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
            dispatchSelection({ type: 'DELETE' }, 'clearPage');
          },
        },
      ],
    );
  }, [strokes, text, images, onStrokesChange, onTextChange, onImagesChange, recordHistory, pageForScroll, t, dispatchSelection]);

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
    dispatchSelection({ type: 'DELETE' }, 'deleteSelectedObjects');
    selectionMoveOffsetRef.current = { x: 0, y: 0 };
    setSelectionMoveOffset({ x: 0, y: 0 });
    if (__DEV__) console.info('[NotebookImageAction] delete callback-completed', { result: 'removed', removedIds: Array.from(ids) });
    return true;
  }, [dispatchSelection, recordHistory]);

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
        ...translateInkStroke(s, OFFSET, OFFSET),
        id: newId,
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
    selectIds([...newIds], 'duplicate');
    if (__DEV__) {
      console.info('[NotebookImageAction] copy callback-completed', {
        result: 'duplicated',
        newIds: Array.from(newIds),
        duplicatedImageUris: extraImages.map((img) => img.uri),
      });
    }
  }, [recordHistory, selectIds]);

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
    dispatchSelection({ type: 'SELECT_INK', ids: [img.id] }, 'insert-image');
  }, [dispatchSelection, recordHistory]);

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

  // The one selected structured shape (handles + edit); null for any other selection.
  const singleSelectedShape = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const id = Array.from(selectedIds)[0];
    const stroke = strokes.find((candidate) => candidate.id === id);
    return stroke && isStructuredStroke(stroke) ? stroke : null;
  }, [selectedIds, strokes]);

  const selectedImageForActions = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const selectedId = Array.from(selectedIds)[0];
    return selectionActionRect(selectedId, strokes, images);
  }, [images, strokes, selectedIds]);

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
      const visible = strokes.filter((s) => !erasedIds.has(s.id) && s.id !== editingShapeId && !(scalingActive && selectedIds.has(s.id)));
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
    [strokes, erasedIds, selectedIds, editingShapeId, scalingActive],
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
  };

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
          from the beginning; only confirmed stylus input activates drawing.
          NotebookPencilSamplerOverlay WRAPS (does not sit atop as a sibling)
          the ScrollView specifically so it never wins hit-testing over it: it
          is an ANCESTOR of whatever view UIKit hit-tests, which is how it
          receives every touch via the standard gesture-recognizer ancestor
          chain without blocking or delaying the ScrollView/RNGH beneath it
          (see NotebookPencilSamplerGestureRecognizer's doc comment). Same
          frame as the ScrollView (StyleSheet.absoluteFill, zero inset), so its
          native x/y match RNGH's own touch.x/y — touchToCanvasPoint is reused
          unchanged in handleNativePencilSample. */}
      <NotebookPencilSamplerOverlay style={StyleSheet.absoluteFill} onPencilSample={handleNativePencilSampleWrapped}>
      <GestureDetector gesture={notebookGestures}>
        <AnimatedNotebookScrollView
          ref={scrollViewRef}
          style={styles.scroll}
          keyboardShouldPersistTaps="handled"
          // PK3-A: when the native ink layer owns Pen+stylus touches
          // (onTouchesDown calls manager.fail() before drawingRef.current/
          // beginStylusScrollLock() ever run — see the guard above), the
          // legacy stylusStrokeActive lock never engages for a PencilKit
          // stroke. Lock scroll only while a REAL PencilKit stroke is
          // active (devNativeInkStrokeActive, driven by PKCanvasViewDelegate's
          // begin/end lifecycle — see handleDevNativeInkStrokeActiveChange),
          // not for the whole time the layer is merely enabled: with the
          // Pencil up, finger scroll/pinch must work exactly as normal.
          scrollEnabled={
            !stylusStrokeActive &&
            !imageManipulationActive &&
            !(devNativeInkLayerEnabled && devNativeInkStrokeActive)
          }
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
            showSelectionBounds={mode === 'select' && !singleSelectedShape && !scalingActive}
          />
          {isSelectionInteractiveMode(mode) ? (
            <ShapeHandlesHost
              ref={shapeHandlesRef}
              canvasHeight={canvasHeight}
              stroke={scalingActive ? null : singleSelectedShape}
              scale={canvasScale}
              moveOffset={selectionMoveOffset}
            />
          ) : null}
          {isSelectionInteractiveMode(mode) ? <SelectionScaleHost ref={scaleHostRef} canvasHeight={canvasHeight} scale={canvasScale} /> : null}
          <ActiveInkHost
            ref={activeInkRef}
            canvasHeight={canvasHeight}
            tool={mode === 'highlight' ? 'highlighter' : 'pen'}
            color={mode === 'highlight' ? highlighterColor : penColor}
            width={mode === 'highlight' ? highlighterWidth : penWidth}
            opacity={mode === 'highlight' ? 0.34 : 1}
          />

          {/* PK3-A — session-only native PencilKit ink layer proof, embedded
              as a plain child of THIS SAME Reanimated.View (the exact same
              parent + [scale,translateX] transform as the SVG ink layers
              above). This is the whole point: no per-frame JS/native sync
              exists or is needed — the native view is carried by the same
              native-thread transform as everything else in this canvas, the
              same way the SVG layers already are. Sized to the full logical
              canvas (canvasHeight), not just the viewport, so it scrolls
              along with the ScrollView's own native content exactly like the
              SVG layers do. Dev-only, gated twice (production safety +
              explicit opt-in), never persisted, never converted to
              NoteStroke — see PencilKitTestModule.swift. */}
          {PENCILKIT_TEST_DEV_ENABLED && devNativeInkLayerEnabled ? (
            <>
              <PencilKitTestSurface
                ref={devNativeInkSurfaceRef}
                transparent
                onPencilStrokeActiveChange={handleDevNativeInkStrokeActiveChange}
                style={[styles.pk3aInkLayer, { height: canvasHeight }]}
              />
              {/* Registration targets (Step 5) — pure visual markers, never
                  persisted, never part of NoteStroke/PKDrawing. Spread out
                  vertically so scrolling is required to move between them,
                  proving spatial lock across a real scroll distance. */}
              {PK3A_REGISTRATION_TARGETS.map((target) => (
                <View
                  key={target.id}
                  pointerEvents="none"
                  style={[styles.pk3aTarget, { left: target.x - 20, top: target.y - 20 }]}
                >
                  <View style={styles.pk3aTargetHLine} />
                  <View style={styles.pk3aTargetVLine} />
                  <Text style={styles.pk3aTargetLabel}>{target.id}</Text>
                </View>
              ))}
            </>
          ) : null}

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
      </NotebookPencilSamplerOverlay>

      {/* Scroll-time page indicator — bottom-right, compact, auto-hides. */}
      {pageBadge.visible ? (
        <Animated.View style={[styles.pageBadge, { opacity: pageBadgeOpacity }]} pointerEvents="none">
          <Text style={styles.pageBadgeText}>
            {pageBadge.page} / {totalPages}
          </Text>
        </Animated.View>
      ) : null}

      <SharedAnnotationToolbar
          editable={editable}
          storageKey="youmi.notebookToolbar.v1"
          avoidRects={avoidRects}
          tools={notebookSharedTools()}
          activeTool={notebookModeToSharedTool(mode) ?? 'pen'}
          onSelectTool={(tool) => changeMode(sharedToolToNotebookMode(tool))}
          renderToolIcon={(tool, active, color, size) => (
            <ModeIcon mode={sharedToolToNotebookMode(tool)} active={active} color={color} size={size} />
          )}
          penColors={PEN_COLORS}
          penColor={penColor}
          onSelectPenColor={setPenColor}
          penWidths={PEN_WIDTHS}
          penWidth={penWidth}
          onSelectPenWidth={setPenWidth}
          highlighterColors={HIGHLIGHTER_COLORS}
          highlighterColor={highlighterColor}
          onSelectHighlighterColor={setHighlighterColor}
          highlighterWidths={HIGHLIGHTER_WIDTHS}
          highlighterWidth={highlighterWidth}
          onSelectHighlighterWidth={setHighlighterWidth}
          eraserSizes={sharedEraserSizeOptions}
          eraserSize={eraserRadius}
          onSelectEraserSize={handleSelectEraserRadius}
          onUndo={undo}
          canUndo={canUndo}
          onRedo={redo}
          canRedo={canRedo}
          showFixedHistory={showFixedHistory}
          extraAction={{
            onPress: handleTrashPress,
            disabled: !canClear,
            accessibilityLabel: hasSelection ? t('tools.deleteSelected') : t('tools.clearPage'),
            icon: <ToolbarGlyph name="more" color={canClear ? TOOLBAR_ICON_IDLE : TOOLBAR_ICON_DISABLED} />,
          }}
          renderExtraContext={(tool, orientation, helpers) => {
            if (tool === 'select') {
              return (
                <SharedSelectionShapeContext
                  shape={selectionShape}
                  onChange={setSelectionShape}
                  orientation={orientation}
                  runPress={helpers.runPress}
                  dragHandlerProps={helpers.dragHandlerProps}
                  renderIcon={(shape, color) => <SelectionShapeIcon shape={shape} color={color} />}
                />
              );
            }
            if (tool === 'insert') {
              if (orientation === 'horizontal') {
                return (
                  <View style={styles.insertRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('tools.insertPhotos')}
                      onPress={() => helpers.runPress(pickImage)}
                      {...helpers.dragHandlerProps}
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
                );
              }
              return (
                <View style={styles.vCtxPanel}>
                  <Text style={styles.vCtxLabel}>{t('tools.insert')}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('tools.insertPhotos')}
                    onPress={() => helpers.runPress(pickImage)}
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
              );
            }
            return null;
          }}
          moveAccessibilityLabel={t('tools.moveNotebook')}
          expandAccessibilityLabel={t('tools.expandNotebook')}
          minimizeAccessibilityLabel={t('tools.minimizeNotebook')}
          handAccessibilityLabel={t('tools.hand')}
        />

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

      {/* PK1 — isolated Apple PencilKit physical spike. Dev-only entry point;
          opening/writing/clearing here never reads or writes real Notebook
          data (NoteStroke, history, persistence) — see lib/pencilKitTest.tsx. */}
      {editable && PENCILKIT_TEST_DEV_ENABLED && isPencilKitTestAvailable() ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="DEV Apple Pen Test"
          onPress={() => setPencilKitTestOpen(true)}
          style={styles.pencilKitTestButton}
        >
          <Text style={styles.pencilKitTestButtonText}>DEV · Apple Pen Test</Text>
        </Pressable>
      ) : null}

      {/* PK3-A — session-only native ink layer proof, embedded directly in the
          real Notebook viewport (see the <PencilKitTestSurface> block inside
          the transformed Reanimated.View above). Toggling this never touches
          NoteStroke/PKDrawing persistence — see PencilKitTestModule.swift and
          the PK3-A report for the full architecture. */}
      {editable && PENCILKIT_TEST_DEV_ENABLED && isPencilKitTestAvailable() ? (
        <View style={styles.pk3aToggleRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Toggle DEV Native Ink Layer"
            onPress={() => setDevNativeInkLayerEnabled((value) => !value)}
          >
            <Text style={styles.pk3aToggleButtonText}>
              {devNativeInkLayerEnabled ? 'DEV · Native Ink Layer ON' : 'DEV · Native Ink Layer'}
            </Text>
          </Pressable>
          {devNativeInkLayerEnabled ? (
            <>
              {/* PK3-B durable-save status (Step 6) — visible so the owner's
                  physical test can confirm "durable-save boundary reached"
                  before force-killing (TEST B/C), rather than guessing from
                  a fixed wait. */}
              <Text style={styles.pk3aSaveStateText}>{devNativeInkSaveState.toUpperCase()}</Text>
              {(['thin', 'medium', 'thick'] as const).map((preset) => (
                <Pressable
                  key={preset}
                  accessibilityRole="button"
                  accessibilityLabel={`Native ink width ${preset}`}
                  onPress={() => devNativeInkSurfaceRef.current?.setWidthPreset(preset)}
                  style={styles.pk3aWidthButton}
                >
                  <Text style={styles.pk3aWidthButtonText}>{preset.toUpperCase()}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear native ink layer"
                onPress={() => devNativeInkSurfaceRef.current?.clear()}
                style={styles.pk3aWidthButton}
              >
                <Text style={styles.pk3aWidthButtonText}>CLEAR</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}

      {PENCILKIT_TEST_DEV_ENABLED ? (
        <Modal
          visible={pencilKitTestOpen}
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setPencilKitTestOpen(false)}
        >
          <View style={styles.pencilKitTestScreen}>
            <View style={styles.pencilKitTestHeader}>
              <Text style={styles.pencilKitTestTitle}>APPLE PENCILKIT TEST</Text>
              <Text style={styles.pencilKitTestSubtitle}>NOT SAVED — closes without saving anything</Text>
              {/* PK2 §19 width verification only — changes the NEXT stroke's
                  base width via the same .pen ink; does not affect ink
                  already drawn. Real device-queried .pen.validWidthRange is
                  0.878...25.66 (default 2.68) — see the PK2 report. */}
              <View style={styles.pencilKitWidthRow}>
                {(['thin', 'medium', 'thick'] as const).map((preset) => (
                  <Pressable
                    key={preset}
                    accessibilityRole="button"
                    accessibilityLabel={`Width ${preset}`}
                    onPress={() => pencilKitTestSurfaceRef.current?.setWidthPreset(preset)}
                    style={styles.pencilKitWidthButton}
                  >
                    <Text style={styles.pencilKitWidthButtonText}>{preset.toUpperCase()}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <PencilKitTestSurface ref={pencilKitTestSurfaceRef} style={styles.pencilKitTestSurface} />
            <View style={styles.pencilKitTestFooter}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear"
                onPress={() => pencilKitTestSurfaceRef.current?.clear()}
                style={styles.pencilKitTestFooterButton}
              >
                <Text style={styles.pencilKitTestFooterButtonText}>Clear</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={() => setPencilKitTestOpen(false)}
                style={[styles.pencilKitTestFooterButton, styles.pencilKitTestCloseButton]}
              >
                <Text style={[styles.pencilKitTestFooterButtonText, styles.pencilKitTestCloseButtonText]}>Close</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
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

  // ---- PK3-A session-only native ink layer proof (Dev-only, disposable) ----
  pk3aToggleRow: {
    position: 'absolute', top: 52, right: 12, zIndex: 60,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12,
    backgroundColor: '#1E7A4C',
  },
  pk3aToggleButtonText: {
    color: '#FFFFFF', fontSize: 11, fontWeight: '700',
  },
  pk3aWidthButton: {
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  pk3aWidthButtonText: {
    color: '#FFFFFF', fontSize: 10, fontWeight: '700',
  },
  pk3aSaveStateText: {
    color: 'rgba(255,255,255,0.85)', fontSize: 9, fontWeight: '700',
    paddingHorizontal: 4,
  },
  pk3aInkLayer: {
    position: 'absolute', top: 0, left: 0, right: 0,
    // height is set inline to canvasHeight — see the JSX call site.
    zIndex: 40,
  },
  pk3aTarget: {
    position: 'absolute', width: 40, height: 40, zIndex: 45,
    alignItems: 'center', justifyContent: 'center',
  },
  pk3aTargetHLine: {
    position: 'absolute', width: 40, height: 1.5, backgroundColor: 'rgba(255,59,72,0.8)',
  },
  pk3aTargetVLine: {
    position: 'absolute', width: 1.5, height: 40, backgroundColor: 'rgba(255,59,72,0.8)',
  },
  pk3aTargetLabel: {
    position: 'absolute', top: -16, color: 'rgba(255,59,72,0.9)', fontSize: 11, fontWeight: '800',
  },

  // ---- PK1 isolated Apple PencilKit physical spike (Dev-only, disposable) ----
  pencilKitTestButton: {
    position: 'absolute', top: 12, right: 12, zIndex: 60,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12,
    backgroundColor: '#7A3CC4',
  },
  pencilKitTestButtonText: {
    color: '#FFFFFF', fontSize: 11, fontWeight: '700',
  },
  pencilKitTestScreen: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  pencilKitTestHeader: {
    paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12,
    backgroundColor: '#7A3CC4',
  },
  pencilKitTestTitle: {
    color: '#FFFFFF', fontSize: 16, fontWeight: '800', letterSpacing: 0.5,
  },
  pencilKitTestSubtitle: {
    color: '#FFFFFF', fontSize: 12, fontWeight: '500', marginTop: 2, opacity: 0.85,
  },
  pencilKitWidthRow: {
    flexDirection: 'row', gap: 8, marginTop: 10,
  },
  pencilKitWidthButton: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  pencilKitWidthButtonText: {
    color: '#FFFFFF', fontSize: 11, fontWeight: '700',
  },
  pencilKitTestSurface: {
    flex: 1,
  },
  pencilKitTestFooter: {
    flexDirection: 'row', justifyContent: 'flex-end', gap: 12,
    paddingHorizontal: 20, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: '#E5E5E5',
  },
  pencilKitTestFooterButton: {
    paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10,
    backgroundColor: '#EFEFEF',
  },
  pencilKitTestCloseButton: {
    backgroundColor: '#7A3CC4',
  },
  pencilKitTestFooterButtonText: {
    color: '#222630', fontSize: 14, fontWeight: '700',
  },
  pencilKitTestCloseButtonText: {
    color: '#FFFFFF',
  },

  // ---- Independent floating toolbar overlay (unified navy, matches Live Caption) ----
  // Vertical dock: rail edge-column and inward card-column sit side by side, centred on the
  // cross (vertical) axis so the context card aligns with the rail's middle.
  // Right dock mirrors the layout so the rail still hugs the screen edge.
  // Current-tool tag — design `.tbmin .cur` (46, tinted blue, radius 11).
  /** Primary tool button — design `.tool` (48 × 46, radius 11). */
  /** Icon button — design `.icbtn` (44 × 44, radius 11). Hand · Minimize · right pill. */
  /** Ink swatch row — design `.swatches` gap 11. */
  /** Width / size nib row — design `.nibs` gap 9. */
  /** Ink swatch — design `.sw` (28 circle; selected ring sits 4pt outside). */
  /** Width / eraser-size nib — design `.nib` (38 circle, 2pt selected ring). */
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

  // ==== Side-docked vertical toolbar — compact two-column capsule (reference layout) ====
  // Edge column stacks the main capsule above the separate history / selection capsules,
  // flush to the screen edge.
  // Unified capsule = [tool column | divider | context column] in one navy shell.
  /** Primary tool button — 48 × 44, radius 11. */
  /** Soft selected chip behind the active tool icon. */
  /** Inward-edge active indicator (no underline). */
  /** Icon button (Hand · Minimize · history · selection) — 44 × 44, radius 11. */
  /** Full-height hairline between the two columns. */
  /** Inward context column — width set inline per active tool. */
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
  // Still used by the select-shape / insert-photo context bodies rendered
  // via SharedAnnotationToolbar's renderExtraContext slot.
  toolbarPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.92 }],
  },
  vCtxLabel: {
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '700',
    letterSpacing: 1.05,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.36)',
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
  // Minimized capsule — two states of the same component, built for the column.
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
