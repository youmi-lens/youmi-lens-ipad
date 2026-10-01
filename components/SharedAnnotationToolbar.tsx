/**
 * PK4-C1 — SharedAnnotationToolbar: the ONE authoritative toolbar/tray
 * component for both Notebook and Course Material.
 *
 * This supersedes the PK4-B1/PK4-C "render-prop sequencer" version of this
 * file: sharing tool IDs/presets/capabilities/glyphs/chrome tokens while
 * each workspace kept its own JSX layout tree was ruled insufficient on
 * physical inspection (the two toolbars still looked and behaved like
 * different products). This version owns the actual common UI/layout
 * implementation — promoted verbatim from NotebookCanvas.tsx's own
 * physically-accepted toolbar (both the horizontal layout and the vertical
 * "Concept C" split-capsule layout, its drag/dock/collapse state machine,
 * AsyncStorage-persisted preferences, and the fixed top-right Undo/Redo
 * control) — mechanically parameterized so Course Material can render the
 * exact same component instead of a second, independent implementation.
 *
 * It is self-contained: it measures its own root view (the same pattern
 * Course Material's retired MaterialFloatingToolbar already used
 * successfully), rather than depending on a host's own container
 * measurement — so it drops into either workspace's screen unchanged.
 *
 * It does NOT know about NoteStroke, PKDrawing, PDF annotations, PDFView,
 * or either workspace's document/history internals. Tool selection,
 * presets, and undo/redo are all callbacks/values the host supplies.
 * Workspace-specific contextual UI that is NOT part of the common
 * tray — the Clear Page/Delete Selected action, Select-shape (lasso/rect)
 * and Insert-photo context bodies — are injected via `extraAction` /
 * `renderExtraContext`. Both workspaces share the selection-shape context
 * component; hosts own selected objects and actions.
 */
import { useT } from '@/lib/i18n';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Animated,
  Easing,
  LayoutAnimation,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg from 'react-native-svg';

import { PressableScale } from '@/components/PressableScale';
import { NavySurface, SharedToolbarGlyphPaths, ToolbarGripDots, type SharedToolbarGlyphName } from '@/components/SharedToolbarChrome';
import { colors } from '@/constants/theme';
import type { AnnotationTool } from '@/lib/annotationTools';
import {
  TOOLBAR_NAVY_BOTTOM,
  TOOLBAR_BORDER_COLOR,
  TOOLBAR_SELECTED,
  TOOLBAR_ICON_IDLE,
  TOOLBAR_ICON_DISABLED,
  TOOLBAR_DIVIDER_COLOR,
  TOOLBAR_SHELL_RADIUS,
  TOOLBAR_MINIMIZED_RADIUS,
  TOOLBAR_CHIP_RADIUS,
  TOOLBAR_EDGE_MARGIN,
  TOOLBAR_DRAG_THRESHOLD,
  TOOLBAR_ICON_HIT_SLOP,
  TOOLBAR_SIDE_EDGE_ZONE_RATIO,
  TOOLBAR_SIDE_EDGE_ZONE_MIN,
  TOOLBAR_VERT_EDGE_ZONE_RATIO,
  TOOLBAR_VERT_EDGE_ZONE_MIN,
  dockAnchorPoint,
  dockIsVertical,
  toolbarClamp,
  type SharedToolbarDock,
} from '@/lib/sharedToolbarChrome';

// ---- Layout constants — verbatim from NotebookCanvas.tsx's own toolbar ----
const TOOLBAR_COLLISION_GAP = 14;
const NARROW_TOOLBAR_WIDTH = 720;
const TOOLBAR_COLLAPSED_WIDTH = 126;
const TOOLBAR_COLLAPSED_HEIGHT = 60;
const TOOLBAR_PRIMARY_HEIGHT = 52;
const TOOLBAR_CONTEXT_HEIGHT = 44;
const TOOLBAR_ANIMATION_MS = 190;
const TOOLBAR_EASING = Easing.bezier(0.4, 0, 0.2, 1);
/** All three of Notebook's historical TOOLBAR_WIDTHS values were 536 — never
 * actually mode-dependent — so this generalizes to one constant. */
const TOOLBAR_EXPANDED_WIDTH = 536;
const TOOLBAR_VERTICAL_RAIL_WIDTH = 60;
const TOOLBAR_VERTICAL_CONTEXT_WIDTH = 360;
const TOOLBAR_VERTICAL_ACTION_WIDTH = 60;
const TOOLBAR_VERTICAL_BUTTON_GAP = 2;
const TOOLBAR_RIGHT_PILL_GAP = 12;
const TOOLBAR_HISTORY_PILL_WIDTH = 64;
const TOOLBAR_VERTICAL_TOOL_COL_WIDTH = 52;
const TOOLBAR_VERTICAL_CONTEXT_NARROW = 56;
const TOOLBAR_VERTICAL_CONTEXT_WIDE = 76;
const TOOLBAR_VERTICAL_COL_DIVIDER = 1;
const TOOLBAR_VERTICAL_CAPSULE_HEIGHT = 400;
const TOOLBAR_VERTICAL_GROUP_GAP = 12;
const TOOLBAR_VERTICAL_ACTION_HEIGHT = 60;
const TOOLBAR_MINI_CAPSULE_WIDTH = 56;
const TOOLBAR_MINI_CAPSULE_HEIGHT = 132;

/** SharedToolbarGlyphPaths only emits <Path> children; react-native-svg draws
 * nothing for them without an <Svg> ancestor, so every toolbar glyph must go
 * through this wrapper (viewBox 0 0 28 28, same as Notebook's original). */
function ToolbarSvgGlyph({ name, color, size = 23 }: { name: SharedToolbarGlyphName; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28" accessibilityElementsHidden>
      <SharedToolbarGlyphPaths name={name} color={color} />
    </Svg>
  );
}

const TOOL_DOCKS: SharedToolbarDock[] = [
  'topLeft', 'topCenter', 'topRight',
  'leftCenter', 'rightCenter',
  'bottomLeft', 'bottomCenter', 'bottomRight',
];

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Rect = Size & Point;

function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

export type ColorOption = { key: string; value: string; previewColor?: string };
export type SizeOption = { key: string; value: number; dot: number };

export type SharedToolbarPreferences = {
  collapsed: boolean;
  dock: SharedToolbarDock;
};

export type SharedAnnotationToolbarProps = {
  editable: boolean;
  /** AsyncStorage key for persisted dock/collapsed preferences — must be
   * distinct per workspace so Notebook's and Course Material's toolbars
   * don't clobber each other's saved position. */
  storageKey: string;
  /** Rects (in this component's own measured container coordinates) the
   * toolbar must never dock/land on top of, e.g. Notebook's caption/
   * recording overlay. Course Material has none today. */
  avoidRects?: Rect[];

  /** Capability-filtered, ordered shared tool ids — from the host's own
   * adapter (lib/notebookAnnotationAdapter.ts / lib/
   * courseMaterialAnnotationAdapter.ts). Never re-derived here. */
  tools: AnnotationTool[];
  activeTool: AnnotationTool;
  onSelectTool: (tool: AnnotationTool) => void;
  /** Renders one tool's icon. Shared tools (pen/highlighter/eraser/text/
   * scroll) can delegate to SharedToolbarGlyphPaths; workspace-only tools
   * (Notebook's select/insert) render their own local glyph. */
  renderToolIcon: (tool: AnnotationTool, active: boolean, color: string, size: number) => ReactNode;

  penColors: ColorOption[];
  penColor: string;
  onSelectPenColor: (value: string) => void;
  penWidths: SizeOption[];
  penWidth: number;
  onSelectPenWidth: (value: number) => void;

  highlighterColors: ColorOption[];
  highlighterColor: string;
  onSelectHighlighterColor: (value: string) => void;
  highlighterWidths: SizeOption[];
  highlighterWidth: number;
  onSelectHighlighterWidth: (value: number) => void;

  eraserSizes: SizeOption[];
  eraserSize: number;
  onSelectEraserSize: (value: number) => void;

  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  /** Independent gate for the fixed Undo/Redo capsule specifically (the main
   * draggable tray still shows whenever `editable`). Defaults to true.
   * Notebook preserves its existing optional `showFixedHistory` prop by
   * passing it straight through here. */
  showFixedHistory?: boolean;
  /** Position of the fixed (non-draggable) Undo/Redo capsule. Defaults to
   * Notebook's own accepted values (top:12, right:12); Course Material
   * supplies its own to clear its safe-area inset and export button. */
  fixedHistoryPosition?: { top: number; right: number };

  /** Clear Page / Delete Selected action in the same rightPill/action-capsule
   * slot. Hosts supply their own page and selection semantics. */
  extraAction?: {
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    icon: ReactNode;
  };
  /** Extra per-tool context body (selection-shape picker, Notebook's
   * insert-photo row) that isn't one of the built-in contexts. `dragHandlerProps`
   * is always supplied; the caller spreads it on whichever buttons its own
   * original JSX did (Notebook's select-shape buttons in both orientations,
   * its insert-photo button only in the horizontal one — an asymmetry that
   * already existed before this extraction, preserved here rather than
   * normalized). */
  renderExtraContext?: (
    tool: AnnotationTool,
    orientation: 'horizontal' | 'vertical',
    helpers: { runPress: (action: () => void) => void; dragHandlerProps: Record<string, unknown> },
  ) => ReactNode | null;

  moveAccessibilityLabel: string;
  expandAccessibilityLabel: string;
  minimizeAccessibilityLabel: string;
  handAccessibilityLabel: string;
};

type ToolbarPreferences = { collapsed: boolean; dock: SharedToolbarDock };
const DEFAULT_PREFERENCES: ToolbarPreferences = { collapsed: false, dock: 'topCenter' };
const DEFAULT_FIXED_HISTORY_POSITION = { top: 12, right: 12 };

function SharedAnnotationToolbarBase(props: SharedAnnotationToolbarProps) {
  const {
    editable,
    storageKey,
    avoidRects = [],
    tools,
    activeTool,
    onSelectTool,
    renderToolIcon,
    penColors, penColor, onSelectPenColor,
    penWidths, penWidth, onSelectPenWidth,
    highlighterColors, highlighterColor, onSelectHighlighterColor,
    highlighterWidths, highlighterWidth, onSelectHighlighterWidth,
    eraserSizes, eraserSize, onSelectEraserSize,
    onUndo, canUndo, onRedo, canRedo,
    showFixedHistory = true,
    fixedHistoryPosition = DEFAULT_FIXED_HISTORY_POSITION,
    extraAction,
    renderExtraContext,
    moveAccessibilityLabel,
    expandAccessibilityLabel,
    minimizeAccessibilityLabel,
    handAccessibilityLabel,
  } = props;

  const t = useT();
  const [toolbarCollapsed, setToolbarCollapsed] = useState(DEFAULT_PREFERENCES.collapsed);
  const toolbarCollapsedRef = useRef(DEFAULT_PREFERENCES.collapsed);
  const [toolbarDock, setToolbarDock] = useState<SharedToolbarDock>(DEFAULT_PREFERENCES.dock);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });
  const [toolbarSize, setToolbarSize] = useState<Size>({ width: 0, height: 0 });
  const [toolbarPreferencesLoaded, setToolbarPreferencesLoaded] = useState(false);
  const [ready, setReady] = useState(false);

  const rootRef = useRef<View>(null);
  const containerOriginRef = useRef<Point>({ x: 0, y: 0 });
  const avoidRectsRef = useRef(avoidRects);
  avoidRectsRef.current = avoidRects;
  const containerSizeRef = useRef(containerSize);
  containerSizeRef.current = containerSize;

  const toolbarPosition = useRef(new Animated.ValueXY({ x: TOOLBAR_EDGE_MARGIN, y: TOOLBAR_EDGE_MARGIN })).current;
  const toolbarPositionRef = useRef<Point>({ x: TOOLBAR_EDGE_MARGIN, y: TOOLBAR_EDGE_MARGIN });
  const toolbarTransition = useRef(new Animated.Value(DEFAULT_PREFERENCES.collapsed ? 0 : 1)).current;
  const toolbarDragStartRef = useRef<Point>(toolbarPositionRef.current);
  const toolbarTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const toolbarDraggingRef = useRef(false);
  const toolbarContextScrollActiveRef = useRef(false);
  const toolbarSuppressPressUntilRef = useRef(0);
  const toolbarDragFingerRef = useRef<Point | null>(null);

  const transitionToolbarCollapsed = useCallback((nextCollapsed: boolean) => {
    if (toolbarCollapsedRef.current === nextCollapsed) return;
    toolbarCollapsedRef.current = nextCollapsed;
    LayoutAnimation.configureNext({
      duration: TOOLBAR_ANIMATION_MS,
      update: { type: LayoutAnimation.Types.easeInEaseOut },
    });
    setToolbarCollapsed(nextCollapsed);
  }, []);

  const effectiveToolbarCollapsed =
    toolbarCollapsed || (containerSize.width > 0 && containerSize.width < NARROW_TOOLBAR_WIDTH);
  const toolbarHasContext = !effectiveToolbarCollapsed && activeTool !== 'scroll' && activeTool !== 'text';
  const toolbarVertical = dockIsVertical(toolbarDock);
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
  // Context row swaps fade rather than cut, per the toolbar motion spec —
  // verbatim from Notebook's own prior effect. MUST use the native driver:
  // contextFade is combined with toolbarTransition (also native-driven) via
  // Animated.multiply for the context panel's opacity, so the shared opacity
  // node lives on the native side (mixing drivers here previously crashed
  // with "Attempting to run JS driven animation on animated node that has
  // been moved to native earlier").
  useEffect(() => {
    contextFade.setValue(0);
    Animated.timing(contextFade, {
      toValue: 1,
      duration: TOOLBAR_ANIMATION_MS,
      easing: TOOLBAR_EASING,
      useNativeDriver: true,
    }).start();
  }, [activeTool, contextFade]);
  const expandedToolbarWidth = TOOLBAR_EXPANDED_WIDTH;
  const expandedToolbarHeight = TOOLBAR_PRIMARY_HEIGHT + (toolbarHasContext ? TOOLBAR_CONTEXT_HEIGHT : 0);
  const verticalRailHeight =
    22 + tools.length * 48 + 44 + 44 + TOOLBAR_VERTICAL_BUTTON_GAP * (tools.length + 1) + 2;
  const toolbarVisualSize = useMemo(() => {
    if (effectiveToolbarCollapsed) return collapsedToolbarSize;
    if (toolbarVertical) {
      return { width: TOOLBAR_VERTICAL_RAIL_WIDTH + toolbarContextWidth, height: verticalRailHeight };
    }
    return {
      width: Math.min(expandedToolbarWidth, Math.max(TOOLBAR_COLLAPSED_WIDTH, containerSize.width - TOOLBAR_EDGE_MARGIN * 2)),
      height: expandedToolbarHeight,
    };
  }, [containerSize.width, effectiveToolbarCollapsed, expandedToolbarHeight, expandedToolbarWidth, toolbarContextWidth, toolbarVertical, verticalRailHeight, collapsedToolbarSize]);

  const getToolbarFootprintForDock = useCallback(
    (dock: SharedToolbarDock): Size => {
      const dockVertical = dockIsVertical(dock);
      if (effectiveToolbarCollapsed) {
        return dockVertical
          ? { width: TOOLBAR_MINI_CAPSULE_WIDTH, height: TOOLBAR_MINI_CAPSULE_HEIGHT }
          : { width: TOOLBAR_COLLAPSED_WIDTH, height: TOOLBAR_COLLAPSED_HEIGHT };
      }
      if (dockVertical) {
        const hasContext = activeTool !== 'scroll' && activeTool !== 'text';
        const contextWidth = activeTool === 'insert' ? TOOLBAR_VERTICAL_CONTEXT_WIDE : TOOLBAR_VERTICAL_CONTEXT_NARROW;
        return {
          width: TOOLBAR_VERTICAL_TOOL_COL_WIDTH + (hasContext ? TOOLBAR_VERTICAL_COL_DIVIDER + contextWidth : 0),
          height: TOOLBAR_VERTICAL_CAPSULE_HEIGHT + TOOLBAR_VERTICAL_GROUP_GAP + TOOLBAR_VERTICAL_ACTION_HEIGHT,
        };
      }
      const rightPillWidth = TOOLBAR_HISTORY_PILL_WIDTH;
      const extraWidth = extraAction ? TOOLBAR_RIGHT_PILL_GAP + rightPillWidth : 0;
      return {
        width:
          Math.min(expandedToolbarWidth, Math.max(TOOLBAR_COLLAPSED_WIDTH, containerSize.width - TOOLBAR_EDGE_MARGIN * 2)) +
          extraWidth,
        height: expandedToolbarHeight,
      };
    },
    [activeTool, containerSize.width, effectiveToolbarCollapsed, expandedToolbarHeight, expandedToolbarWidth, extraAction],
  );
  const toolbarFrameSize = useMemo(() => getToolbarFootprintForDock(toolbarDock), [getToolbarFootprintForDock, toolbarDock]);

  useEffect(() => {
    const footprint = getToolbarFootprintForDock(toolbarDock);
    setToolbarSize((current) => (current.width === footprint.width && current.height === footprint.height ? current : footprint));
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

  const expandedContentOpacity = toolbarTransition.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0, 1] });
  const collapsedContentOpacity = toolbarTransition.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.18, 0] });
  const toolbarScale = toolbarTransition.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] });

  const chooseToolbarDock = useCallback(
    (sourcePoint: Point, preferredDock: SharedToolbarDock = toolbarDock, preferCurrent = true): SharedToolbarDock => {
      if (containerSize.width <= 0 || containerSize.height <= 0 || toolbarSize.width <= 0 || toolbarSize.height <= 0) {
        return preferredDock;
      }
      const validDocks = TOOL_DOCKS.filter((dock) => {
        const footprint = getToolbarFootprintForDock(dock);
        if (dockIsVertical(dock) && footprint.height > containerSize.height - TOOLBAR_EDGE_MARGIN * 2) return false;
        const point = dockAnchorPoint(dock, containerSize, footprint);
        const rect: Rect = { ...point, ...footprint };
        return !avoidRectsRef.current.some((avoidRect) => rectsOverlap(rect, avoidRect, TOOLBAR_COLLISION_GAP));
      });
      const candidates = validDocks.length > 0 ? validDocks : TOOL_DOCKS;
      if (preferCurrent && validDocks.includes(preferredDock)) return preferredDock;
      return candidates.reduce((nearest, dock) => {
        const np = dockAnchorPoint(nearest, containerSize, getToolbarFootprintForDock(nearest));
        const dp = dockAnchorPoint(dock, containerSize, getToolbarFootprintForDock(dock));
        const nd = Math.hypot(np.x - sourcePoint.x, np.y - sourcePoint.y);
        const dd = Math.hypot(dp.x - sourcePoint.x, dp.y - sourcePoint.y);
        return dd < nd ? dock : nearest;
      }, candidates[0]);
    },
    [containerSize, getToolbarFootprintForDock, toolbarDock, toolbarSize],
  );

  const moveToolbarToDock = useCallback(
    (dock: SharedToolbarDock, animated: boolean) => {
      if (containerSize.width <= 0 || containerSize.height <= 0 || toolbarSize.width <= 0 || toolbarSize.height <= 0) return;
      const footprint = getToolbarFootprintForDock(dock);
      const point = dockAnchorPoint(dock, containerSize, footprint);
      toolbarPositionRef.current = point;
      Animated.timing(toolbarPosition, { toValue: point, duration: animated ? 150 : 0, useNativeDriver: true }).start();
    },
    [containerSize, getToolbarFootprintForDock, toolbarPosition, toolbarSize],
  );

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (!active || !raw) return;
        const stored = JSON.parse(raw) as Partial<ToolbarPreferences>;
        if (typeof stored.collapsed === 'boolean') {
          toolbarCollapsedRef.current = stored.collapsed;
          setToolbarCollapsed(stored.collapsed);
        }
        if (TOOL_DOCKS.includes(stored.dock as SharedToolbarDock)) {
          setToolbarDock(stored.dock as SharedToolbarDock);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setToolbarPreferencesLoaded(true);
      });
    return () => {
      active = false;
    };
    // storageKey is set once per mounted toolbar instance (per workspace).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toolbarPreferencesLoaded) return;
    const preferences: ToolbarPreferences = { collapsed: toolbarCollapsed, dock: toolbarDock };
    AsyncStorage.setItem(storageKey, JSON.stringify(preferences)).catch(() => {});
  }, [storageKey, toolbarCollapsed, toolbarDock, toolbarPreferencesLoaded]);

  const avoidRectsSignature = JSON.stringify(avoidRects);
  useEffect(() => {
    if (containerSize.width <= 0 || containerSize.height <= 0 || toolbarSize.width <= 0 || toolbarSize.height <= 0) return;
    const preferredPoint = dockAnchorPoint(toolbarDock, containerSize, toolbarSize);
    const nextDock = chooseToolbarDock(preferredPoint, toolbarDock);
    if (nextDock !== toolbarDock) setToolbarDock(nextDock);
    moveToolbarToDock(nextDock, ready);
    if (!ready) setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avoidRectsSignature, chooseToolbarDock, containerSize, effectiveToolbarCollapsed, moveToolbarToDock, toolbarDock, toolbarSize]);

  const moveToolbarDrag = useCallback(
    (dx: number, dy: number) => {
      const dragBoundsFootprint = TOOL_DOCKS.reduce(
        (smallest, dock) => {
          const footprint = getToolbarFootprintForDock(dock);
          return { width: Math.min(smallest.width, footprint.width), height: Math.min(smallest.height, footprint.height) };
        },
        getToolbarFootprintForDock(toolbarDock),
      );
      const maxX = Math.max(TOOLBAR_EDGE_MARGIN, containerSize.width - dragBoundsFootprint.width - TOOLBAR_EDGE_MARGIN);
      const maxY = Math.max(TOOLBAR_EDGE_MARGIN, containerSize.height - dragBoundsFootprint.height - TOOLBAR_EDGE_MARGIN);
      const point = {
        x: toolbarClamp(toolbarDragStartRef.current.x + dx, TOOLBAR_EDGE_MARGIN, maxX),
        y: toolbarClamp(toolbarDragStartRef.current.y + dy, TOOLBAR_EDGE_MARGIN, maxY),
      };
      toolbarPositionRef.current = point;
      toolbarPosition.setValue(point);
    },
    [containerSize.height, containerSize.width, getToolbarFootprintForDock, toolbarDock, toolbarPosition],
  );

  const resolveReleaseDock = useCallback((): SharedToolbarDock => {
    const cw = containerSize.width;
    const ch = containerSize.height;
    if (cw <= 0 || ch <= 0 || toolbarSize.width <= 0 || toolbarSize.height <= 0) return toolbarDock;

    const validDocks = TOOL_DOCKS.filter((dock) => {
      const footprint = getToolbarFootprintForDock(dock);
      if (dockIsVertical(dock) && footprint.height > ch - TOOLBAR_EDGE_MARGIN * 2) return false;
      const point = dockAnchorPoint(dock, containerSize, footprint);
      const rect: Rect = { ...point, ...footprint };
      return !avoidRectsRef.current.some((avoidRect) => rectsOverlap(rect, avoidRect, TOOLBAR_COLLISION_GAP));
    });
    const candidates = validDocks.length > 0 ? validDocks : TOOL_DOCKS;
    const isValid = (dock: SharedToolbarDock) => candidates.includes(dock);
    const anchorOf = (dock: SharedToolbarDock) => dockAnchorPoint(dock, containerSize, getToolbarFootprintForDock(dock));
    const nearestValidTo = (point: Point) =>
      candidates.reduce((nearest, dock) => {
        const np = anchorOf(nearest);
        const dp = anchorOf(dock);
        const nd = Math.hypot(np.x - point.x, np.y - point.y);
        const dd = Math.hypot(dp.x - point.x, dp.y - point.y);
        return dd < nd ? dock : nearest;
      }, candidates[0]);

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

    if (nearRight && !nearLeft) return isValid('rightCenter') ? 'rightCenter' : nearestValidTo(anchorOf('rightCenter'));
    if (nearLeft && !nearRight) return isValid('leftCenter') ? 'leftCenter' : nearestValidTo(anchorOf('leftCenter'));

    const band: 'Left' | 'Center' | 'Right' = release.x < cw / 3 ? 'Left' : release.x > (cw * 2) / 3 ? 'Right' : 'Center';
    if (nearTop) {
      const cand = `top${band}` as SharedToolbarDock;
      return isValid(cand) ? cand : nearestValidTo(release);
    }
    if (nearBottom) {
      const cand = `bottom${band}` as SharedToolbarDock;
      return isValid(cand) ? cand : nearestValidTo(release);
    }
    return nearestValidTo(release);
  }, [containerSize, getToolbarFootprintForDock, toolbarDock, toolbarSize]);

  const finishToolbarDrag = useCallback(() => {
    if (!toolbarDraggingRef.current) return;
    toolbarDraggingRef.current = false;
    toolbarSuppressPressUntilRef.current = Date.now() + 200;
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
        toolbarDragFingerRef.current = { x: touch.pageX - containerOriginRef.current.x, y: touch.pageY - containerOriginRef.current.y };
      },
      onTouchMove: (event: { nativeEvent: { touches: { pageX: number; pageY: number }[] } }) => {
        if (toolbarContextScrollActiveRef.current) return;
        const touch = event.nativeEvent.touches[0];
        const start = toolbarTouchStartRef.current;
        if (!touch || !start) return;
        toolbarDragFingerRef.current = { x: touch.pageX - containerOriginRef.current.x, y: touch.pageY - containerOriginRef.current.y };
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
        onMoveShouldSetPanResponder: (_event, gesture) => !toolbarContextScrollActiveRef.current && Math.hypot(gesture.dx, gesture.dy) > TOOLBAR_DRAG_THRESHOLD,
        onMoveShouldSetPanResponderCapture: (_event, gesture) => !toolbarContextScrollActiveRef.current && Math.hypot(gesture.dx, gesture.dy) > TOOLBAR_DRAG_THRESHOLD,
        onPanResponderGrant: (event) => {
          if (toolbarContextScrollActiveRef.current) return;
          toolbarDraggingRef.current = true;
          toolbarSuppressPressUntilRef.current = Date.now() + 200;
          toolbarDragStartRef.current = { ...toolbarPositionRef.current };
          toolbarDragFingerRef.current = { x: event.nativeEvent.pageX - containerOriginRef.current.x, y: event.nativeEvent.pageY - containerOriginRef.current.y };
        },
        onPanResponderMove: (event, gesture) => {
          if (!toolbarDraggingRef.current) return;
          toolbarDragFingerRef.current = { x: event.nativeEvent.pageX - containerOriginRef.current.x, y: event.nativeEvent.pageY - containerOriginRef.current.y };
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
          toolbarDragFingerRef.current = { x: event.absoluteX - containerOriginRef.current.x, y: event.absoluteY - containerOriginRef.current.y };
        })
        .onUpdate((event) => {
          toolbarDragFingerRef.current = { x: event.absoluteX - containerOriginRef.current.x, y: event.absoluteY - containerOriginRef.current.y };
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

  const onRootLayout = useCallback(() => {
    rootRef.current?.measureInWindow((x, y, w, h) => {
      containerOriginRef.current = { x, y };
      if (w > 0 && h > 0) {
        setContainerSize((current) => (current.width === w && current.height === h ? current : { width: w, height: h }));
      }
    });
  }, []);

  const verticalActiveIndicatorStyle = [styles.vActiveIndicator, toolbarOnRight ? styles.vActiveIndicatorRight : styles.vActiveIndicatorLeft];
  const verticalContextWidth = activeTool === 'insert' ? TOOLBAR_VERTICAL_CONTEXT_WIDE : TOOLBAR_VERTICAL_CONTEXT_NARROW;

  const renderToolButton = (tool: AnnotationTool, vertical: boolean) => {
    const active = activeTool === tool;
    return (
      <Pressable
        key={tool}
        accessibilityRole="button"
        accessibilityLabel={t('tools.toolA11y', { tool: t(`tools.${tool}`) })}
        accessibilityState={{ selected: active }}
        onPress={() => runToolbarPress(() => onSelectTool(tool))}
        hitSlop={TOOLBAR_ICON_HIT_SLOP}
        {...toolbarDragResponder.panHandlers}
        {...toolbarDragTouchHandlers}
        style={({ pressed }) => [vertical ? styles.vRailButton : styles.toolButton, pressed && styles.toolbarPressed]}
      >
        {active && vertical ? <View style={styles.vActiveChip} /> : null}
        {renderToolIcon(tool, active, active ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE, 25)}
        {active ? (vertical ? <View style={verticalActiveIndicatorStyle} /> : <View style={[styles.toolUnderline, toolbarOnRight && styles.toolUnderlineVerticalRight]} />) : null}
      </Pressable>
    );
  };

  const renderHand = (vertical: boolean) => {
    const active = activeTool === 'scroll';
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={handAccessibilityLabel}
        accessibilityState={{ selected: active }}
        onPress={() => runToolbarPress(() => onSelectTool('scroll'))}
        hitSlop={TOOLBAR_ICON_HIT_SLOP}
        {...toolbarDragResponder.panHandlers}
        {...toolbarDragTouchHandlers}
        style={vertical ? styles.vRailIconButton : styles.iconToolButton}
      >
        {active && vertical ? <View style={styles.vActiveChip} /> : null}
        {renderToolIcon('scroll', active, active ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE, 23)}
        {active ? (vertical ? <View style={verticalActiveIndicatorStyle} /> : <View style={[styles.toolUnderline, toolbarOnRight && styles.toolUnderlineVerticalRight]} />) : null}
      </PressableScale>
    );
  };

  const renderColorWidthContext = (orientation: 'horizontal' | 'vertical') => {
    const isHighlighter = activeTool === 'highlighter';
    const colorOptions = isHighlighter ? highlighterColors : penColors;
    const selectedColor = isHighlighter ? highlighterColor : penColor;
    const onSelectColor = isHighlighter ? onSelectHighlighterColor : onSelectPenColor;
    const widthOptions = isHighlighter ? highlighterWidths : penWidths;
    const selectedWidth = isHighlighter ? highlighterWidth : penWidth;
    const onSelectWidth = isHighlighter ? onSelectHighlighterWidth : onSelectPenWidth;

    const swatches = colorOptions.map((option) => {
      const isActive = selectedColor.toLowerCase() === option.value.toLowerCase();
      return (
        <Pressable
          key={option.key}
          accessibilityRole="button"
          accessibilityLabel={t('tools.colorA11y', { tool: isHighlighter ? t('tools.highlighter') : t('tools.pen'), color: option.key })}
          accessibilityState={{ selected: isActive }}
          onPress={() => runToolbarPress(() => onSelectColor(option.value))}
          {...(orientation === 'horizontal' ? { ...toolbarDragResponder.panHandlers, ...toolbarDragTouchHandlers } : {})}
          style={({ pressed }) => [styles.inkSwatch, pressed && styles.toolbarPressed]}
        >
          <View style={[StyleSheet.absoluteFill, styles.inkSwatchFill, { backgroundColor: option.previewColor ?? option.value }]} />
          {isActive ? <View style={styles.inkSwatchRing} /> : null}
          {isActive ? <ToolbarSvgGlyph name="pen" color={colors.pearlWhite} size={13} /> : null}
        </Pressable>
      );
    });
    const nibs = widthOptions.map((option) => {
      const active = selectedWidth === option.value;
      return (
        <Pressable
          key={option.key}
          accessibilityRole="button"
          accessibilityLabel={t('tools.widthA11y', { tool: isHighlighter ? t('tools.highlighter') : t('tools.pen'), width: option.key })}
          accessibilityState={{ selected: active }}
          onPress={() => runToolbarPress(() => onSelectWidth(option.value))}
          {...(orientation === 'horizontal' ? { ...toolbarDragResponder.panHandlers, ...toolbarDragTouchHandlers } : {})}
          style={({ pressed }) => [styles.nib, active && styles.nibActive, pressed && styles.toolbarPressed]}
        >
          <View style={{ width: option.dot, height: option.dot, borderRadius: option.dot / 2, backgroundColor: 'rgba(255,255,255,0.92)' }} />
        </Pressable>
      );
    });

    if (orientation === 'horizontal') {
      return (
        <>
          <Text style={styles.contextLabel}>{isHighlighter ? t('tools.highlight') : t('tools.pen')}</Text>
          <View style={styles.swatchGroup}>{swatches}</View>
          <View style={styles.vDivider} />
          <View style={styles.nibGroup}>{nibs}</View>
        </>
      );
    }
    return (
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
        <View style={styles.vSwatchColumn}>{swatches}</View>
        <View style={styles.vCtxDivider} />
        <View style={styles.vNibColumn}>{nibs}</View>
      </ScrollView>
    );
  };

  const renderEraserContext = (orientation: 'horizontal' | 'vertical') => {
    const nibs = eraserSizes.map((option) => {
      const active = eraserSize === option.value;
      return (
        <Pressable
          key={option.key}
          accessibilityRole="button"
          accessibilityLabel={t('tools.eraserA11y', { size: option.key })}
          accessibilityState={{ selected: active }}
          onPress={() => runToolbarPress(() => onSelectEraserSize(option.value))}
          {...(orientation === 'horizontal' ? { ...toolbarDragResponder.panHandlers, ...toolbarDragTouchHandlers } : {})}
          style={({ pressed }) => [styles.nib, active && styles.nibActive, pressed && styles.toolbarPressed]}
        >
          <View style={{ width: option.dot, height: option.dot, borderRadius: option.dot / 2, backgroundColor: 'rgba(255,255,255,0.92)' }} />
        </Pressable>
      );
    });
    if (orientation === 'horizontal') {
      return (
        <>
          <Text style={styles.contextLabel}>{t('tools.size')}</Text>
          <View style={styles.nibGroup}>{nibs}</View>
        </>
      );
    }
    return <View style={styles.vNibColumn}>{nibs}</View>;
  };

  const renderContextBody = (orientation: 'horizontal' | 'vertical') => {
    if (activeTool === 'pen' || activeTool === 'highlighter') return renderColorWidthContext(orientation);
    if (activeTool === 'eraser') return renderEraserContext(orientation);
    if (renderExtraContext) {
      // Always supplied (not gated by orientation): Notebook's select-shape
      // buttons use it in both layouts, its insert-photo button only in the
      // horizontal one — that per-tool, per-orientation choice was already
      // asymmetric in the original code, so the caller decides, not this
      // generic slot.
      const dragHandlerProps = { ...toolbarDragResponder.panHandlers, ...toolbarDragTouchHandlers };
      return renderExtraContext(activeTool, orientation, { runPress: runToolbarPress, dragHandlerProps });
    }
    return null;
  };

  // ---- Vertical Concept-C layout ----
  const verticalToolbar = !toolbarVertical ? null : effectiveToolbarCollapsed ? (
    <View style={[styles.toolbarSurface, styles.vMiniCapsule]} {...toolbarDragResponder.panHandlers} {...toolbarDragTouchHandlers}>
      <NavySurface />
      <View accessibilityLabel={moveAccessibilityLabel} accessibilityRole="adjustable" style={styles.vMiniGrip}>
        <ToolbarGripDots />
      </View>
      <View style={styles.vMiniCur}>{renderToolIcon(activeTool, true, colors.pearlWhite, 24)}</View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={expandAccessibilityLabel}
        onPress={() => runToolbarPress(() => transitionToolbarCollapsed(false))}
        hitSlop={TOOLBAR_ICON_HIT_SLOP}
        {...toolbarDragResponder.panHandlers}
        {...toolbarDragTouchHandlers}
        style={styles.vMiniExpand}
      >
        <ToolbarSvgGlyph name={toolbarOnRight ? 'chevronLeft' : 'chevronRight'} color="rgba(255,255,255,0.6)" size={18} />
      </PressableScale>
    </View>
  ) : (
    <View style={[styles.vEdgeColumn, toolbarOnRight ? styles.vEdgeColumnRight : null]}>
      <View style={[styles.toolbarSurface, styles.vCapsule, toolbarOnRight ? styles.vCapsuleRight : null]}>
        <NavySurface />
        <View style={styles.vToolColumn} {...toolbarDragResponder.panHandlers} {...toolbarDragTouchHandlers}>
          {tools.map((tool) => renderToolButton(tool, true))}
          <View style={styles.vRailDivider} />
          {renderHand(true)}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={minimizeAccessibilityLabel}
            onPress={() => runToolbarPress(() => transitionToolbarCollapsed(true))}
            hitSlop={TOOLBAR_ICON_HIT_SLOP}
            {...toolbarDragResponder.panHandlers}
            {...toolbarDragTouchHandlers}
            style={styles.vRailIconButton}
          >
            <ToolbarSvgGlyph name={toolbarOnRight ? 'chevronRight' : 'chevronLeft'} color={TOOLBAR_ICON_IDLE} />
          </PressableScale>
        </View>
        {toolbarHasContext ? (
          <>
            <View style={styles.vColumnDivider} />
            <View style={[styles.vContextColumn, { width: verticalContextWidth }]}>{renderContextBody('vertical')}</View>
          </>
        ) : null}
      </View>
      {extraAction ? (
        <View style={[styles.toolbarSurface, styles.vActionCapsule]} {...toolbarDragResponder.panHandlers} {...toolbarDragTouchHandlers}>
          <NavySurface />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={extraAction.accessibilityLabel}
            accessibilityState={{ disabled: extraAction.disabled }}
            onPress={() => runToolbarPress(extraAction.onPress)}
            disabled={extraAction.disabled}
            hitSlop={TOOLBAR_ICON_HIT_SLOP}
            {...toolbarDragResponder.panHandlers}
            {...toolbarDragTouchHandlers}
            style={({ pressed }) => [styles.vRailIconButton, extraAction.disabled && styles.iconToolButtonDisabled, pressed && !extraAction.disabled && styles.toolbarPressed]}
          >
            {extraAction.icon}
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  return (
    <View ref={rootRef} style={StyleSheet.absoluteFill} pointerEvents="box-none" onLayout={onRootLayout} collapsable={false}>
      {editable ? (
        <GestureDetector gesture={toolbarVertical ? disabledToolbarPanGesture : toolbarPanGesture}>
          <Animated.View
            pointerEvents="auto"
            style={[
              styles.floatingToolbarWrap,
              toolbarVertical && styles.floatingToolbarWrapVertical,
              toolbarOnRight && styles.floatingToolbarWrapRight,
              { width: toolbarFrameSize.width, height: toolbarFrameSize.height, opacity: ready ? 1 : 0 },
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
                    { width: toolbarVisualSize.width, height: toolbarVisualSize.height, transform: [{ scale: toolbarScale }] },
                  ]}
                  {...toolbarDragResponder.panHandlers}
                  {...toolbarDragTouchHandlers}
                >
                  <NavySurface width={toolbarVisualSize.width} height={toolbarVisualSize.height} />
                  <Animated.View
                    pointerEvents={effectiveToolbarCollapsed ? 'auto' : 'none'}
                    style={[styles.collapsedContent, { opacity: collapsedContentOpacity }]}
                  >
                    <View accessibilityLabel={moveAccessibilityLabel} accessibilityRole="adjustable" style={styles.collapsedGrip}>
                      <ToolbarGripDots />
                    </View>
                    <View style={styles.collapsedCur}>{renderToolIcon(activeTool, true, colors.pearlWhite, 24)}</View>
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel={expandAccessibilityLabel}
                      onPress={() => runToolbarPress(() => transitionToolbarCollapsed(false))}
                      hitSlop={TOOLBAR_ICON_HIT_SLOP}
                      {...toolbarDragResponder.panHandlers}
                      {...toolbarDragTouchHandlers}
                      style={styles.collapsedExpand}
                    >
                      <ToolbarSvgGlyph name="chevronUp" color="rgba(255,255,255,0.6)" size={18} />
                    </PressableScale>
                  </Animated.View>

                  <Animated.View pointerEvents={effectiveToolbarCollapsed ? 'none' : 'auto'} style={[styles.expandedContent, { opacity: expandedContentOpacity }]}>
                    <View style={styles.primaryToolbarRow}>
                      <View accessibilityLabel={moveAccessibilityLabel} accessibilityRole="adjustable" style={styles.expandedDragHandle}>
                        <ToolbarGripDots />
                      </View>
                      <View style={styles.primaryTools}>{tools.map((tool) => renderToolButton(tool, false))}</View>
                      <View style={styles.vDivider} />
                      {renderHand(false)}
                      <View style={styles.vDivider} />
                      <PressableScale
                        accessibilityRole="button"
                        accessibilityLabel={minimizeAccessibilityLabel}
                        onPress={() => runToolbarPress(() => transitionToolbarCollapsed(true))}
                        hitSlop={TOOLBAR_ICON_HIT_SLOP}
                        {...toolbarDragResponder.panHandlers}
                        {...toolbarDragTouchHandlers}
                        style={styles.collapseButton}
                      >
                        <ToolbarSvgGlyph name="chevronRight" color={TOOLBAR_ICON_IDLE} />
                      </PressableScale>
                    </View>

                    {toolbarHasContext ? (
                      <Animated.View
                        style={[
                          styles.contextToolbarRow,
                          {
                            opacity: Animated.multiply(
                              toolbarTransition.interpolate({ inputRange: [0, 0.65, 1], outputRange: [0, 0, 1] }),
                              contextFade,
                            ),
                          },
                        ]}
                      >
                        {renderContextBody('horizontal')}
                      </Animated.View>
                    ) : null}
                  </Animated.View>
                </Animated.View>

                {!effectiveToolbarCollapsed && extraAction ? (
                  <View style={[styles.toolbarSurface, styles.rightPill]} {...toolbarDragResponder.panHandlers} {...toolbarDragTouchHandlers}>
                    <NavySurface width={TOOLBAR_HISTORY_PILL_WIDTH} height={60} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={extraAction.accessibilityLabel}
                      accessibilityState={{ disabled: extraAction.disabled }}
                      onPress={() => runToolbarPress(extraAction.onPress)}
                      disabled={extraAction.disabled}
                      hitSlop={TOOLBAR_ICON_HIT_SLOP}
                      {...toolbarDragResponder.panHandlers}
                      {...toolbarDragTouchHandlers}
                      style={({ pressed }) => [styles.iconToolButton, extraAction.disabled && styles.iconToolButtonDisabled, pressed && !extraAction.disabled && styles.toolbarPressed]}
                    >
                      {extraAction.icon}
                    </Pressable>
                  </View>
                ) : null}
              </>
            )}
          </Animated.View>
        </GestureDetector>
      ) : null}

      {editable && showFixedHistory ? (
        <View style={[styles.fixedHistory, { top: fixedHistoryPosition.top, right: fixedHistoryPosition.right }]} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('tools.undo')}
            accessibilityState={{ disabled: !canUndo }}
            onPress={onUndo}
            disabled={!canUndo}
            hitSlop={TOOLBAR_ICON_HIT_SLOP}
            style={({ pressed }) => [styles.fixedHistoryButton, pressed && canUndo && styles.toolbarPressed]}
          >
            <ToolbarSvgGlyph name="undo" color={canUndo ? TOOLBAR_ICON_IDLE : TOOLBAR_ICON_DISABLED} />
          </Pressable>
          <View style={styles.fixedHistoryDivider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('tools.redo')}
            accessibilityState={{ disabled: !canRedo }}
            onPress={onRedo}
            disabled={!canRedo}
            hitSlop={TOOLBAR_ICON_HIT_SLOP}
            style={({ pressed }) => [styles.fixedHistoryButton, pressed && canRedo && styles.toolbarPressed]}
          >
            <ToolbarSvgGlyph name="redo" color={canRedo ? TOOLBAR_ICON_IDLE : TOOLBAR_ICON_DISABLED} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export const SharedAnnotationToolbar = memo(SharedAnnotationToolbarBase);

const styles = StyleSheet.create({
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
  floatingToolbarWrapVertical: {
    alignItems: 'center',
  },
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
  expandedContent: {
    ...StyleSheet.absoluteFillObject,
  },
  primaryToolbarRow: {
    height: TOOLBAR_PRIMARY_HEIGHT,
    flexDirection: 'row',
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
  primaryTools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
  },
  toolButton: {
    width: 48,
    height: 46,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  swatchGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  nibGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
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
  collapseButton: {
    width: 34,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255, 255, 255, 0.08)',
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
  collapsedGrip: {
    height: '100%',
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
  // ==== Vertical (Concept C) layout ====
  vEdgeColumn: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: TOOLBAR_VERTICAL_GROUP_GAP,
  },
  vEdgeColumnRight: {
    alignItems: 'flex-end',
  },
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
  vRailButton: {
    width: 48,
    height: 44,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vActiveChip: {
    position: 'absolute',
    top: 2,
    left: 6,
    right: 6,
    bottom: 2,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    backgroundColor: 'rgba(95,134,232,0.14)',
  },
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
  vRailIconButton: {
    width: 44,
    height: 44,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vColumnDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
    marginVertical: 16,
  },
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
  vActionCapsule: {
    width: TOOLBAR_VERTICAL_TOOL_COL_WIDTH,
    borderRadius: 18,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 8,
  },
  vMiniCapsule: {
    width: TOOLBAR_MINI_CAPSULE_WIDTH,
    height: TOOLBAR_MINI_CAPSULE_HEIGHT,
    borderRadius: TOOLBAR_SHELL_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  vMiniGrip: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  vMiniCur: {
    width: 40,
    height: 40,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(95,134,232,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(95,134,232,0.3)',
  },
  vMiniExpand: {
    width: 44,
    height: 32,
    borderRadius: TOOLBAR_CHIP_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Fixed Undo/Redo capsule — top-right (position overridden via props), never moves.
  fixedHistory: {
    position: 'absolute',
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
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fixedHistoryDivider: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    backgroundColor: TOOLBAR_DIVIDER_COLOR,
  },
});
