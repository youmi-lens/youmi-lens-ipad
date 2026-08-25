/**
 * Always-on (NOT __DEV__-gated) non-PII IAP diagnostics for physical
 * TestFlight investigation of purchase-presentation reliability.
 *
 * Unlike `logIap` (lib/iapLog.ts), which is compiled out of release builds,
 * these calls are plain `console.log` and therefore survive into TestFlight —
 * this project has no console-stripping babel/metro plugin, so they remain
 * visible via Xcode's device console / Console.app when needed, and can be
 * deleted or disabled entirely once the investigation is closed.
 *
 * The event name is a closed allowlist and values must be primitives — this
 * makes it structurally impossible to accidentally pass an account
 * identifier, token, transaction id, receipt, or JWS through this channel.
 */
const DIAG_EVENTS = [
  'products_load_start',
  'products_load_done',
  'intro_eligibility_result',
  'intro_product_fields',
  'purchase_request_start',
  'active_scene_check',
  'purchase_update_received',
  'purchase_error_received',
  'purchase_timeout_fired',
  'purchase_busy_cleared',
] as const;

type DiagEvent = (typeof DIAG_EVENTS)[number];
type DiagValue = string | number | boolean | null;

export function logDiag(event: DiagEvent, data?: Record<string, DiagValue>): void {
  // eslint-disable-next-line no-console
  console.log('[iap-diag]', event, data ?? {});
}
