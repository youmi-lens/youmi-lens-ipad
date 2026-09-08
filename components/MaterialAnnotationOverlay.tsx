import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, PointerType } from 'react-native-gesture-handler';
import Svg, { Circle, Path } from 'react-native-svg';

import type { MaterialAnnotationStroke, MaterialAnnotationTool, MaterialAnnotationPoint } from '@/lib/models';

const MIN_POINT_DISTANCE = 1.8;

export type MaterialAnnotationMode = 'scroll' | 'pen' | 'highlighter' | 'eraser';
export type MaterialDrawingMode = 'pen' | 'highlighter';

export type MaterialAnnotationOverlayProps = {
  mode: MaterialAnnotationMode;
  previousDrawingTool: MaterialDrawingMode;
  strokes: MaterialAnnotationStroke[];
  color: string;
  width: number;
  highlighterColor: string;
  highlighterWidth: number;
  eraserRadius: number;
  onAddStroke: (stroke: MaterialAnnotationStroke) => void;
  onEraseStrokeIds: (ids: string[]) => void;
  onModeChange: (mode: MaterialAnnotationMode) => void;
  onStylusStrokeActiveChange?: (active: boolean) => void;
  children: React.ReactNode;
};

function makeStrokeId(): string {
  return `matstroke_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function strokeToPath(points: MaterialAnnotationPoint[]): string {
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

function strokeNearPoint(
  stroke: MaterialAnnotationStroke,
  x: number,
  y: number,
  radius: number,
): boolean {
  return stroke.points.some((point) => Math.hypot(point.x - x, point.y - y) <= radius);
}

function hasUsefulStylusData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((item) => {
    if (typeof item !== 'number') return false;
    // RNGH/web stylus data defaults can be zero-ish; any non-zero pressure,
    // tilt, altitude, or azimuth means this is not a plain finger touch.
    return Math.abs(item) > 0.0001;
  });
}

function hasStylusLikeTouchMetadata(touch: unknown): boolean {
  if (!touch || typeof touch !== 'object') return false;
  const data = touch as Record<string, unknown>;
  if (hasUsefulStylusData(data.stylusData)) return true;
  if (typeof data.altitudeAngle === 'number') return true;
  if (typeof data.azimuthAngle === 'number') return true;
  if (typeof data.tiltX === 'number' || typeof data.tiltY === 'number') return true;
  return false;
}

function isLikelyApplePencilEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const data = event as Record<string, unknown>;
  if (data.pointerType === PointerType.STYLUS) return true;
  if (hasUsefulStylusData(data.stylusData)) return true;

  const allTouches = Array.isArray(data.allTouches) ? data.allTouches : [];
  const changedTouches = Array.isArray(data.changedTouches) ? data.changedTouches : [];
  return [...changedTouches, ...allTouches].some(hasStylusLikeTouchMetadata);
}

function StrokeShape({ stroke }: { stroke: MaterialAnnotationStroke }) {
  const { points, color, width, opacity } = stroke;
  if (points.length === 0) return null;
  if (points.length === 1) {
    return (
      <Circle
        cx={points[0].x}
        cy={points[0].y}
        r={Math.max(width / 2, 1.6)}
        fill={color}
        fillOpacity={opacity ?? 1}
      />
    );
  }
  return (
    <Path
      d={strokeToPath(points)}
      stroke={color}
      strokeWidth={width}
      strokeOpacity={opacity ?? 1}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

type ActiveAnnotationInkHandle = {
  begin: (point: MaterialAnnotationPoint) => void;
  append: (point: MaterialAnnotationPoint) => void;
  clear: () => void;
  getPoints: () => MaterialAnnotationPoint[];
};

type ActiveAnnotationInkHostProps = {
  tool: MaterialAnnotationTool;
  color: string;
  width: number;
  opacity: number;
};

/**
 * Live ink only — mirrors NotebookCanvas's ActiveInkHost (components/
 * NotebookCanvas.tsx). Owns its own local React state so each Pencil sample
 * updates only this small overlay, never the parent MaterialAnnotationOverlay
 * (which also holds every already-committed stroke on the page and the
 * embedded PDF `children`). Before this, the in-progress stroke's points
 * lived in the PARENT's state, so every sampled point re-rendered the whole
 * overlay AND re-ran the highlighterStrokes/penStrokes filters over the
 * full per-page stroke history — cost that grew with how much was already
 * annotated on that page. That mismatch (not sampling/smoothing/pressure,
 * which are identical to Notebook here) is what made this pen feel less
 * crisp than Notebook's.
 */
const ActiveAnnotationInkHost = memo(
  forwardRef<ActiveAnnotationInkHandle, ActiveAnnotationInkHostProps>(function ActiveAnnotationInkHost(
    { tool, color, width, opacity },
    ref,
  ) {
    const pointsRef = useRef<MaterialAnnotationPoint[]>([]);
    const [livePoints, setLivePoints] = useState<MaterialAnnotationPoint[]>([]);

    useImperativeHandle(
      ref,
      () => ({
        begin(point) {
          pointsRef.current = [point];
          setLivePoints([point]);
        },
        append(point) {
          const points = pointsRef.current;
          const last = points[points.length - 1];
          if (last && Math.hypot(last.x - point.x, last.y - point.y) < MIN_POINT_DISTANCE) return;
          const next = [...points, point];
          pointsRef.current = next;
          setLivePoints(next);
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

    if (livePoints.length === 0) return null;

    return (
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <StrokeShape stroke={{ id: 'current_annotation_stroke', tool, color, width, opacity, points: livePoints, createdAt: '' }} />
      </Svg>
    );
  }),
);

export function MaterialAnnotationOverlay({
  mode,
  previousDrawingTool,
  strokes,
  color,
  width,
  highlighterColor,
  highlighterWidth,
  eraserRadius,
  onAddStroke,
  onEraseStrokeIds,
  onModeChange,
  onStylusStrokeActiveChange,
  children,
}: MaterialAnnotationOverlayProps) {
  // Live points now live entirely inside ActiveAnnotationInkHost's own local
  // state (see its doc comment) — this component never re-renders per point.
  const activeInkRef = useRef<ActiveAnnotationInkHandle>(null);
  const erasedIdsRef = useRef<string[]>([]);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const previousDrawingToolRef = useRef(previousDrawingTool);
  previousDrawingToolRef.current = previousDrawingTool;
  const eraserRadiusRef = useRef(eraserRadius);
  eraserRadiusRef.current = eraserRadius;
  const onStylusStrokeActiveChangeRef = useRef(onStylusStrokeActiveChange);
  onStylusStrokeActiveChangeRef.current = onStylusStrokeActiveChange;
  const activeTouchIdRef = useRef<number | null>(null);
  const drawingRef = useRef(false);
  const erasingRef = useRef(false);

  useEffect(() => {
    activeInkRef.current?.clear();
    erasedIdsRef.current = [];
    activeTouchIdRef.current = null;
    drawingRef.current = false;
    erasingRef.current = false;
    onStylusStrokeActiveChangeRef.current?.(false);
  }, [mode]);

  const addPoint = useCallback((x: number, y: number) => {
    activeInkRef.current?.append({ x, y });
  }, []);

  const eraseAt = useCallback((x: number, y: number) => {
    let changed = false;
    for (const stroke of strokesRef.current) {
      if (erasedIdsRef.current.includes(stroke.id)) continue;
      if (strokeNearPoint(stroke, x, y, eraserRadiusRef.current)) {
        erasedIdsRef.current.push(stroke.id);
        changed = true;
      }
    }
    if (changed) onEraseStrokeIds([...erasedIdsRef.current]);
  }, [onEraseStrokeIds]);

  const commitStroke = useCallback(() => {
    const points = activeInkRef.current?.getPoints() ?? [];
    if (points.length > 0) {
      const tool: MaterialAnnotationTool = modeRef.current === 'highlighter' ? 'highlighter' : 'pen';
      onAddStroke({
        id: makeStrokeId(),
        tool,
        color: tool === 'highlighter' ? highlighterColor : color,
        width: tool === 'highlighter' ? highlighterWidth : width,
        opacity: tool === 'highlighter' ? 0.34 : 1,
        points,
        createdAt: new Date().toISOString(),
      });
    }
    activeInkRef.current?.clear();
  }, [color, highlighterColor, highlighterWidth, onAddStroke, width]);

  const finishStylusGesture = useCallback(() => {
    if (drawingRef.current) commitStroke();
    const shouldRestoreAfterErase = erasingRef.current;
    drawingRef.current = false;
    erasingRef.current = false;
    activeTouchIdRef.current = null;
    erasedIdsRef.current = [];
    onStylusStrokeActiveChangeRef.current?.(false);
    if (shouldRestoreAfterErase) {
      onModeChange(previousDrawingToolRef.current);
    }
  }, [commitStroke, onModeChange]);

  const gesture = useMemo(() => {
    const annotationEnabled = mode !== 'scroll';
    const nativePdfGesture = Gesture.Native()
      .enabled(annotationEnabled)
      .shouldActivateOnStart(true)
      .disallowInterruption(false);

    const stylusAnnotationGesture = Gesture.Pan()
        .enabled(annotationEnabled)
        .runOnJS(true)
        .manualActivation(true)
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        // Keep native PDF scrolling/pinch responsive for finger and multitouch.
        // We activate only after a Pencil/stylus touch is confirmed; failed
        // finger gestures should not cancel or starve PDFKit's recognizers.
        .cancelsTouchesInView(false)
        .onTouchesDown((event, manager) => {
          if (event.numberOfTouches > 1) {
            manager.fail();
            return;
          }

          const activeMode = modeRef.current;
          if (activeMode === 'scroll') {
            manager.fail();
            return;
          }

          // Core product rule: stylus annotates; touch/finger/pinch belongs to the PDF.
          // This mirrors NotebookCanvas' manual activation model: only a
          // confirmed Pencil/stylus activates the annotation gesture. Plain
          // touch fails immediately so one-finger scroll and two-finger zoom
          // stay inside react-native-pdf. We intentionally do not use pressure
          // or force as a fallback because that caused finger touches to be
          // misclassified as ink on real iPad hardware.
          if (!isLikelyApplePencilEvent(event)) {
            manager.fail();
            return;
          }

          const touch = event.changedTouches[0] ?? event.allTouches[0];
          if (!touch) {
            manager.fail();
            return;
          }

          manager.activate();
          onStylusStrokeActiveChangeRef.current?.(true);
          activeTouchIdRef.current = touch.id;
          erasedIdsRef.current = [];

          if (activeMode === 'eraser') {
            erasingRef.current = true;
            drawingRef.current = false;
            eraseAt(touch.x, touch.y);
          } else {
            drawingRef.current = true;
            erasingRef.current = false;
            activeInkRef.current?.begin({ x: touch.x, y: touch.y });
          }
        })
        .onTouchesMove((event) => {
          const touch =
            event.changedTouches.find((item) => item.id === activeTouchIdRef.current) ??
            event.allTouches.find((item) => item.id === activeTouchIdRef.current);
          if (!touch) return;

          if (erasingRef.current) {
            eraseAt(touch.x, touch.y);
          } else if (drawingRef.current) {
            addPoint(touch.x, touch.y);
          }
        })
        .onTouchesUp((event) => {
          if (activeTouchIdRef.current == null) return;
          if (event.changedTouches.some((touch) => touch.id === activeTouchIdRef.current)) {
            finishStylusGesture();
          }
        })
        .onTouchesCancelled((event) => {
          if (activeTouchIdRef.current == null) return;
          if (event.changedTouches.some((touch) => touch.id === activeTouchIdRef.current)) {
            finishStylusGesture();
          }
        })
        .onFinalize(() => {
          if (drawingRef.current || erasingRef.current) finishStylusGesture();
        })
        .simultaneousWithExternalGesture(nativePdfGesture);

    return Gesture.Simultaneous(nativePdfGesture, stylusAnnotationGesture);
  }, [addPoint, eraseAt, finishStylusGesture, mode]);

  // Memoized so a re-render for an unrelated reason (e.g. a mode/tool change)
  // never re-filters the full per-page stroke history — only an actual
  // change to `strokes` does. The live/in-progress stroke never touches
  // these; it renders entirely inside ActiveAnnotationInkHost below.
  const highlighterStrokes = useMemo(() => strokes.filter((stroke) => stroke.tool === 'highlighter'), [strokes]);
  const penStrokes = useMemo(() => strokes.filter((stroke) => stroke.tool !== 'highlighter'), [strokes]);
  const showActiveInk = mode !== 'eraser' && mode !== 'scroll';

  const content = (
    <View style={styles.container}>
      {children}
      <View pointerEvents="none" style={styles.overlay}>
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {highlighterStrokes.map((stroke) => <StrokeShape key={stroke.id} stroke={stroke} />)}
          {penStrokes.map((stroke) => <StrokeShape key={stroke.id} stroke={stroke} />)}
        </Svg>
        {showActiveInk ? (
          <ActiveAnnotationInkHost
            ref={activeInkRef}
            tool={mode === 'highlighter' ? 'highlighter' : 'pen'}
            color={mode === 'highlighter' ? highlighterColor : color}
            width={mode === 'highlighter' ? highlighterWidth : width}
            opacity={mode === 'highlighter' ? 0.34 : 1}
          />
        ) : null}
      </View>
    </View>
  );

  return (
    <GestureDetector gesture={gesture}>
      {content}
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 4,
  },
});
