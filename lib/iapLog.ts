/**
 * Production-safe IAP diagnostics. Logs are emitted only in development builds
 * (__DEV__), so release/App Store builds stay quiet. Never pass secrets,
 * receipts, or signed transaction payloads here — only flow markers and flags.
 */
export function logIap(...args: unknown[]): void {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[iap]', ...args);
  }
}
