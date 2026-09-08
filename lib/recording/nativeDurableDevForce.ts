/**
 * Single source of truth for the DEV-ONLY native-durable-recorder force gate.
 *
 * Deliberately has NO local imports (mirrors isR6SimulatorVerifyEnabled in
 * r6VerifyGate.ts) so it stays trivially importable and testable on its own.
 * The actual override call (setDeveloperRecordingEngineOverride) is made by
 * the caller (app/_layout.tsx) only when this returns true — that keeps this
 * file a pure boolean check with nothing to fail to resolve or to accidentally
 * pull into a bundle.
 *
 * Requires BOTH `__DEV__` and the exact env value; missing, malformed, or
 * unexpected values leave the app on whatever the normal policy would have
 * chosen. This can never affect a release/TestFlight/Production build:
 * `__DEV__` is compiled to `false` there, and setDeveloperRecordingEngineOverride
 * is separately a no-op outside `__DEV__` regardless of this gate.
 */
export function isNativeDurableRecorderDevForceEnabled(
  options: { isDev?: boolean; envValue?: string | undefined } = {},
): boolean {
  const isDev = options.isDev ?? (typeof __DEV__ !== 'undefined' && __DEV__ === true);
  const envValue =
    options.envValue ??
    (typeof process !== 'undefined'
      ? process.env.EXPO_PUBLIC_FORCE_NATIVE_DURABLE_RECORDER
      : undefined);
  return isDev === true && envValue === '1';
}
