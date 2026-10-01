/**
 * PK4-B — narrow shared toolbar chrome: pure logic only (tokens, dock type,
 * dock-anchor math). No JSX here on purpose — this file is executed directly
 * by scripts/shared-toolbar-chrome.test.mjs via node's TypeScript
 * type-stripping, which cannot parse JSX; the rendering half (NavySurface,
 * grip dots, shared glyph paths) lives in components/SharedToolbarChrome.tsx
 * and is verified by the same test via source-text comparison instead.
 *
 * Everything exported here was verified byte-identical against BOTH
 * components/NotebookCanvas.tsx's and components/MaterialFloatingToolbar.tsx's
 * CURRENT source before being extracted — not assumed from either file's own
 * comments (MaterialFloatingToolbar.tsx's header claim that it is still
 * "visually and behaviourally identical" to Notebook's toolbar is stale: the
 * two have diverged in tool set, Undo/Redo placement, and vertical-dock
 * layout — see the PK4-B report). Only the pieces still genuinely identical
 * today are here. Neither NotebookCanvas.tsx nor MaterialFloatingToolbar.tsx
 * imports this yet — see the PK4-B report for why wiring is deferred.
 */

// ---- Shared visual tokens ----
export const TOOLBAR_NAVY_TOP = '#1E2E50';
export const TOOLBAR_NAVY_BOTTOM = '#16233F';
export const TOOLBAR_BORDER_COLOR = 'rgba(255,255,255,0.07)';
export const TOOLBAR_SELECTED = '#5F86E8';
export const TOOLBAR_ICON_IDLE = 'rgba(255,255,255,0.62)';
export const TOOLBAR_ICON_DISABLED = 'rgba(255,255,255,0.26)';
export const TOOLBAR_DIVIDER_COLOR = 'rgba(255,255,255,0.11)';
export const TOOLBAR_SHELL_RADIUS = 22;
export const TOOLBAR_MINIMIZED_RADIUS = 16;
export const TOOLBAR_CHIP_RADIUS = 11;
export const TOOLBAR_EDGE_MARGIN = 12;
export const TOOLBAR_DRAG_THRESHOLD = 8;
export const TOOLBAR_ICON_HIT_SLOP = { top: 5, right: 5, bottom: 5, left: 5 };
export const TOOLBAR_SIDE_EDGE_ZONE_RATIO = 0.28;
export const TOOLBAR_SIDE_EDGE_ZONE_MIN = 300;
export const TOOLBAR_VERT_EDGE_ZONE_RATIO = 0.2;
export const TOOLBAR_VERT_EDGE_ZONE_MIN = 150;

/** The 8-way dock union both toolbars already use, with identical string values. */
export type SharedToolbarDock =
  | 'topLeft'
  | 'topCenter'
  | 'topRight'
  | 'leftCenter'
  | 'rightCenter'
  | 'bottomLeft'
  | 'bottomCenter'
  | 'bottomRight';

export function toolbarClamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function dockIsVertical(dock: SharedToolbarDock): boolean {
  return dock === 'leftCenter' || dock === 'rightCenter';
}

/**
 * Top-left anchor position for a dock, given the container and toolbar
 * sizes. Pure geometry only — verified identical to Notebook's
 * `toolbarDockPoint` and Course Material's `dockPoint`.
 *
 * Deliberately does NOT decide which dock to snap to on drag release:
 * Notebook's release logic (`resolveReleaseDock` + `chooseToolbarDock`) has
 * since grown per-dock footprint sizing and avoid-rects for the caption/
 * recording overlay; Course Material's `resolveReleaseDock` is still the
 * original simple nearest-edge version. Those have genuinely diverged and
 * are intentionally left unshared and unmodified.
 */
export function dockAnchorPoint(
  dock: SharedToolbarDock,
  container: { width: number; height: number },
  toolbar: { width: number; height: number },
): { x: number; y: number } {
  const left = TOOLBAR_EDGE_MARGIN;
  const right = Math.max(left, container.width - toolbar.width - TOOLBAR_EDGE_MARGIN);
  const top = TOOLBAR_EDGE_MARGIN;
  const bottom = Math.max(top, container.height - toolbar.height - TOOLBAR_EDGE_MARGIN);
  const centerX = toolbarClamp((container.width - toolbar.width) / 2, left, right);
  const centerY = toolbarClamp((container.height - toolbar.height) / 2, top, bottom);
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
