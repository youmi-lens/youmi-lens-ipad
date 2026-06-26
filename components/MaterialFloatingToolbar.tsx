/**
 * MaterialFloatingToolbar — the approved Notebook draggable toolbar, moved into
 * the Course Material (PDF) screen.
 *
 * This is the SAME board / capsule / drag-dock / minimize model as the Notebook
 * toolbar in `components/NotebookCanvas.tsx` (navy-glass shell, grip, icon-only
 * tools, blue active underline, soft press feedback, edge-intent docking). The
 * chrome — colour tokens, glyph SVG paths, NavySurface gradient, GripDots and
 * dock math — is copied verbatim from NotebookCanvas so the two are visually and
 * behaviourally identical.
 *
 * Course Material has less room than the Notebook, so this exposes only the
 * reduced tool/action set: Pen · Highlight · Eraser · Hand/Scroll · Undo · Redo
 * · Minimize. There is intentionally NO context row (no colour / width / size
 * pickers) and none of the Notebook's Select / Text / Insert / Duplicate /
 * Clear tools — just a compact strip. It owns only presentation + drag/dock
 * state; the caller owns the annotation mode + undo/redo + PDF storage, which
 * are unchanged.
 *
 * NotebookCanvas is deliberately left untouched (its toolbar is woven into
 * selection / undo / image state, so extracting it in place is too risky); this
 * component carries its own copy of the shared chrome.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { colors } from '@/constants/theme';

// ---- Navy toolbar tokens — copied verbatim from NotebookCanvas so the two
// ---- toolbars are pixel-identical. ----
const TOOLBAR_NAVY_TOP = '#1E2E50';
const TOOLBAR_NAVY_BOTTOM = '#16233F';
const TOOLBAR_BORDER_COLOR = 'rgba(255,255,255,0.07)';
const TOOLBAR_SELECTED = '#5F86E8';
const TOOLBAR_ICON_IDLE = 'rgba(255,255,255,0.62)';
const TOOLBAR_ICON_DISABLED = 'rgba(255,255,255,0.26)';
const TOOLBAR_DIVIDER_COLOR = 'rgba(255,255,255,0.11)';
const TOOLBAR_SHELL_RADIUS = 22;
const TOOLBAR_MINIMIZED_RADIUS = 16;
const TOOLBAR_CHIP_RADIUS = 11;

const TOOLBAR_EDGE_MARGIN = 12;
const TOOLBAR_DRAG_THRESHOLD = 8;
const TOOLBAR_ICON_HIT_SLOP = { top: 5, right: 5, bottom: 5, left: 5 };
// Edge-intent activation zones for drag-release snapping — same generous bands
// (and improved sensitivity) as the Notebook toolbar.
const TOOLBAR_SIDE_EDGE_ZONE_RATIO = 0.28;
const TOOLBAR_SIDE_EDGE_ZONE_MIN = 300;
const TOOLBAR_VERT_EDGE_ZONE_RATIO = 0.2;
const TOOLBAR_VERT_EDGE_ZONE_MIN = 150;

const STORAGE_KEY = 'youmi.materialToolbar.v1';

export type MaterialToolMode = 'scroll' | 'pen' | 'highlighter' | 'eraser';

export type MaterialToolbarDock =
  | 'topLeft'
  | 'topCenter'
  | 'topRight'
  | 'leftCenter'
  | 'rightCenter'
  | 'bottomLeft'
  | 'bottomCenter'
  | 'bottomRight';

const TOOL_DOCKS: MaterialToolbarDock[] = [
  'topLeft',
  'topCenter',
  'topRight',
  'leftCenter',
  'rightCenter',
  'bottomLeft',
  'bottomCenter',
  'bottomRight',
];

type Size = { width: number; height: number };
type Point = { x: number; y: number };

type DockPreferences = { dock: MaterialToolbarDock; collapsed: boolean };
const DEFAULT_PREFERENCES: DockPreferences = { dock: 'topRight', collapsed: false };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function dockIsVertical(dock: MaterialToolbarDock): boolean {
  return dock === 'leftCenter' || dock === 'rightCenter';
}

/** Top-left position for a given dock — copied from NotebookCanvas.toolbarDockPoint. */
function dockPoint(dock: MaterialToolbarDock, container: Size, toolbar: Size): Point {
  const left = TOOLBAR_EDGE_MARGIN;
  const right = Math.max(left, container.width - toolbar.width - TOOLBAR_EDGE_MARGIN);
  const top = TOOLBAR_EDGE_MARGIN;
  const bottom = Math.max(top, container.height - toolbar.height - TOOLBAR_EDGE_MARGIN);
  const centerX = clamp((container.width - toolbar.width) / 2, left, right);
  const centerY = clamp((container.height - toolbar.height) / 2, top, bottom);
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

/** Docks that physically fit the container at the current toolbar size. */
function validDocksFor(container: Size, size: Size): MaterialToolbarDock[] {
  const valid = TOOL_DOCKS.filter((dock) => {
    if (dockIsVertical(dock) && size.height > container.height - TOOLBAR_EDGE_MARGIN * 2) {
      return false;
    }
    return true;
  });
  return valid.length > 0 ? valid : TOOL_DOCKS;
}

/**
 * Decide the dock on drag release from the finger position — copied from
 * NotebookCanvas.resolveReleaseDock (minus the caption avoid-rects). Side-edge
 * intent wins over top/bottom corners so dragging the body to the left/right
 * edge reliably becomes a vertical rail.
 */
function resolveReleaseDock(
  container: Size,
  size: Size,
  release: Point,
  currentDock: MaterialToolbarDock,
): MaterialToolbarDock {
  const cw = container.width;
  const ch = container.height;
  if (cw <= 0 || ch <= 0 || size.width <= 0 || size.height <= 0) return currentDock;

  const candidates = validDocksFor(container, size);
  const isValid = (dock: MaterialToolbarDock) => candidates.includes(dock);
  const anchorOf = (dock: MaterialToolbarDock) => dockPoint(dock, container, size);
  const nearestValidTo = (point: Point) =>
    candidates.reduce((nearest, dock) => {
      const np = anchorOf(nearest);
      const dp = anchorOf(dock);
      const nd = Math.hypot(np.x - point.x, np.y - point.y);
      const dd = Math.hypot(dp.x - point.x, dp.y - point.y);
      return dd < nd ? dock : nearest;
    }, candidates[0]);

  const sideZone = Math.max(TOOLBAR_SIDE_EDGE_ZONE_MIN, cw * TOOLBAR_SIDE_EDGE_ZONE_RATIO);
  const vEdgeZone = Math.max(TOOLBAR_VERT_EDGE_ZONE_MIN, ch * TOOLBAR_VERT_EDGE_ZONE_RATIO);
  const nearRight = release.x >= cw - sideZone;
  const nearLeft = release.x <= sideZone;
  const nearTop = release.y <= vEdgeZone;
  const nearBottom = release.y >= ch - vEdgeZone;

  if (nearRight && !nearLeft) {
    return isValid('rightCenter') ? 'rightCenter' : nearestValidTo(anchorOf('rightCenter'));
  }
  if (nearLeft && !nearRight) {
    return isValid('leftCenter') ? 'leftCenter' : nearestValidTo(anchorOf('leftCenter'));
  }

  const band: 'Left' | 'Center' | 'Right' =
    release.x < cw / 3 ? 'Left' : release.x > (cw * 2) / 3 ? 'Right' : 'Center';
  if (nearTop) {
    const cand = `top${band}` as MaterialToolbarDock;
    return isValid(cand) ? cand : nearestValidTo(release);
  }
  if (nearBottom) {
    const cand = `bottom${band}` as MaterialToolbarDock;
    return isValid(cand) ? cand : nearestValidTo(release);
  }
  return nearestValidTo(release);
}

// ---- Glyphs — SVG paths copied verbatim from NotebookCanvas so the icon
// ---- shapes match the approved design exactly (viewBox 0 0 28 28). ----
type GlyphName =
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'undo'
  | 'redo'
  | 'hand'
  | 'chevronUp'
  | 'chevronLeft'
  | 'chevronRight';

function GlyphBase({
  name,
  color = TOOLBAR_ICON_IDLE,
  size = 23,
}: {
  name: GlyphName;
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
      {name === 'hand' ? (
        <Path
          d="M11 13V7.5a1.7 1.7 0 0 1 3.4 0V13m0-1.5a1.7 1.7 0 0 1 3.4 0V14m0-1a1.7 1.7 0 0 1 3.3 0v4.5c0 3.3-2.4 5.8-6 5.8-2.4 0-4-1-5.4-2.8l-3-4a1.7 1.7 0 0 1 2.5-2.2L11 17V13Z"
          stroke={color}
          strokeWidth={1.7}
          strokeLinejoin="round"
          fill="none"
        />
      ) : null}
      {name === 'chevronUp' ? (
        <Path d="M7 17.5l7-7 7 7" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ) : null}
      {name === 'chevronLeft' ? (
        <Path d="M17 7l-6 7 6 7" stroke={color} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ) : null}
      {name === 'chevronRight' ? (
        <Path d="M11 7l6 7-6 7" stroke={color} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ) : null}
    </Svg>
  );
}
const Glyph = memo(GlyphBase);

function glyphForMode(mode: MaterialToolMode): GlyphName {
  return mode === 'pen'
    ? 'pen'
    : mode === 'highlighter'
      ? 'highlighter'
      : mode === 'eraser'
        ? 'eraser'
        : 'hand';
}

/** Vertical navy gradient fill — copied from NotebookCanvas.NavySurface. */
function NavySurfaceBase() {
  const gradientId = useId().replace(/:/g, '_');
  return (
    <View style={styles.navySurfaceLayer} pointerEvents="none">
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFillObject}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={TOOLBAR_NAVY_TOP} />
            <Stop offset="1" stopColor={TOOLBAR_NAVY_BOTTOM} />
          </LinearGradient>
        </Defs>
        <Path d="M0 0h10000v10000H0z" fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  );
}
const NavySurface = memo(NavySurfaceBase);

/** Drag grip — two columns of three dots, copied from NotebookCanvas.GripDots. */
function GripDots() {
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

const PRIMARY_TOOLS: { key: Exclude<MaterialToolMode, 'scroll'>; label: string }[] = [
  { key: 'pen', label: 'Pen' },
  { key: 'highlighter', label: 'Highlight' },
  { key: 'eraser', label: 'Eraser' },
];

export type MaterialColorOption = { key: string; value: string };
/** `dot` is the preview-dot diameter shown inside the nib; `value` is the width/radius. */
export type MaterialSizeOption = { key: string; value: number; dot: number };

export type MaterialFloatingToolbarProps = {
  mode: MaterialToolMode;
  onChangeMode: (next: MaterialToolMode) => void;
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  /** Pen colour palette + current pen colour (shown when Pen is active). */
  penColors: MaterialColorOption[];
  penColor: string;
  /** Highlighter colour palette + current colour (shown when Highlight is active). */
  highlighterColors: MaterialColorOption[];
  highlighterColor: string;
  /** Apply a colour to the active draw tool (Pen or Highlight). */
  onSelectColor: (color: string) => void;
  /** Pen stroke-width presets + current width (shown when Pen is active). */
  penWidths: MaterialSizeOption[];
  penWidth: number;
  /** Highlighter stroke-width presets + current width (shown when Highlight is active). */
  highlighterWidths: MaterialSizeOption[];
  highlighterWidth: number;
  /** Apply a stroke width to the active draw tool (Pen or Highlight). */
  onSelectWidth: (width: number) => void;
  /** Eraser coverage presets + current radius (shown when Eraser is active). */
  eraserSizes: MaterialSizeOption[];
  eraserSize: number;
  /** Apply an eraser coverage radius. */
  onSelectEraserSize: (radius: number) => void;
};

export function MaterialFloatingToolbar({
  mode,
  onChangeMode,
  onUndo,
  canUndo,
  onRedo,
  canRedo,
  penColors,
  penColor,
  highlighterColors,
  highlighterColor,
  onSelectColor,
  penWidths,
  penWidth,
  highlighterWidths,
  highlighterWidth,
  onSelectWidth,
  eraserSizes,
  eraserSize,
  onSelectEraserSize,
}: MaterialFloatingToolbarProps) {
  const [dock, setDock] = useState<MaterialToolbarDock>(DEFAULT_PREFERENCES.dock);
  const [collapsed, setCollapsed] = useState(DEFAULT_PREFERENCES.collapsed);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });
  const [capsuleSize, setCapsuleSize] = useState<Size>({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);

  const vertical = dockIsVertical(dock);
  const onRight = dock === 'rightCenter';

  const rootRef = useRef<View>(null);
  const originRef = useRef<Point>({ x: 0, y: 0 });
  const containerSizeRef = useRef<Size>(containerSize);
  const capsuleSizeRef = useRef<Size>(capsuleSize);
  const dockRef = useRef<MaterialToolbarDock>(dock);

  const position = useRef(new Animated.ValueXY({ x: TOOLBAR_EDGE_MARGIN, y: TOOLBAR_EDGE_MARGIN })).current;
  const positionRef = useRef<Point>({ x: TOOLBAR_EDGE_MARGIN, y: TOOLBAR_EDGE_MARGIN });
  const dragStartRef = useRef<Point>(positionRef.current);
  const touchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const draggingRef = useRef(false);
  const suppressPressUntilRef = useRef(0);
  const dragFingerRef = useRef<Point | null>(null);

  useEffect(() => {
    containerSizeRef.current = containerSize;
  }, [containerSize]);
  useEffect(() => {
    capsuleSizeRef.current = capsuleSize;
  }, [capsuleSize]);
  useEffect(() => {
    dockRef.current = dock;
  }, [dock]);

  // ---- Preferences (dock + collapsed) persist under a dedicated key so they
  // ---- never collide with the Notebook toolbar's preferences. ----
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!active || !raw) return;
        const stored = JSON.parse(raw) as Partial<DockPreferences>;
        if (TOOL_DOCKS.includes(stored.dock as MaterialToolbarDock)) setDock(stored.dock as MaterialToolbarDock);
        if (typeof stored.collapsed === 'boolean') setCollapsed(stored.collapsed);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setPreferencesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ dock, collapsed })).catch(() => {});
  }, [dock, collapsed, preferencesLoaded]);

  const moveToDock = useCallback(
    (nextDock: MaterialToolbarDock, animated: boolean) => {
      const container = containerSizeRef.current;
      const size = capsuleSizeRef.current;
      if (container.width <= 0 || container.height <= 0 || size.width <= 0 || size.height <= 0) return;
      const point = dockPoint(nextDock, container, size);
      positionRef.current = point;
      Animated.timing(position, {
        toValue: point,
        duration: animated ? 150 : 0,
        useNativeDriver: true,
      }).start();
    },
    [position],
  );

  const moveDrag = useCallback(
    (dx: number, dy: number) => {
      const container = containerSizeRef.current;
      const size = capsuleSizeRef.current;
      const maxX = Math.max(TOOLBAR_EDGE_MARGIN, container.width - size.width - TOOLBAR_EDGE_MARGIN);
      const maxY = Math.max(TOOLBAR_EDGE_MARGIN, container.height - size.height - TOOLBAR_EDGE_MARGIN);
      const point = {
        x: clamp(dragStartRef.current.x + dx, TOOLBAR_EDGE_MARGIN, maxX),
        y: clamp(dragStartRef.current.y + dy, TOOLBAR_EDGE_MARGIN, maxY),
      };
      positionRef.current = point;
      position.setValue(point);
    },
    [position],
  );

  const finishDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    suppressPressUntilRef.current = Date.now() + 200;
    const container = containerSizeRef.current;
    const size = capsuleSizeRef.current;
    const release =
      dragFingerRef.current ?? {
        x: positionRef.current.x + size.width / 2,
        y: positionRef.current.y + size.height / 2,
      };
    const next = resolveReleaseDock(container, size, release, dockRef.current);
    dragFingerRef.current = null;
    setDock(next);
    dockRef.current = next;
    moveToDock(next, true);
  }, [moveToDock]);

  const touchHandlers = useMemo(
    () => ({
      onTouchStart: (event: { nativeEvent: { touches: { pageX: number; pageY: number }[] } }) => {
        const touch = event.nativeEvent.touches[0];
        if (!touch) return;
        touchStartRef.current = { pageX: touch.pageX, pageY: touch.pageY };
        dragStartRef.current = { ...positionRef.current };
        draggingRef.current = false;
        dragFingerRef.current = {
          x: touch.pageX - originRef.current.x,
          y: touch.pageY - originRef.current.y,
        };
      },
      onTouchMove: (event: { nativeEvent: { touches: { pageX: number; pageY: number }[] } }) => {
        const touch = event.nativeEvent.touches[0];
        const start = touchStartRef.current;
        if (!touch || !start) return;
        dragFingerRef.current = {
          x: touch.pageX - originRef.current.x,
          y: touch.pageY - originRef.current.y,
        };
        const dx = touch.pageX - start.pageX;
        const dy = touch.pageY - start.pageY;
        if (!draggingRef.current) {
          if (Math.hypot(dx, dy) <= TOOLBAR_DRAG_THRESHOLD) return;
          draggingRef.current = true;
          suppressPressUntilRef.current = Date.now() + 200;
        }
        moveDrag(dx, dy);
      },
      onTouchEnd: () => {
        touchStartRef.current = null;
        finishDrag();
      },
      onTouchCancel: () => {
        touchStartRef.current = null;
        finishDrag();
      },
    }),
    [finishDrag, moveDrag],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.hypot(gesture.dx, gesture.dy) > TOOLBAR_DRAG_THRESHOLD,
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          Math.hypot(gesture.dx, gesture.dy) > TOOLBAR_DRAG_THRESHOLD,
        onPanResponderGrant: (event) => {
          draggingRef.current = true;
          suppressPressUntilRef.current = Date.now() + 200;
          dragStartRef.current = { ...positionRef.current };
          dragFingerRef.current = {
            x: event.nativeEvent.pageX - originRef.current.x,
            y: event.nativeEvent.pageY - originRef.current.y,
          };
        },
        onPanResponderMove: (event, gesture) => {
          if (!draggingRef.current) return;
          dragFingerRef.current = {
            x: event.nativeEvent.pageX - originRef.current.x,
            y: event.nativeEvent.pageY - originRef.current.y,
          };
          moveDrag(gesture.dx, gesture.dy);
        },
        onPanResponderRelease: finishDrag,
        onPanResponderTerminate: finishDrag,
        onPanResponderTerminationRequest: () => false,
      }),
    [finishDrag, moveDrag],
  );

  const dragHandlers = useMemo(
    () => ({ ...panResponder.panHandlers, ...touchHandlers }),
    [panResponder, touchHandlers],
  );

  const runPress = useCallback((action: () => void) => {
    if (draggingRef.current || Date.now() < suppressPressUntilRef.current) return;
    action();
  }, []);

  // Re-clamp to the current dock whenever the container or capsule size changes
  // (orientation flip, rotation). Keeps the toolbar glued to its edge.
  useEffect(() => {
    if (containerSize.width <= 0 || capsuleSize.width <= 0) return;
    const candidates = validDocksFor(containerSize, capsuleSize);
    const nextDock = candidates.includes(dock)
      ? dock
      : resolveReleaseDock(containerSize, capsuleSize, dockPoint(dock, containerSize, capsuleSize), dock);
    if (nextDock !== dock) {
      setDock(nextDock);
      return;
    }
    moveToDock(nextDock, ready);
    if (!ready) setReady(true);
  }, [containerSize, capsuleSize, dock, moveToDock, ready]);

  const onRootLayout = useCallback(() => {
    rootRef.current?.measureInWindow((x, y, w, h) => {
      originRef.current = { x, y };
      if (w > 0 && h > 0) {
        setContainerSize((current) =>
          current.width === w && current.height === h ? current : { width: w, height: h },
        );
      }
    });
  }, []);

  const onCapsuleLayout = useCallback((event: { nativeEvent: { layout: { width: number; height: number } } }) => {
    const { width: w, height: h } = event.nativeEvent.layout;
    if (w <= 0 || h <= 0) return;
    setCapsuleSize((current) =>
      Math.abs(current.width - w) < 0.5 && Math.abs(current.height - h) < 0.5
        ? current
        : { width: w, height: h },
    );
  }, []);

  // ---- Render helpers ----
  // Active-tool indicator: a soft background chip when docked vertically (matches
  // the Notebook's vertical rail) and a short underline when horizontal (matches
  // the Notebook's horizontal strip). Rendered behind the glyph for the chip.
  const renderActiveChip = () => <View style={styles.activeChip} pointerEvents="none" />;
  const renderUnderline = () => <View style={styles.toolUnderline} pointerEvents="none" />;

  const renderToolButton = (tool: { key: Exclude<MaterialToolMode, 'scroll'>; label: string }) => {
    const active = mode === tool.key;
    return (
      <Pressable
        key={tool.key}
        accessibilityRole="button"
        accessibilityLabel={`${tool.label} tool`}
        accessibilityState={{ selected: active }}
        onPress={() => runPress(() => onChangeMode(tool.key))}
        hitSlop={TOOLBAR_ICON_HIT_SLOP}
        {...dragHandlers}
        style={({ pressed }) => [styles.toolButton, pressed && styles.pressed]}
      >
        {active && vertical ? renderActiveChip() : null}
        <Glyph name={tool.key} color={active ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE} size={25} />
        {active && !vertical ? renderUnderline() : null}
      </Pressable>
    );
  };

  const handActive = mode === 'scroll';
  const renderHand = () => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Hand — scroll the page"
      accessibilityState={{ selected: handActive }}
      onPress={() => runPress(() => onChangeMode(handActive ? 'pen' : 'scroll'))}
      hitSlop={TOOLBAR_ICON_HIT_SLOP}
      {...dragHandlers}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
    >
      {handActive && vertical ? renderActiveChip() : null}
      <Glyph name="hand" color={handActive ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE} />
      {handActive && !vertical ? renderUnderline() : null}
    </Pressable>
  );

  const renderHistoryButton = (name: 'undo' | 'redo', enabled: boolean, action: () => void, label: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={!enabled}
      onPress={() => runPress(action)}
      hitSlop={TOOLBAR_ICON_HIT_SLOP}
      {...dragHandlers}
      style={({ pressed }) => [styles.iconButton, pressed && enabled && styles.pressed]}
    >
      <Glyph name={name} color={enabled ? TOOLBAR_ICON_IDLE : TOOLBAR_ICON_DISABLED} />
    </Pressable>
  );

  const renderMinimize = () => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Minimize tools"
      onPress={() => runPress(() => setCollapsed(true))}
      hitSlop={TOOLBAR_ICON_HIT_SLOP}
      {...dragHandlers}
      style={({ pressed }) => [
        styles.collapseButton,
        vertical && styles.collapseButtonVertical,
        pressed && styles.pressed,
      ]}
    >
      <Glyph name={vertical ? (onRight ? 'chevronLeft' : 'chevronRight') : 'chevronUp'} color="rgba(255,255,255,0.6)" size={18} />
    </Pressable>
  );

  // Tool context — appears only for a draw/erase tool. Integrated INTO the toolbar
  // like the Notebook: a side column beside the rail when docked vertically, or a
  // compact row beneath the strip when horizontal, inside the same navy pill (not a
  // tail). Pen/Highlight show [colour swatches | divider | width nibs]; Eraser shows
  // [size nibs] only.
  const drawColorMode = mode === 'pen' || mode === 'highlighter';
  const eraserContextMode = mode === 'eraser';
  const hasContext = drawColorMode || eraserContextMode;

  const colorPalette = mode === 'highlighter' ? highlighterColors : penColors;
  const activeColor = mode === 'highlighter' ? highlighterColor : penColor;
  const colorSwatches = colorPalette.map((option) => {
    const isActive = activeColor.toLowerCase() === option.value.toLowerCase();
    return (
      <Pressable
        key={option.key}
        accessibilityRole="button"
        accessibilityLabel={`${mode === 'highlighter' ? 'Highlight' : 'Pen'} colour ${option.key}`}
        accessibilityState={{ selected: isActive }}
        onPress={() => runPress(() => onSelectColor(option.value))}
        hitSlop={TOOLBAR_ICON_HIT_SLOP}
        style={({ pressed }) => [styles.swatch, pressed && styles.pressed]}
      >
        <View style={[StyleSheet.absoluteFill, styles.swatchFill, { backgroundColor: option.value }]} />
        {isActive ? <View style={styles.swatchRing} /> : null}
      </Pressable>
    );
  });

  // Width / eraser-size nibs: a circle that gains a blue ring when selected, with a
  // white preview dot sized to represent the stroke width / eraser coverage.
  const widthOptions = mode === 'highlighter' ? highlighterWidths : penWidths;
  const activeWidth = mode === 'highlighter' ? highlighterWidth : penWidth;
  const renderNib = (
    key: string,
    label: string,
    dot: number,
    active: boolean,
    onPress: () => void,
  ) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={() => runPress(onPress)}
      hitSlop={TOOLBAR_ICON_HIT_SLOP}
      style={({ pressed }) => [styles.nib, active && styles.nibActive, pressed && styles.pressed]}
    >
      <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: 'rgba(255,255,255,0.92)' }} />
    </Pressable>
  );
  const widthNibs = widthOptions.map((option) =>
    renderNib(
      option.key,
      `${mode === 'highlighter' ? 'Highlight' : 'Pen'} width ${option.key}`,
      option.dot,
      activeWidth === option.value,
      () => onSelectWidth(option.value),
    ),
  );
  const eraserNibs = eraserSizes.map((option) =>
    renderNib(
      option.key,
      `${option.key} eraser`,
      option.dot,
      eraserSize === option.value,
      () => onSelectEraserSize(option.value),
    ),
  );

  // Context body: grouped colour + width (draw tools) or size only (eraser).
  const contextBody = drawColorMode ? (
    <>
      <View style={vertical ? styles.groupColumn : styles.groupRow}>{colorSwatches}</View>
      <View style={vertical ? styles.groupDividerH : styles.groupDividerV} />
      <View style={vertical ? styles.groupColumn : styles.groupRow}>{widthNibs}</View>
    </>
  ) : (
    <View style={vertical ? styles.groupColumn : styles.groupRow}>{eraserNibs}</View>
  );

  const colorContext = hasContext ? (
    vertical ? (
      <>
        <View style={styles.colColumnDivider} />
        <View style={styles.colContextColumn}>{contextBody}</View>
      </>
    ) : (
      <>
        <View style={styles.colRowDivider} />
        <View style={styles.colContextRow}>{contextBody}</View>
      </>
    )
  ) : null;

  const mainStrip = (
    <View style={vertical ? styles.rail : styles.row}>
      <View
        accessibilityLabel="Move material tools"
        accessibilityRole="adjustable"
        style={[styles.dragHandle, vertical && styles.dragHandleVertical]}
        {...dragHandlers}
      >
        <GripDots />
      </View>
      <View style={[styles.tools, vertical && styles.toolsVertical]}>
        {PRIMARY_TOOLS.map(renderToolButton)}
      </View>
      <View style={[styles.divider, vertical && styles.dividerVertical]} />
      {renderHand()}
      <View style={[styles.divider, vertical && styles.dividerVertical]} />
      {renderHistoryButton('undo', canUndo, onUndo, 'Undo last annotation stroke')}
      {renderHistoryButton('redo', canRedo, onRedo, 'Redo annotation stroke')}
      {renderMinimize()}
    </View>
  );

  // Vertical: rail + side colour column (colours face inward — to the left when the
  // rail is docked on the right edge). Horizontal: main row + colour row beneath.
  const expandedCapsule = (
    <View
      style={
        vertical
          ? [styles.expandedVertical, onRight && styles.expandedVerticalRight]
          : styles.expandedHorizontal
      }
    >
      {mainStrip}
      {colorContext}
    </View>
  );

  const collapsedCapsule = (
    <View style={[styles.collapsedContent, vertical && styles.collapsedContentVertical]}>
      <View accessibilityLabel="Move material tools" accessibilityRole="adjustable" style={styles.collapsedGrip} {...dragHandlers}>
        <GripDots />
      </View>
      <View style={styles.collapsedCur}>
        <Glyph name={glyphForMode(mode)} color={colors.pearlWhite} size={24} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Expand tools"
        onPress={() => runPress(() => setCollapsed(false))}
        hitSlop={TOOLBAR_ICON_HIT_SLOP}
        {...dragHandlers}
        style={({ pressed }) => [styles.collapsedExpand, pressed && styles.pressed]}
      >
        <Glyph name={vertical ? (onRight ? 'chevronRight' : 'chevronLeft') : 'chevronUp'} color="rgba(255,255,255,0.6)" size={18} />
      </Pressable>
    </View>
  );

  return (
    <View
      ref={rootRef}
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
      onLayout={onRootLayout}
      collapsable={false}
    >
      <Animated.View
        pointerEvents="box-none"
        style={[styles.floating, { opacity: ready ? 1 : 0, transform: position.getTranslateTransform() }]}
      >
        <View
          onLayout={onCapsuleLayout}
          {...dragHandlers}
          style={[styles.surface, { borderRadius: collapsed ? TOOLBAR_MINIMIZED_RADIUS : TOOLBAR_SHELL_RADIUS }]}
        >
          <NavySurface />
          {collapsed ? collapsedCapsule : expandedCapsule}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  floating: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 20,
  },
  surface: {
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
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  rail: {
    width: 56,
    flexDirection: 'column',
    alignItems: 'center',
    paddingVertical: 2,
  },
  dragHandle: {
    width: 22,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: 'rgba(255,255,255,0.08)',
  },
  dragHandleVertical: {
    width: '100%',
    height: 22,
    alignSelf: 'auto',
    borderRightWidth: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
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
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
  },
  toolsVertical: {
    flexDirection: 'column',
    paddingHorizontal: 0,
    paddingVertical: 4,
    gap: 2,
  },
  toolButton: {
    width: 48,
    height: 46,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
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
  // Soft selected chip behind the active tool icon when docked vertically —
  // matches the Notebook's vertical rail (cleaner than a side bar).
  activeChip: {
    position: 'absolute',
    top: 3,
    left: 6,
    right: 6,
    bottom: 3,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    backgroundColor: 'rgba(95,134,232,0.14)',
  },
  collapseButton: {
    width: 34,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255,255,255,0.08)',
  },
  collapseButtonVertical: {
    width: '100%',
    height: 44,
    alignSelf: 'auto',
    borderLeftWidth: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  divider: {
    width: 1,
    height: 30,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
    marginHorizontal: 6,
  },
  dividerVertical: {
    width: 30,
    height: 1,
    marginHorizontal: 0,
    marginVertical: 6,
  },
  collapsedContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    gap: 4,
    height: 60,
  },
  collapsedContentVertical: {
    flexDirection: 'column',
    paddingHorizontal: 0,
    paddingVertical: 9,
    height: undefined,
    width: 56,
  },
  collapsedGrip: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingRight: 3,
  },
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
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.92 }],
  },
  // Expanded capsule wrappers. Horizontal: main row + colour row stacked (column).
  // Vertical: rail + colour column side by side (row), colours facing inward via
  // row-reverse when the rail is docked on the right edge.
  expandedHorizontal: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  expandedVertical: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  expandedVerticalRight: {
    flexDirection: 'row-reverse',
  },
  // Colour row beneath the horizontal strip.
  colRowDivider: {
    alignSelf: 'stretch',
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 12,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
  },
  colContextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 5,
    paddingBottom: 8,
  },
  // Colour column beside the vertical rail (full-height hairline between them).
  colColumnDivider: {
    width: StyleSheet.hairlineWidth,
    marginVertical: 14,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
  },
  colContextColumn: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  swatch: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchFill: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  swatchRing: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderRadius: 16,
    borderWidth: 2.5,
    borderColor: TOOLBAR_SELECTED,
  },
  // Grouping inside the context (colour group, divider, width group). Row for the
  // horizontal context; column for the vertical context.
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  groupColumn: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  groupDividerV: {
    width: StyleSheet.hairlineWidth,
    height: 30,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
  },
  groupDividerH: {
    height: StyleSheet.hairlineWidth,
    width: 30,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
  },
  // Width / eraser-size nib — circle with a blue ring when selected (matches the
  // Notebook nib visual language), holding a white preview dot.
  nib: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  nibActive: {
    borderColor: TOOLBAR_SELECTED,
  },
});
