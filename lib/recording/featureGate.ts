import {
  RECORDING_FALLBACK_REASONS,
  resolveRecordingEngineDecision,
} from './policy.mjs';

export type RecordingEngine = 'legacy' | 'nativeDurable';

export type RecordingEngineSource =
  | 'default'
  | 'test_override'
  | 'developer_override'
  | 'internal_dogfood';

export type RecordingFallbackReason = (typeof RECORDING_FALLBACK_REASONS)[number];

export type RecordingEngineDecision = {
  engine: RecordingEngine;
  source: RecordingEngineSource;
  fallbackReason: RecordingFallbackReason | null;
  /** Durable native audio exists and must stay reachable whatever engine runs. */
  retainNativeRecovery: boolean;
};

/** Native capability probe results. `undefined` means "not yet known". */
export type NativeCapability = {
  supportedRuntime?: boolean;
  moduleAvailable?: boolean;
  contractCompatible?: boolean;
  storageAvailable?: boolean;
  initialized?: boolean;
  microphoneAvailable?: boolean;
};

// Phase 2C rollout boundary. Keep this committed value on legacy. Controlled
// device verification may change this line locally, then must restore it.
export const CONFIGURED_RECORDING_ENGINE: RecordingEngine = 'legacy';

/**
 * Internal dogfood cohort. Set at build time in an internal build's env; it is
 * absent from public release builds, so those always resolve to legacy. This
 * reuses the existing EXPO_PUBLIC_* configuration path rather than adding a new
 * flag system, and carries no user identity.
 */
export const INTERNAL_DOGFOOD_ENABLED =
  process.env.EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD === '1';

/**
 * Development-only override, settable from a dev menu or debugger. It is read
 * only when __DEV__ is true, so a release build ignores it entirely.
 */
let developerOverride: RecordingEngine | null = null;

export function setDeveloperRecordingEngineOverride(engine: RecordingEngine | null): void {
  if (!__DEV__) return;
  developerOverride = engine;
}

export function getDeveloperRecordingEngineOverride(): RecordingEngine | null {
  return __DEV__ ? developerOverride : null;
}

/**
 * Full engine decision, including why it was made. Prefer this over
 * resolveRecordingEngine when the caller needs the source or fallback reason.
 */
export function resolveRecordingEngineDecisionForRuntime(options: {
  forceLegacy?: boolean;
  capability?: NativeCapability;
  hasDurableEvidence?: boolean;
  eligibilityResolved?: boolean;
  /** Normalized per-user rollout result; null when not resolved yet. */
  rollout?: {
    eligible: boolean;
    resolved: boolean;
    reason: string | null;
    cohort: string | null;
    revision: number | null;
  } | null;
  /** Engine already chosen for an in-flight recording session. */
  frozenEngine?: RecordingEngine | null;
} = {}): RecordingEngineDecision {
  return resolveRecordingEngineDecision({
    forceLegacy: options.forceLegacy === true,
    rollout: options.rollout ?? null,
    frozenEngine: options.frozenEngine ?? null,
    isDevelopment: __DEV__,
    // No test context exists at runtime; the override path is exercised by the
    // pure policy tests, which is what keeps it inert in every shipped build.
    isTestContext: false,
    developerOverride: getDeveloperRecordingEngineOverride(),
    dogfoodEnabled: INTERNAL_DOGFOOD_ENABLED && CONFIGURED_RECORDING_ENGINE === 'legacy',
    eligibilityResolved: options.eligibilityResolved !== false,
    capability: options.capability ?? {},
    hasDurableEvidence: options.hasDurableEvidence === true,
  }) as RecordingEngineDecision;
}

export function resolveRecordingEngine(forceLegacy = false): RecordingEngine {
  // The compile-time constant still wins when it is deliberately flipped for
  // controlled device verification; otherwise the runtime policy decides.
  if (!forceLegacy && CONFIGURED_RECORDING_ENGINE === 'nativeDurable') return 'nativeDurable';
  return resolveRecordingEngineDecisionForRuntime({ forceLegacy }).engine;
}
