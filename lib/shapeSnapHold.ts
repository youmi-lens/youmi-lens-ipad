/**
 * Draw-and-hold detection shared by Notebook and Course Material.
 *
 * One semantic constant for the hold duration and one for the endpoint
 * movement tolerance (screen points, so it is zoom-independent; adapters
 * convert to their own units). Pure and allocation-free per sample so it adds
 * nothing measurable to ordinary handwriting: a sample is one distance
 * compare, and a timer is only ever armed once per stroke (it re-arms itself
 * for the remaining time instead of being reset on every sample).
 */
export const SHAPE_SNAP_HOLD_MS = 650;
/** Pencil jitter allowed while "holding", in screen points. */
export const SHAPE_SNAP_HOLD_TOLERANCE_PT = 3.5;
/** A stroke must have at least this many accepted samples and this much travel (screen pt) to be eligible. */
export const SHAPE_SNAP_MIN_SAMPLES = 8;
export const SHAPE_SNAP_MIN_TRAVEL_PT = 30;

export class ShapeHoldTracker {
  private anchorX = 0;
  private anchorY = 0;
  private anchorAt = 0;
  private lastX = 0;
  private lastY = 0;
  private samples = 0;
  private travel = 0;
  private started = false;
  /** True once a hold has been reported for the current anchor; re-armed by real movement. */
  fired = false;

  begin(x: number, y: number, now: number) {
    this.anchorX = x; this.anchorY = y; this.anchorAt = now;
    this.lastX = x; this.lastY = y;
    this.samples = 1; this.travel = 0; this.started = true; this.fired = false;
  }

  /** `tolerance` and coordinates share one unit (the adapter's workspace units). Returns true if the anchor moved. */
  sample(x: number, y: number, now: number, tolerance: number, unitsPerScreenPt: number): boolean {
    if (!this.started) return false;
    this.samples += 1;
    this.travel += Math.hypot(x - this.lastX, y - this.lastY) / unitsPerScreenPt;
    this.lastX = x; this.lastY = y;
    if (Math.hypot(x - this.anchorX, y - this.anchorY) > tolerance) {
      this.anchorX = x; this.anchorY = y; this.anchorAt = now; this.fired = false;
      return true;
    }
    return false;
  }

  /** Milliseconds until the hold is long enough (<= 0 means eligible now). */
  remaining(now: number, holdMs: number = SHAPE_SNAP_HOLD_MS): number {
    return holdMs - (now - this.anchorAt);
  }

  /** Long enough and enough stroke to be worth recognizing. Never true twice for one anchor. */
  shouldRecognize(now: number, holdMs: number = SHAPE_SNAP_HOLD_MS): boolean {
    return this.started && !this.fired && this.remaining(now, holdMs) <= 0 &&
      this.samples >= SHAPE_SNAP_MIN_SAMPLES && this.travel >= SHAPE_SNAP_MIN_TRAVEL_PT;
  }

  markFired() { this.fired = true; }
  end() { this.started = false; }
}
