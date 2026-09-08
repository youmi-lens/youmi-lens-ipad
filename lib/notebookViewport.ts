/**
 * Pure Notebook viewport helpers: pinch-zoom clamping, screen→canvas mapping,
 * stylus session / palm-grace scroll lock model. No React Native imports.
 */

export const NOTEBOOK_MIN_SCALE = 0.5;
export const NOTEBOOK_MAX_SCALE = 3.5;
export const NOTEBOOK_DEFAULT_SCALE = 1;
/** Keep scroll locked briefly after Pencil up so residual palm does not jump the page. */
export const NOTEBOOK_PALM_GRACE_MS = 300;

export function clampNotebookScale(scale: number): number {
  'worklet';
  if (!Number.isFinite(scale)) return NOTEBOOK_DEFAULT_SCALE;
  return Math.min(NOTEBOOK_MAX_SCALE, Math.max(NOTEBOOK_MIN_SCALE, scale));
}

/**
 * Map a viewport touch (plus vertical scroll offset + horizontal pan) into
 * unscaled canvas coords. Matches RN transform `[{ translateX }, { scale }]`
 * with origin top-left (scale first, then translate → screen = content*scale + tx).
 */
export function screenToCanvasPoint(
  touchX: number,
  touchY: number,
  scrollOffsetY: number,
  scale: number,
  translateX: number = 0,
): { x: number; y: number } {
  const s = scale > 0 && Number.isFinite(scale) ? scale : NOTEBOOK_DEFAULT_SCALE;
  const tx = Number.isFinite(translateX) ? translateX : 0;
  return {
    x: (touchX - tx) / s,
    y: (touchY + scrollOffsetY) / s,
  };
}

/** Inverse of screenToCanvasPoint for X (content → viewport X at scrollY=0). */
export function canvasToScreenX(contentX: number, scale: number, translateX: number): number {
  const s = scale > 0 && Number.isFinite(scale) ? scale : NOTEBOOK_DEFAULT_SCALE;
  const tx = Number.isFinite(translateX) ? translateX : 0;
  return contentX * s + tx;
}

/**
 * Keep the content point under the pinch focal fixed when scale changes (Y via ScrollView).
 * Returns the new contentOffset.y for ScrollView (clamped ≥ 0).
 * Prefer {@link applyPinchZoomFromStart} for begin-relative pinch updates.
 */
export function scrollYAfterScaleAboutFocal(args: {
  focalY: number;
  scrollOffsetY: number;
  oldScale: number;
  newScale: number;
}): number {
  const oldScale =
    args.oldScale > 0 && Number.isFinite(args.oldScale)
      ? args.oldScale
      : NOTEBOOK_DEFAULT_SCALE;
  const newScale = clampNotebookScale(args.newScale);
  const logicalY = (args.focalY + args.scrollOffsetY) / oldScale;
  const next = logicalY * newScale - args.focalY;
  if (!Number.isFinite(next)) return Math.max(0, args.scrollOffsetY);
  return Math.max(0, next);
}

/**
 * Horizontal pan clamp:
 * - scaled content narrower than viewport → center (never stick left);
 * - scaled content wider → keep edges within the viewport.
 */
export function clampNotebookTranslateX(args: {
  translateX: number;
  scale: number;
  viewportWidth: number;
  contentWidth: number;
}): number {
  'worklet';
  const scale = clampNotebookScale(args.scale);
  const vw = args.viewportWidth > 0 && Number.isFinite(args.viewportWidth) ? args.viewportWidth : 0;
  const cw = args.contentWidth > 0 && Number.isFinite(args.contentWidth) ? args.contentWidth : vw;
  if (vw <= 0 || cw <= 0) return Number.isFinite(args.translateX) ? args.translateX : 0;

  const scaledW = cw * scale;
  if (scaledW <= vw + 0.5) {
    return (vw - scaledW) / 2;
  }
  const minX = vw - scaledW;
  const maxX = 0;
  const tx = Number.isFinite(args.translateX) ? args.translateX : 0;
  return Math.min(maxX, Math.max(minX, tx));
}

/** Clamp vertical scroll after zoom so content stays reachable. */
export function clampNotebookScrollY(args: {
  scrollY: number;
  scale: number;
  viewportHeight: number;
  contentHeight: number;
}): number {
  'worklet';
  const scale = clampNotebookScale(args.scale);
  const vh = args.viewportHeight > 0 && Number.isFinite(args.viewportHeight) ? args.viewportHeight : 0;
  const ch = args.contentHeight > 0 && Number.isFinite(args.contentHeight) ? args.contentHeight : 0;
  const scrollY = Number.isFinite(args.scrollY) ? args.scrollY : 0;
  if (vh <= 0 || ch <= 0) return Math.max(0, scrollY);

  const scaledH = ch * scale;
  if (scaledH <= vh) return 0;
  const maxScroll = scaledH - vh;
  return Math.min(maxScroll, Math.max(0, scrollY));
}

/**
 * Begin-relative focal-point zoom (Notability-style).
 * Content under the start focal stays under the current focal; X uses translate,
 * Y uses ScrollView offset. Does not rewrite stored stroke coordinates.
 */
export function applyPinchZoomFromStart(args: {
  startScale: number;
  startTranslateX: number;
  startScrollY: number;
  startFocalX: number;
  startFocalY: number;
  /** Current pinch midpoint (viewport coords of the GestureDetector / ScrollView). */
  focalX: number;
  focalY: number;
  /** RNGH Pinch `event.scale` — cumulative since gesture begin. */
  gestureScale: number;
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
}): { scale: number; translateX: number; scrollY: number } {
  'worklet';
  const startScale =
    args.startScale > 0 && Number.isFinite(args.startScale)
      ? args.startScale
      : NOTEBOOK_DEFAULT_SCALE;
  const startTx = Number.isFinite(args.startTranslateX) ? args.startTranslateX : 0;
  const startScrollY = Number.isFinite(args.startScrollY) ? Math.max(0, args.startScrollY) : 0;
  const gestureScale =
    args.gestureScale > 0 && Number.isFinite(args.gestureScale) ? args.gestureScale : 1;
  const scale = clampNotebookScale(startScale * gestureScale);

  const contentX = (args.startFocalX - startTx) / startScale;
  const contentY = (args.startFocalY + startScrollY) / startScale;

  const rawTx = args.focalX - contentX * scale;
  const rawScrollY = contentY * scale - args.focalY;

  const translateX = clampNotebookTranslateX({
    translateX: rawTx,
    scale,
    viewportWidth: args.viewportWidth,
    contentWidth: args.contentWidth,
  });
  const scrollY = clampNotebookScrollY({
    scrollY: rawScrollY,
    scale,
    viewportHeight: args.viewportHeight,
    contentHeight: args.contentHeight,
  });

  return {
    scale,
    translateX: Number.isFinite(translateX) ? translateX : 0,
    scrollY: Number.isFinite(scrollY) ? scrollY : 0,
  };
}

export type StylusScrollLockState = {
  strokeActive: boolean;
  palmGrace: boolean;
  pinchActive: boolean;
  imageManipulation: boolean;
};

/** Whether the Notebook ScrollView must reject finger/palm scrolling. */
export function shouldLockNotebookScroll(state: StylusScrollLockState): boolean {
  return (
    state.strokeActive ||
    state.palmGrace ||
    state.pinchActive ||
    state.imageManipulation
  );
}

/**
 * Pure model of stylus session + palm grace for tests.
 * `tick(ms)` advances time for grace expiry.
 */
export function createStylusSessionModel(graceMs: number = NOTEBOOK_PALM_GRACE_MS) {
  let strokeActive = false;
  let palmGrace = false;
  let graceRemaining = 0;
  let pinchActive = false;
  let imageManipulation = false;

  const snapshot = () => ({
    strokeActive,
    palmGrace,
    pinchActive,
    imageManipulation,
    scrollLocked: shouldLockNotebookScroll({
      strokeActive,
      palmGrace,
      pinchActive,
      imageManipulation,
    }),
  });

  return {
    snapshot,
    stylusDown() {
      strokeActive = true;
      palmGrace = false;
      graceRemaining = 0;
      return snapshot();
    },
    stylusUp() {
      strokeActive = false;
      palmGrace = true;
      graceRemaining = graceMs;
      return snapshot();
    },
    cancel() {
      strokeActive = false;
      palmGrace = false;
      graceRemaining = 0;
      return snapshot();
    },
    pinchBegin() {
      if (strokeActive || palmGrace) return snapshot();
      pinchActive = true;
      return snapshot();
    },
    pinchEnd() {
      pinchActive = false;
      return snapshot();
    },
    tick(ms: number) {
      if (!palmGrace) return snapshot();
      graceRemaining = Math.max(0, graceRemaining - ms);
      if (graceRemaining === 0) palmGrace = false;
      return snapshot();
    },
  };
}
