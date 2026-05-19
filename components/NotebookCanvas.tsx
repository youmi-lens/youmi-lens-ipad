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

const LINE_GAP = 34;
const MARGIN_X = 56;
const MIN_POINT_DISTANCE = 1.8;
/** The notebook is one long ruled page — roughly three iPad screens tall. */
const PAGE_HEIGHT = 3200;
const ERASER_RADIUS = 22;
/** How long the Pen / Eraser badge stays on screen after a double-tap. */
const TOOL_TOAST_MS = 1100;

export type CanvasMode = 'write' | 'type' | 'erase' | 'scroll';

/** Primary tools shown in the toolbar segment. Scroll is a fallback action. */
const DRAW_MODES: { key: CanvasMode; label: string }[] = [
  { key: 'write', label: 'Write' },
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
  stroke: { points: NotePoint[]; color: string; width: number };
}) {
  const { points, color, width } = stroke;
  if (points.length === 0) return null;
  if (points.length === 1) {
    return (
      <Circle cx={points[0].x} cy={points[0].y} r={Math.max(width / 2, 1.6)} fill={color} />
    );
  }
  return (
    <Path
      d={strokeToPath(points)}
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

function ModeIcon({ mode, active }: { mode: CanvasMode; active: boolean }) {
  const color = active ? colors.pearlWhite : colors.deepNavy;
  if (mode === 'write') return <Ionicons name="pencil" size={15} color={color} />;
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
  const [currentPoints, setCurrentPoints] = useState<NotePoint[]>([]);
  const [erasedIds, setErasedIds] = useState<string[]>([]);
  const [erasePoint, setErasePoint] = useState<NotePoint | null>(null);
  /** Transient "Pen" / "Eraser" badge shown after a Pencil double-tap. */
  const [toolToast, setToolToast] = useState<'write' | 'erase' | null>(null);
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
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const onStrokesChangeRef = useRef(onStrokesChange);
  onStrokesChangeRef.current = onStrokesChange;
  const modeRef = useRef(mode);
  modeRef.current = mode;
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

  // Commit the in-progress stroke (read synchronously from the ref) as its own
  // new stroke, then clear it. A 1-point stroke is kept — it renders as a dot.
  const commitStroke = useCallback(() => {
    const pts = currentPointsRef.current;
    if (pts.length > 0) {
      const stroke: NoteStroke = {
        id: makeStrokeId(),
        color: penColorRef.current,
        width: penWidthRef.current,
        points: pts,
        createdAt: new Date().toISOString(),
      };
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
      for (const point of stroke.points) {
        if (Math.hypot(point.x - x, point.y - y) <= ERASER_RADIUS) {
          erasedIdsRef.current.push(stroke.id);
          changed = true;
          break;
        }
      }
    }
    if (changed) setErasedIds([...erasedIdsRef.current]);
  }, []);

  const commitErase = useCallback(() => {
    if (erasedIdsRef.current.length > 0) {
      const removed = new Set(erasedIdsRef.current);
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
  }, [commitStroke, commitErase]);

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
          if (activeMode !== 'write' && activeMode !== 'erase') {
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

          if (activeMode === 'write') {
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

          if (modeRef.current === 'write') {
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

  /** Briefly show the Pen / Eraser badge with a light haptic tick. */
  const showToolToast = useCallback((tool: 'write' | 'erase') => {
    setToolToast(tool);
    Haptics.selectionAsync().catch(() => {});
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToolToast(null), TOOL_TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Apple Pencil double-tap toggles Write <-> Eraser. Type / Scroll are left
  // untouched so a double-tap never disrupts typing or scrolling.
  const handleDoubleTap = useCallback(() => {
    const current = modeRef.current;
    if (current !== 'write' && current !== 'erase') return;
    const next: CanvasMode = current === 'write' ? 'erase' : 'write';
    setMode(next);
    showToolToast(next);
  }, [showToolToast]);

  useEffect(() => {
    if (!editable) return;
    // No-op subscription in Expo Go / web / Android — callback simply never fires.
    return addPencilDoubleTapListener(handleDoubleTap);
  }, [editable, handleDoubleTap]);

  const undo = useCallback(() => {
    if (strokes.length > 0) onStrokesChange(strokes.slice(0, -1));
  }, [strokes, onStrokesChange]);

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
    () =>
      strokes
        .filter((stroke) => !erasedIds.includes(stroke.id))
        .map((stroke) => <StrokeShape key={stroke.id} stroke={stroke} />),
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
                    onPress={() => setMode(m.key)}
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
            {mode === 'write' ? (
              <>
                <View style={styles.toolGroup}>
                  {PEN_COLORS.map((pen) => (
                    <Pressable
                      key={pen.key}
                      accessibilityRole="button"
                      accessibilityLabel={`Pen colour ${pen.key}`}
                      accessibilityState={{ selected: penColor === pen.value }}
                      onPress={() => setPenColor(pen.value)}
                      style={[styles.swatch, penColor === pen.value && styles.swatchActive]}
                    >
                      <View style={[styles.swatchDot, { backgroundColor: pen.value }]} />
                    </Pressable>
                  ))}
                </View>
                <View style={styles.toolGroup}>
                  {PEN_WIDTHS.map((pen) => (
                    <Pressable
                      key={pen.key}
                      accessibilityRole="button"
                      accessibilityLabel={`Pen width ${pen.key}`}
                      accessibilityState={{ selected: penWidth === pen.value }}
                      onPress={() => setPenWidth(pen.value)}
                      style={[styles.widthBtn, penWidth === pen.value && styles.widthBtnActive]}
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
                  ))}
                </View>
              </>
            ) : null}
          </View>

          <View style={styles.toolbarRight}>
            {/* Manual fallback only — normal iPad use should be Pencil writes, finger scrolls. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scroll mode (fallback)"
              accessibilityState={{ selected: mode === 'scroll' }}
              onPress={() => setMode((m) => (m === 'scroll' ? 'write' : 'scroll'))}
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
              disabled={strokes.length === 0}
              style={[styles.toolBtn, strokes.length === 0 && styles.toolBtnDisabled]}
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
                  stroke={{ points: currentPoints, color: penColor, width: penWidth }}
                />
              ) : null}
              {mode === 'erase' && erasePoint ? (
                <Circle
                  cx={erasePoint.x}
                  cy={erasePoint.y}
                  r={ERASER_RADIUS}
                  stroke={colors.recordingRed}
                  strokeWidth={1.5}
                  fill="rgba(239, 68, 68, 0.12)"
                />
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
              {toolToast === 'erase' ? 'Eraser' : 'Pen'}
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
        {strokes.map((stroke) => (
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
