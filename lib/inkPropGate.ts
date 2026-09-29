/**
 * Decision model for holding the native `annotationsByPage` prop while the
 * Apple Pencil is writing (see the ink-latency note in the Course Material
 * screen). Pure so it can be tested without React or timers; the screen owns
 * the timers and calls these transitions.
 *
 *   idle ──pencil down──▶ writing ──pencil up──▶ settling ──timer──▶ idle
 *
 * A prop change is delivered only when idle, or when an explicit edit
 * (Undo/Redo/Clear/Delete/Duplicate) requested a bypass. A bypass is consumed
 * by the delivery it enables.
 */
export type InkPropGateState = { writing: boolean; settling: boolean; bypass: boolean };

export const INK_PROP_GATE_IDLE: InkPropGateState = { writing: false, settling: false, bypass: false };

export const gatePencilDown = (s: InkPropGateState): InkPropGateState => ({ ...s, writing: true, settling: false });
export const gatePencilLifted = (s: InkPropGateState): InkPropGateState => ({ ...s, writing: false, settling: true });
export const gateSettled = (s: InkPropGateState): InkPropGateState => ({ ...s, writing: false, settling: false });
export const gateRequestBypass = (s: InkPropGateState): InkPropGateState => ({ ...s, bypass: true });

export function gateDecide(s: InkPropGateState): { deliver: boolean; next: InkPropGateState } {
  if (s.bypass || (!s.writing && !s.settling)) return { deliver: true, next: { ...s, bypass: false } };
  return { deliver: false, next: s };
}
