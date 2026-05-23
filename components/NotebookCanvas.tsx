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
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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
import Svg, { Circle, Path } from 'react-native-svg';

import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import type { NotePoint, NoteStroke } from '@/lib/models';
import {
  addPencilDoubleTapListener,
  isPencilDoubleTapAvailable,
} from '@/lib/pencilInteraction';

const PEN_COLORS: { key: string; value: string }[] = [
  { key: 'Navy', value: '#061B34' },
  { key: 'Blue', value: '#2D6CDF' },
  { key: 'Red', value: '#D7263D' },
  { key: 'Purple', value: '#6C4FB3' },
  { key: 'Black', value: '#1A1A1A' },
];

const PEN_WIDTHS: { key: string; value: number; dot: number }[] = [
  { key: 'Thin', value: 2, dot: 7 },
  { key: 'Medium', value: 3.5, dot: 11 },
  { key: 'Thick', value: 6, dot: 16 },
];

const HIGHLIGHTER_COLORS: { key: string; value: string }[] = [
  { key: 'Yellow', value: '#FFE066' },
  { key: 'Blue', value: '#78D6FF' },
  { key: 'Pink', value: '#FF9CCB' },
  { key: 'Green', value: '#9BE7A6' },
];

const HIGHLIGHTER_WIDTHS: { key: string; value: number; dot: number }[] = [
  { key: 'Narrow', value: 12, dot: 8 },
  { key: 'Medium', value: 18, dot: 12 },
  { key: 'Wide', value: 26, dot: 17 },
];

type EraserSizeKey = 'small' | 'medium' | 'large';

const ERASER_SIZES: { key: EraserSizeKey; label: string; radius: number }[] = [
  { key: 'small', label: 'Small', radius: 12 },
  { key: 'medium', label: 'Medium', radius: 26 },
  { key: 'large', label: 'Large', radius: 44 },
];

const LINE_GAP = 34;
const MARGIN_X = 56;
const MIN_POINT_DISTANCE = 1.8;
/** The notebook is one long ruled page — roughly three iPad screens tall. */
const PAGE_HEIGHT = 3200;
/** How long the Pen / Eraser badge stays on screen after a double-tap. */
const TOOL_TOAST_MS = 1100;

export type CanvasMode = 'write' | 'highlight' | 'type' | 'erase' | 'scroll';
type DrawingMode = 'write' | 'highlight';

/** Primary tools shown in the toolbar segment. Scroll is a fallback action. */
const DRAW_MODES: { key: CanvasMode; label: string }[] = [
  { key: 'write', label: 'Write' },
  { key: 'highlight', label: 'Highlight' },
  { key: 'type', label: 'Type' },
  { key: 'erase', label: 'Erase' },
];

type PointerLabel = 'STYLUS' | 'TOUCH' | 'MOUSE' | 'KEY' | 'OTHER';

function pointerLabel(pointerType: PointerType): PointerLabel {
  switch (pointerType) {
    case PointerType.STYLUS:
      return 'STYLUS';
    case PointerType.TOUCH:
      return 'TOUCH';
    case PointerType.MOUSE:
      return 'MOUSE';
    case PointerType.KEY:
      return 'KEY';
    default:
      return 'OTHER';
  }
}

function makeStrokeId(): string {
  return `stroke_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function distancePointToSegment(point: NotePoint, a: NotePoint, b: NotePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.0001) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  const projection = { x: a.x + t * dx, y: a.y + t * dy };
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

function strokeNearPoint(stroke: NoteStroke, x: number, y: number, eraserRadius: number): boolean {
  const points = stroke.points;
  if (points.length === 0) return false;
  const threshold = eraserRadius + Math.max(1, stroke.width / 2);
  const eraserPoint = { x, y };
  if (points.length === 1) {
    return Math.hypot(points[0].x - x, points[0].y - y) <= threshold;
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    if (distancePointToSegment(eraserPoint, points[i], points[i + 1]) <= threshold) {
      return true;
    }
  }
  return false;
}

/** Build a smooth SVG path (quadratic midpoints) from freehand points. */
export function strokeToPath(points: NotePoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${p.y} L ${p.x + 0.1} ${p.y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/**
 * One rendered stroke. A single-point stroke (a tap) is drawn as a small dot,
 * a multi-point stroke as a smooth path. Each stroke is its own SVG node with
 * its own points, so distinct strokes can never visually connect.
 */
function StrokeShape({
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
}

function ModeIcon({ mode, active }: { mode: CanvasMode; active: boolean }) {
  const color = active ? colors.pearlWhite : colors.deepNavy;
  if (mode === 'write') return <Ionicons name="pencil" size={15} color={color} />;
  if (mode === 'highlight') return <Ionicons name="color-wand-outline" size={15} color={color} />;
  if (mode === 'type') return <Ionicons name="text" size={15} color={color} />;
  if (mode === 'erase') return <MaterialCommunityIcons name="eraser" size={16} color={color} />;
  return <Ionicons name="hand-left-outline" size={15} color={color} />;
}

type NotebookCanvasProps = {
  strokes: NoteStroke[];
  text: string;
  onStrokesChange: (strokes: NoteStroke[]) => void;
  onTextChange: (text: string) => void;
  /** When false: read-only — no toolbar, no input. Defaults to true. */
  editable?: boolean;
  style?: ViewStyle;
};

/**
 * The editable notebook page. Handwriting strokes flow through
 * `onStrokesChange` on stroke end; typed text flows through `onTextChange`.
 * The in-progress stroke and in-progress erase are kept local so a drag never
 * touches the parent until it ends.
 */
export function NotebookCanvas({
  strokes,
  text,
  onStrokesChange,
  onTextChange,
  editable = true,
  style,
}: NotebookCanvasProps) {
  const [mode, setMode] = useState<CanvasMode>('write');
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1].value);
  const [highlighterColor, setHighlighterColor] = useState(HIGHLIGHTER_COLORS[0].value);
  const [highlighterWidth, setHighlighterWidth] = useState(HIGHLIGHTER_WIDTHS[1].value);
  const [eraserSizeKey, setEraserSizeKey] = useState<EraserSizeKey>('medium');
  const eraserRadius = ERASER_SIZES.find((option) => option.key === eraserSizeKey)?.radius ?? 26;
  const [, setTemporaryEraser] = useState(false);
  const [currentPoints, setCurrentPoints] = useState<NotePoint[]>([]);
  const [erasedIds, setErasedIds] = useState<string[]>([]);
  const [erasePoint, setErasePoint] = useState<NotePoint | null>(null);
  const [undoEraseSnapshot, setUndoEraseSnapshot] = useState<NoteStroke[] | null>(null);
  /** Transient "Pen" / "Eraser" badge shown after a Pencil double-tap. */
  const [toolToast, setToolToast] = useState<DrawingMode | 'erase' | null>(null);
  /** Dev-only diagnostic to verify what real hardware reports in Expo Go. */
  const [lastPointerType, setLastPointerType] = useState<PointerLabel | null>(null);
  const [lastGestureDecision, setLastGestureDecision] = useState<'activated' | 'failed' | null>(
    null,
  );
  /** Disable page scrolling only while a confirmed stylus stroke is live. */
  const [stylusStrokeActive, setStylusStrokeActive] = useState(false);

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
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const previousDrawingToolRef = useRef<DrawingMode>('write');
  const temporaryEraserRef = useRef(false);
  /** Strokes erased during the current erase drag (committed on release). */
  const erasedIdsRef = useRef<string[]>([]);
  /** True between a Pencil touch-down and the drawing gesture finishing. */
  const drawingRef = useRef(false);
  /**
   * Authoritative in-progress stroke points. Held in a ref so the gesture
   * callbacks read and commit them synchronously; `currentPoints` state mirrors
   * it only for rendering. Every stroke starts this from scratch.
   */
  const currentPointsRef = useRef<NotePoint[]>([]);
  /**
   * id of the touch that started the live stroke. Only that touch lifting ends
   * the stroke — a resting palm or any other touch is ignored.
   */
  const activeTouchIdRef = useRef<number | null>(null);
  /** Current page offset so viewport-local Pencil coordinates map onto the long paper. */
  const scrollOffsetYRef = useRef(0);
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

  // Commit the in-progress stroke (read synchronously from the ref) as its own
  // new stroke, then clear it. A 1-point stroke is kept — it renders as a dot.
  const commitStroke = useCallback(() => {
    const pts = currentPointsRef.current;
    if (pts.length > 0) {
      const isHighlighter = modeRef.current === 'highlight';
      const stroke: NoteStroke = {
        id: makeStrokeId(),
        tool: isHighlighter ? 'highlighter' : 'pen',
        color: isHighlighter ? highlighterColorRef.current : penColorRef.current,
        width: isHighlighter ? highlighterWidthRef.current : penWidthRef.current,
        opacity: isHighlighter ? 0.34 : 1,
        points: pts,
        createdAt: new Date().toISOString(),
      };
      setUndoEraseSnapshot(null);
      onStrokesChangeRef.current([...strokesRef.current, stroke]);
    }
    currentPointsRef.current = [];
    setCurrentPoints([]);
  }, []);

  // Erase any not-yet-erased stroke whose path passes within the eraser
  // radius of (x, y). Changes are kept local until the drag ends.
  const eraseAt = useCallback((x: number, y: number) => {
    let changed = false;
    for (const stroke of strokesRef.current) {
      if (erasedIdsRef.current.includes(stroke.id)) continue;
      if (strokeNearPoint(stroke, x, y, eraserRadiusRef.current)) {
        erasedIdsRef.current.push(stroke.id);
        changed = true;
      }
    }
    if (changed) setErasedIds([...erasedIdsRef.current]);
  }, []);

  const commitErase = useCallback(() => {
    if (erasedIdsRef.current.length > 0) {
      const removed = new Set(erasedIdsRef.current);
      setUndoEraseSnapshot(strokesRef.current);
      onStrokesChangeRef.current(strokesRef.current.filter((s) => !removed.has(s.id)));
    }
    erasedIdsRef.current = [];
    setErasedIds([]);
    setErasePoint(null);
  }, []);

  /**
   * End the live stroke: commit whichever drag was in progress (the other
   * commit is a no-op) and clear every piece of in-progress state. Idempotent —
   * safe to call from onTouchesUp, onTouchesCancelled and onFinalize together.
   */
  const endStroke = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    activeTouchIdRef.current = null;
    setStylusStrokeActive(false);
    commitStroke();
    commitErase();
    restoreTemporaryEraserIfNeeded();
  }, [commitStroke, commitErase, restoreTemporaryEraserIfNeeded]);

  /** Discard the in-progress stroke without committing it (used on tool change). */
  const abortStroke = useCallback(() => {
    drawingRef.current = false;
    activeTouchIdRef.current = null;
    currentPointsRef.current = [];
    erasedIdsRef.current = [];
    setStylusStrokeActive(false);
    setCurrentPoints([]);
    setErasePoint(null);
    setErasedIds([]);
  }, []);

  /**
   * The draw / erase gesture.
   *
   * `manualActivation` lets us inspect the pointer type on touch-down before
   * deciding what the drag means: confirmed stylus input activates the gesture
   * (drawing or erasing), while every non-stylus pointer fails immediately so
   * the underlying ScrollView scrolls instead — that is what keeps finger
   * scrolling working with no manual mode switch.
   *
   * Stroke lifecycle is driven by the touch-events API, never by Pan state
   * alone: every fresh touch-down begins a brand-new stroke, and the stroke
   * ends the instant its own touch lifts (`onTouchesUp`) or is cancelled.
   * `onFinalize` is only a backstop. This is what guarantees two separate taps
   * can never be merged into one connected line.
   * `runOnJS` keeps the callbacks on the JS thread for direct setState.
   */
  const drawGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .manualActivation(true)
        .onTouchesDown((event, manager) => {
          // An extra touch landing on top of a live stroke (e.g. a resting
          // palm) — keep the current stroke and ignore the extra finger.
          if (event.numberOfTouches > 1) return;

          // First touch of a fresh gesture. If a previous stroke somehow never
          // finalized, commit and clear it NOW, so this new touch starts a
          // brand-new stroke and can never extend the old one.
          if (drawingRef.current) endStroke();

          const activeMode = modeRef.current;
          if (activeMode !== 'write' && activeMode !== 'highlight' && activeMode !== 'erase') {
            manager.fail();
            return;
          }

          setLastPointerType(pointerLabel(event.pointerType));

          // Only confirmed Apple Pencil / stylus input draws; every other
          // pointer fails the gesture so the ScrollView scrolls (finger scroll).
          if (event.pointerType !== PointerType.STYLUS) {
            setLastGestureDecision('failed');
            manager.fail();
            return;
          }

          const touch = event.changedTouches[0] ?? event.allTouches[0];
          if (!touch) {
            manager.fail();
            return;
          }

          const point = { x: touch.x, y: touch.y + scrollOffsetYRef.current };
          manager.activate();
          drawingRef.current = true;
          activeTouchIdRef.current = touch.id;
          setLastGestureDecision('activated');
          setStylusStrokeActive(true);

          if (activeMode === 'write' || activeMode === 'highlight') {
            // A brand-new stroke — its point list starts from scratch.
            currentPointsRef.current = [point];
            setCurrentPoints([point]);
          } else {
            erasedIdsRef.current = [];
            setErasePoint(point);
            eraseAt(point.x, point.y);
          }
        })
        .onTouchesMove((event) => {
          if (!drawingRef.current) return;
          // Follow only the touch that started this stroke.
          const touch =
            event.changedTouches.find((t) => t.id === activeTouchIdRef.current) ??
            event.allTouches.find((t) => t.id === activeTouchIdRef.current);
          if (!touch) return;
          const point = { x: touch.x, y: touch.y + scrollOffsetYRef.current };

          if (modeRef.current === 'write' || modeRef.current === 'highlight') {
            const pts = currentPointsRef.current;
            const last = pts[pts.length - 1];
            if (
              last &&
              Math.hypot(point.x - last.x, point.y - last.y) < MIN_POINT_DISTANCE
            ) {
              return;
            }
            const next = [...pts, point];
            currentPointsRef.current = next;
            setCurrentPoints(next);
          } else if (modeRef.current === 'erase') {
            setErasePoint(point);
            eraseAt(point.x, point.y);
          }
        })
        .onTouchesUp((event) => {
          // End the stroke the moment its own touch lifts. The touch-events
          // API reports this reliably even when the Pan's onFinalize does not.
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
          // Backstop — commit + clear anything still in progress (idempotent).
          endStroke();
        }),
    [endStroke, eraseAt],
  );

  // A tool change must never leave a half-finished stroke behind for the next
  // gesture to extend — drop any in-progress stroke whenever the mode changes.
  useEffect(() => {
    abortStroke();
  }, [mode, abortStroke]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Apple Pencil double-tap enters a temporary eraser from Pen/Highlighter.
  // It restores only after the Pencil gesture ends, so continuous erasing
  // works while the Pencil stays down.
  const handleDoubleTap = useCallback(() => {
    const current = modeRef.current;
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
  }, [showToolToast]);

  useEffect(() => {
    if (!editable) return;
    // No-op subscription in Expo Go / web / Android — callback simply never fires.
    return addPencilDoubleTapListener(handleDoubleTap);
  }, [editable, handleDoubleTap]);

  const undo = useCallback(() => {
    if (undoEraseSnapshot) {
      onStrokesChange(undoEraseSnapshot);
      setUndoEraseSnapshot(null);
      return;
    }
    if (strokes.length > 0) onStrokesChange(strokes.slice(0, -1));
  }, [strokes, onStrokesChange, undoEraseSnapshot]);

  const clearPage = useCallback(() => {
    if (strokes.length === 0 && text.length === 0) return;
    Alert.alert(
      'Clear page',
      'Remove all handwriting and typed notes from this page? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            setUndoEraseSnapshot(null);
            onStrokesChange([]);
            onTextChange('');
          },
        },
      ],
    );
  }, [strokes.length, text.length, onStrokesChange, onTextChange]);

  // Committed strokes rebuild only when strokes change or a stroke is erased —
  // not on every touch move while the current stroke is being drawn. Each is
  // its own StrokeShape, so committed strokes always render independently.
  const committedShapes = useMemo(
    () => {
      const visible = strokes.filter((stroke) => !erasedIds.includes(stroke.id));
      return [
        ...visible
          .filter((stroke) => stroke.tool === 'highlighter')
          .map((stroke) => <StrokeShape key={stroke.id} stroke={stroke} />),
        ...visible
          .filter((stroke) => stroke.tool !== 'highlighter')
          .map((stroke) => <StrokeShape key={stroke.id} stroke={stroke} />),
      ];
    },
    [strokes, erasedIds],
  );

  const ruleLines = useMemo(() => {
    const count = Math.ceil(PAGE_HEIGHT / LINE_GAP);
    return Array.from({ length: count }).map((_, i) => (
      <View key={i} style={styles.ruleLine} />
    ));
  }, []);

  const isEmpty = strokes.length === 0 && currentPoints.length === 0 && text.length === 0;

  return (
    <View style={[styles.container, style]}>
      {editable ? (
        <View style={styles.toolbar}>
          <View style={styles.toolbarLeft}>
            {/* Primary tool toggle */}
            <View style={styles.segment}>
              {DRAW_MODES.map((m) => {
                const active = mode === m.key;
                return (
                  <Pressable
                    key={m.key}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => changeMode(m.key)}
                    style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                  >
                    <ModeIcon mode={m.key} active={active} />
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {m.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Pen options — only meaningful while writing */}
            {mode === 'write' || mode === 'highlight' ? (
              <>
                <View style={styles.toolGroup}>
                  {(mode === 'highlight' ? HIGHLIGHTER_COLORS : PEN_COLORS).map((pen) => {
                    const selectedColor = mode === 'highlight' ? highlighterColor : penColor;
                    return (
                    <Pressable
                      key={pen.key}
                      accessibilityRole="button"
                      accessibilityLabel={`${mode === 'highlight' ? 'Highlighter' : 'Pen'} colour ${pen.key}`}
                      accessibilityState={{ selected: selectedColor === pen.value }}
                      onPress={() => (mode === 'highlight' ? setHighlighterColor(pen.value) : setPenColor(pen.value))}
                      style={[styles.swatch, selectedColor === pen.value && styles.swatchActive]}
                    >
                      <View style={[styles.swatchDot, { backgroundColor: pen.value }]} />
                    </Pressable>
                    );
                  })}
                </View>
                <View style={styles.toolGroup}>
                  {(mode === 'highlight' ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS).map((pen) => {
                    const selectedWidth = mode === 'highlight' ? highlighterWidth : penWidth;
                    return (
                    <Pressable
                      key={pen.key}
                      accessibilityRole="button"
                      accessibilityLabel={`${mode === 'highlight' ? 'Highlighter' : 'Pen'} width ${pen.key}`}
                      accessibilityState={{ selected: selectedWidth === pen.value }}
                      onPress={() => (mode === 'highlight' ? setHighlighterWidth(pen.value) : setPenWidth(pen.value))}
                      style={[styles.widthBtn, selectedWidth === pen.value && styles.widthBtnActive]}
                    >
                      <View
                        style={{
                          width: pen.dot,
                          height: pen.dot,
                          borderRadius: pen.dot / 2,
                          backgroundColor: colors.deepNavy,
                        }}
                      />
                    </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            {/*
             * Eraser size options are NOT rendered here. They used to live
             * inside this flexWrap row alongside the segment + (when in
             * write/highlight mode) color/width groups. With four segment
             * buttons plus three eraser-size buttons the row wrapped into a
             * second line on iPad widths, and that second line sat over the
             * top edge of the GestureScrollView below — drawGesture (Pan +
             * manualActivation) hit-tested the wrapped row first and swallowed
             * the taps before the Pressables ever fired. The eraser size row
             * is now a dedicated secondary bar below the main toolbar (see
             * `<View style={styles.eraserSizeBar} />` further down) which is
             * outside any gesture container and never wraps.
             */}
          </View>

          <View style={styles.toolbarRight}>
            {/* Manual fallback only — normal iPad use should be Pencil writes, finger scrolls. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scroll mode (fallback)"
              accessibilityState={{ selected: mode === 'scroll' }}
              onPress={() => changeMode(mode === 'scroll' ? 'write' : 'scroll')}
              style={[styles.fallbackBtn, mode === 'scroll' && styles.fallbackBtnActive]}
            >
              <Ionicons
                name="hand-left-outline"
                size={15}
                color={mode === 'scroll' ? colors.pearlWhite : colors.textTertiary}
              />
              <Text
                style={[styles.fallbackText, mode === 'scroll' && styles.fallbackTextActive]}
              >
                Scroll
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Undo last stroke"
              onPress={undo}
              disabled={strokes.length === 0 && !undoEraseSnapshot}
              style={[styles.toolBtn, strokes.length === 0 && !undoEraseSnapshot && styles.toolBtnDisabled]}
            >
              <Ionicons name="arrow-undo" size={18} color={colors.deepNavy} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear page"
              onPress={clearPage}
              style={styles.toolBtn}
            >
              <Ionicons name="trash-outline" size={18} color={colors.recordingRed} />
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* ---- Dedicated eraser-size bar ----
          Lives *outside* the flexWrap-prone primary toolbar and *outside* the
          GestureDetector below. Renders only in erase mode. Bigger tap
          targets, hitSlop, and a console.warn on press so on-device taps
          are observable in the Metro log without a debugger. */}
      {editable && mode === 'erase' ? (
        <View style={styles.eraserSizeBar} pointerEvents="auto">
          <Text style={styles.eraserSizeBarLabel}>Eraser size</Text>
          <View style={styles.eraserSizeSegment}>
            {ERASER_SIZES.map((option) => {
              const active = eraserSizeKey === option.key;
              return (
                <Pressable
                  key={option.key}
                  accessibilityRole="button"
                  accessibilityLabel={`Eraser size ${option.label}`}
                  accessibilityState={{ selected: active }}
                  hitSlop={10}
                  onPress={() => {
                    if (__DEV__) {
                      // console.warn so the log is visibly louder than other
                      // diagnostics — proves the tap reached the Pressable.
                      console.warn('[NotebookCanvas] eraser size press', option.key, option.radius);
                    }
                    setEraserSizeKey(option.key);
                  }}
                  style={({ pressed }) => [
                    styles.eraserSizeSegmentBtn,
                    active && styles.eraserSizeSegmentBtnActive,
                    pressed && styles.eraserSizeSegmentBtnPressed,
                  ]}
                >
                  <View
                    style={[
                      styles.eraserSizeIndicator,
                      {
                        width: option.radius * 0.45,
                        height: option.radius * 0.45,
                        borderRadius: option.radius * 0.225,
                      },
                      active && styles.eraserSizeIndicatorActive,
                    ]}
                  />
                  <Text
                    style={[
                      styles.eraserSizeSegmentText,
                      active && styles.eraserSizeSegmentTextActive,
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {/* ---- Long scrollable paper ----
          The gesture lives on the actual ScrollView, not on an absolute overlay
          above it. That keeps finger touches in the scroll view's hit-test path
          from the beginning; only confirmed stylus input activates drawing. */}
      <GestureDetector gesture={drawGesture}>
        <GestureScrollView
          style={styles.scroll}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!stylusStrokeActive}
          scrollEventThrottle={16}
          onScroll={(event) => {
            scrollOffsetYRef.current = event.nativeEvent.contentOffset.y;
          }}
        >
          <View style={styles.paper}>
          {/* Ruled lines + margin */}
          <View style={styles.ruled} pointerEvents="none">
            {ruleLines}
          </View>
          <View style={styles.marginLine} pointerEvents="none" />

          {/* Typed-notes layer */}
          <TextInput
            style={styles.textLayer}
            value={text}
            onChangeText={onTextChange}
            editable={editable && mode === 'type'}
            pointerEvents={editable && mode === 'type' ? 'auto' : 'none'}
            multiline
            scrollEnabled={false}
            placeholder=""
            textAlignVertical="top"
          />

          {/* Handwriting layer (never captures touches) */}
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Svg width="100%" height={PAGE_HEIGHT}>
              {committedShapes}
              {currentPoints.length > 0 ? (
                <StrokeShape
                  stroke={{
                    points: currentPoints,
                    tool: mode === 'highlight' ? 'highlighter' : 'pen',
                    color: mode === 'highlight' ? highlighterColor : penColor,
                    width: mode === 'highlight' ? highlighterWidth : penWidth,
                    opacity: mode === 'highlight' ? 0.34 : 1,
                  }}
                />
              ) : null}
              {mode === 'erase' && erasePoint ? (
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
            </Svg>
          </View>

          {/* Empty-state hint */}
          {editable && isEmpty ? (
            <View style={styles.emptyHint} pointerEvents="none">
              <Ionicons name="pencil-outline" size={22} color={colors.mutedBlueGray} />
              <Text style={styles.emptyHintText}>
                {mode === 'scroll'
                  ? 'Scroll mode is on. Drag with one finger to move around the page.'
                  : 'Use Apple Pencil to write. Use your finger to scroll.'}
              </Text>
              <Text style={styles.emptyHintSub}>
                {doubleTapAvailable
                  ? 'Double-tap your Apple Pencil to switch between pen and eraser.'
                  : 'Switch between pen, eraser and typing from the toolbar above.'}
              </Text>
            </View>
          ) : null}
          </View>
        </GestureScrollView>
      </GestureDetector>

      {__DEV__ && editable && lastPointerType ? (
        <View style={styles.pointerDebug} pointerEvents="none">
          <Text style={styles.pointerDebugText}>
            {mode.toUpperCase()} · {lastPointerType} · {lastGestureDecision ?? 'idle'} · scroll{' '}
            {stylusStrokeActive ? 'off' : 'on'}
          </Text>
        </View>
      ) : null}

      {/* Tool badge — brief feedback after an Apple Pencil double-tap */}
      {editable && toolToast ? (
        <View style={styles.toolToastWrap} pointerEvents="none">
          <View style={styles.toolToast}>
            <ModeIcon mode={toolToast} active />
            <Text style={styles.toolToastText}>
              {toolToast === 'erase' ? 'Eraser' : toolToast === 'highlight' ? 'Highlighter' : 'Pen'}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

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

  // ---- Toolbar ----
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  toolbarLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  toolbarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    padding: 3,
    gap: 3,
  },
  segmentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.sm,
  },
  segmentBtnActive: {
    backgroundColor: colors.deepNavy,
  },
  segmentText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.deepNavy,
  },
  segmentTextActive: {
    color: colors.pearlWhite,
  },
  toolGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  swatch: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchActive: {
    borderColor: colors.deepNavy,
  },
  swatchDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  widthBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  widthBtnActive: {
    backgroundColor: colors.iceTint,
    borderColor: colors.iceBlue,
  },
  eraserSizeBtn: {
    minWidth: 56,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  eraserSizeText: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    color: colors.deepNavy,
  },

  // ---- Dedicated eraser-size bar (Phase: NotebookCanvas eraser fix) ----
  // Lives below the primary toolbar, outside the GestureDetector.
  eraserSizeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  eraserSizeBarLabel: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    letterSpacing: 0.4,
    color: colors.textTertiary,
    textTransform: 'uppercase',
  },
  eraserSizeSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    padding: 3,
  },
  eraserSizeSegmentBtn: {
    minWidth: 78,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: 'transparent',
  },
  eraserSizeSegmentBtnActive: {
    backgroundColor: colors.deepNavy,
  },
  eraserSizeSegmentBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.97 }],
  },
  eraserSizeSegmentText: {
    fontSize: fontSize.sm,
    fontWeight: '800',
    color: colors.deepNavy,
  },
  eraserSizeSegmentTextActive: {
    color: colors.pearlWhite,
  },
  eraserSizeIndicator: {
    backgroundColor: colors.deepNavy,
  },
  eraserSizeIndicatorActive: {
    backgroundColor: colors.pearlWhite,
  },
  toolBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolBtnDisabled: {
    opacity: 0.4,
  },
  // Scroll fallback — available, but intentionally quieter than the core tools.
  fallbackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fallbackBtnActive: {
    backgroundColor: colors.deepNavy,
    borderColor: colors.deepNavy,
  },
  fallbackText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textTertiary,
  },
  fallbackTextActive: {
    color: colors.pearlWhite,
  },
  // ---- Paper ----
  scroll: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  paper: {
    width: '100%',
    height: PAGE_HEIGHT,
    backgroundColor: colors.paper,
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
  pointerDebug: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(6, 27, 52, 0.72)',
  },
  pointerDebugText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.pearlWhite,
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
