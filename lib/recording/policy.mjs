export const DEFAULT_RECORDING_ENGINE = 'legacy';

export function resolveRecordingEngineValue(configured, forceLegacy = false) {
  if (forceLegacy) return 'legacy';
  return configured === 'nativeDurable' ? 'nativeDurable' : 'legacy';
}

export function finalizedDurationMillis(session) {
  return (session?.segments ?? []).reduce((total, segment) => total + Math.max(0, segment.durationMs ?? 0), 0);
}

export function recoverableSessionsForLecture(sessions, lectureId) {
  return (sessions ?? [])
    .filter((session) => session?.lectureId === lectureId && (
      session.recoverable === true || (session.state === 'finalized' && !session.handoffCompletedAt)
    ))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.recordingSessionId.localeCompare(b.recordingSessionId));
}

export function orderedSourceSegmentIds(session) {
  return [...(session?.segments ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .map((segment) => segment.segmentId);
}

export function finalAssetIsComplete(session) {
  const expected = orderedSourceSegmentIds(session);
  const actual = session?.finalAsset?.sourceSegmentIds ?? [];
  return session?.state === 'finalized'
    && session?.finalAsset?.relativePath === 'final/lecture.m4a'
    && session?.finalAsset?.durationMs > 0
    && expected.length > 0
    && expected.every((id, index) => actual[index] === id)
    && actual.length === expected.length;
}

export function canFallbackBeforeNativeAudio(session) {
  return !session || (session.segments?.length ?? 0) === 0;
}

/**
 * Which engine produced a lecture. Lectures recorded before provenance existed
 * have no value; they are reported as legacy, which is the safe reading — it
 * never routes an old lecture into native recovery.
 */
export function lectureRecordingEngine(lecture) {
  const value = lecture?.recordingEngine;
  return value === 'nativeDurable' || value === 'legacy' ? value : DEFAULT_RECORDING_ENGINE;
}

// ---------------------------------------------------------------------------
// Phase 3 — controlled rollout policy
// ---------------------------------------------------------------------------

/** Where an engine decision came from. Ordered by descending priority. */
export const RECORDING_ENGINE_SOURCES = Object.freeze([
  'frozen_session',
  'durable_ownership',
  'test_override',
  'developer_override',
  'remote_rollout',
  'internal_dogfood',
  'default',
]);

/** Stable, non-identifying reasons a native selection degraded to legacy. */
export const RECORDING_FALLBACK_REASONS = Object.freeze([
  'native_module_unavailable',
  'native_initialization_failed',
  'native_storage_unavailable',
  'native_contract_incompatible',
  'native_permission_unavailable',
  'eligibility_unavailable',
  'unsupported_runtime',
]);

function isEngine(value) {
  return value === 'legacy' || value === 'nativeDurable';
}

/**
 * First reason native capture cannot be used, or null when native is usable.
 * Order is fixed so the same inputs always yield the same reason.
 */
function nativeUnavailableReason(capability = {}) {
  if (capability.supportedRuntime === false) return 'unsupported_runtime';
  if (capability.moduleAvailable === false) return 'native_module_unavailable';
  if (capability.contractCompatible === false) return 'native_contract_incompatible';
  if (capability.storageAvailable === false) return 'native_storage_unavailable';
  if (capability.initialized === false) return 'native_initialization_failed';
  if (capability.microphoneAvailable === false) return 'native_permission_unavailable';
  return null;
}

/**
 * Pure recording-engine decision. Deterministic for a given input, so it can be
 * exhaustively tested without a device.
 *
 * Safety rules encoded here:
 *  - The default is always legacy; native must be explicitly selected.
 *  - Eligibility that cannot be resolved fails closed to legacy.
 *  - Overrides are inert unless their context flag is set, so a release build
 *    cannot be pushed onto native by a stale local value.
 *  - `retainNativeRecovery` stays true whenever durable native audio exists,
 *    regardless of the engine chosen. Policy must never hide existing audio.
 */
export function resolveRecordingEngineDecision(input = {}) {
  const {
    forceLegacy = false,
    isDevelopment = false,
    isTestContext = false,
    testOverride = null,
    developerOverride = null,
    dogfoodEnabled = false,
    eligibilityResolved = true,
    capability = {},
    hasDurableEvidence = false,
    frozenEngine = null,
    rollout = null,
  } = input;

  // Durable native audio outlives any policy decision.
  const retainNativeRecovery = hasDurableEvidence === true;
  const decide = (engine, source, fallbackReason = null) => ({
    engine,
    source,
    fallbackReason,
    retainNativeRecovery,
  });

  // An in-flight recording keeps the engine it started with. A remote change,
  // a cache refresh or a token refresh must never switch engines mid-session.
  if (isEngine(frozenEngine)) return decide(frozenEngine, 'frozen_session');

  // Guests and other protected flows are never routed to native.
  if (forceLegacy) return decide('legacy', 'default');

  let desired = DEFAULT_RECORDING_ENGINE;
  let source = 'default';

  if (isTestContext && isEngine(testOverride)) {
    desired = testOverride;
    source = 'test_override';
  } else if (isDevelopment && isEngine(developerOverride)) {
    desired = developerOverride;
    source = 'developer_override';
  } else if (rollout && rollout.eligible === true) {
    desired = 'nativeDurable';
    source = 'remote_rollout';
  } else if (rollout && rollout.eligible === false && rollout.resolved === true) {
    // An authoritative remote "no" (including the kill switch) beats the
    // build-time cohort flag, so a revoke works without a rebuild.
    return decide('legacy', 'remote_rollout', rollout.reason ?? null);
  } else if (dogfoodEnabled === true) {
    if (!eligibilityResolved) return decide('legacy', 'default', 'eligibility_unavailable');
    desired = 'nativeDurable';
    source = 'internal_dogfood';
  } else if (rollout && rollout.resolved === false) {
    return decide('legacy', 'default', rollout.reason ?? 'eligibility_unavailable');
  } else if (!eligibilityResolved) {
    return decide('legacy', 'default', 'eligibility_unavailable');
  }

  if (desired !== 'nativeDurable') return decide('legacy', source);

  const reason = nativeUnavailableReason(capability);
  if (reason) return decide('legacy', source, reason);
  return decide('nativeDurable', source);
}

/**
 * Which engine must handle an existing durable session.
 *
 * Recovery follows the durable session's own provenance, never the current
 * rollout status. Disabling rollout (or tripping the kill switch) must never
 * redirect native audio into the legacy recorder, which cannot read it.
 */
export function resolveRecoveryEngine(input = {}) {
  const { hasDurableEvidence = false } = input;
  if (hasDurableEvidence !== true) return { engine: DEFAULT_RECORDING_ENGINE, overrodeRollout: false };
  return { engine: 'nativeDurable', overrodeRollout: true };
}

/**
 * THE single runtime engine decision. Combines media ownership
 * (resolveRecoveryEngine — recoverable durable evidence always wins) with
 * rollout/dogfood policy (resolveRecordingEngineDecision — applies only
 * when no durable ownership is established). This is the one function
 * useLectureRecorder calls; it must never re-implement either piece of
 * policy itself (see the cross-engine recovery audit this fixes: a real
 * lecture accumulated a 96-minute durable session that a later legacy
 * resume silently ignored because engine selection never checked for it).
 *
 *   1. An in-flight session keeps its already-chosen engine (unchanged).
 *   2. Recoverable durable media for THIS lectureId wins outright — the
 *      rollout/dogfood/override machinery is not consulted at all.
 *   3. Otherwise, the existing rollout policy decides exactly as before.
 *
 * `hasDurableEvidence` must reflect a live lookup against the durable
 * recorder's own session store (by lectureId, segments present) — the
 * persisted `recordingEngine` field on the lecture record is NOT reliable
 * evidence: a later legacy write can overwrite it while the durable
 * session itself sits untouched on disk.
 */
export function resolveRecordingEngineOwnershipDecision(input = {}) {
  const { hasDurableEvidence = false, frozenEngine = null, ...policyInput } = input;
  if (isEngine(frozenEngine)) {
    return { engine: frozenEngine, source: 'frozen_session', fallbackReason: null, retainNativeRecovery: hasDurableEvidence === true };
  }
  if (hasDurableEvidence === true) {
    const ownership = resolveRecoveryEngine({ hasDurableEvidence: true });
    return { engine: ownership.engine, source: 'durable_ownership', fallbackReason: null, retainNativeRecovery: true };
  }
  return resolveRecordingEngineDecision({ ...policyInput, hasDurableEvidence: false, frozenEngine: null });
}
