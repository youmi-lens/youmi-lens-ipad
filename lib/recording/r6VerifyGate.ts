/**
 * Single source of truth for R6 Simulator verification activation.
 *
 * Production / TestFlight / Release must never activate. Fail closed unless
 * every gate is an exact match — missing, malformed, or unexpected values
 * disable the host.
 */
export function isR6SimulatorVerifyEnabled(
  options: {
    isDev?: boolean;
    envValue?: string | undefined;
  } = {},
): boolean {
  const isDev = options.isDev ?? (typeof __DEV__ !== 'undefined' && __DEV__ === true);
  const envValue =
    options.envValue ??
    (typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_R6_SIMULATOR_VERIFY : undefined);
  return isDev === true && envValue === '1';
}
