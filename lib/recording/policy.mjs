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

/**
 * Recoverable durable sessions, for lectures OTHER than `excludeLectureId`,
 * that represent real unresolved captured audio — not just any
 * `recoverable === true` husk. A session abandoned at the permission prompt
 * (created, zero segments) is not something worth protecting a fresh
 * recording from; requiring at least one committed segment scopes this to
 * sessions an owner would actually want back.
 *
 * Used by the P0 identity-safety guard: before a param-less `/recording`
 * mount is allowed to silently create a brand-new lecture+session, this
 * checks whether doing so would orphan a real, still-unresolved recording
 * elsewhere. See recording.tsx's cross-lecture recovery check.
 */
export function unresolvedRecoverableSessions(sessions, excludeLectureId) {
  return (sessions ?? [])
    .filter((session) => session
      && session.lectureId !== excludeLectureId
      && session.recoverable === true
      && session.state !== 'finalized'
      && (session.segments?.length ?? 0) > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.recordingSessionId.localeCompare(b.recordingSessionId));
}

/**
 * Real incident (2026-09-11): `unresolvedRecoverableSessions` above is pure
 * native-session math — it has no idea a session's owning lecture was
 * already deleted by the owner. Deleting a lecture is a local/JS-side
 * soft-delete only; it never touches the native durable session, which
 * stays `recoverable: true` with its committed segments forever. Seven such
 * already-deleted-owner sessions kept tripping "you have more than one
 * unfinished recording" even though every one of them had already been
 * resolved (deleted) by the owner.
 *
 * This is the classification layer that closes that gap, inserted BEFORE
 * the ambiguous/single-match decision. `lookupLectureById(lectureId)` must
 * return `{ deletedAt, status } | undefined` — undefined means "no local
 * record of this lecture could be found anywhere on this device" (either a
 * genuinely brand-new session whose first JS-side autosave hasn't landed
 * yet, or a session from an account this lookup could not reach). Per the
 * safety invariant, undefined is treated as UNKNOWN and stays protected
 * (kept in the blocking set) — this function only ever REMOVES a candidate
 * when it can prove, from real persisted lecture metadata, that the lecture
 * is already resolved. It never guesses (no course-title/name matching, no
 * age-based heuristics).
 *
 * Native sessions themselves are never touched here — this is classification
 * only, over the same raw list `unresolvedRecoverableSessions` already
 * returns.
 */
export function classifyUnresolvedSessions(sessions, excludeLectureId, lookupLectureById) {
  const candidates = unresolvedRecoverableSessions(sessions, excludeLectureId);
  return candidates.filter((session) => {
    const known = lookupLectureById ? lookupLectureById(session.lectureId) : undefined;
    if (!known) return true; // UNKNOWN — stays protected.
    if (known.deletedAt) return false; // Explicitly deleted — resolved, drop.
    if (known.status !== 'in_progress') return false; // Already finished — resolved, drop.
    return true; // A real, still-unresolved, non-deleted, in-progress lecture — keep blocking.
  });
}

/**
 * P0 (2026-09-12): recovery belongs to a COURSE, not the whole account.
 * Applied AFTER classifyUnresolvedSessions, over the SAME still-blocking
 * candidates — never a replacement for that classification, an additional
 * narrowing. A native `DurableRecordingSession` never carries its own
 * courseId (only `lectureId`), so a candidate can only be proven to belong
 * to `courseId` via its own ACTIVE (never deleted — those are already
 * dropped above) lecture record's canonical `courseId` field. Exact id
 * match only — never title/name (the same-name-course ownership bugs this
 * app has already been burned by once). A candidate whose lecture isn't in
 * `activeLectures` at all (UNKNOWN ownership: not yet autosaved locally, or
 * belonging to another signed-out account) cannot be proven to belong to
 * ANY course and is therefore excluded here too — it stays fully preserved
 * and recoverable on disk (nothing here deletes or mutates it), it simply
 * stops being able to block every course's "Start New Lecture" the way an
 * un-scoped candidate used to.
 */
export function courseScopedUnresolvedSessions(blockingSessions, activeLectures, courseId) {
  const courseIdByLectureId = new Map((activeLectures ?? []).map((lecture) => [lecture.id, lecture.courseId]));
  return (blockingSessions ?? []).filter((session) => courseIdByLectureId.get(session?.lectureId) === courseId);
}

/**
 * The native durable-session store is scoped to the installed app container,
 * not to a Cloud Library account.  A recoverable session is therefore allowed
 * into normal active recovery only when its immutable lectureId is present in
 * the current account's active, in-progress lecture set.  This is deliberately
 * an exact-ID ownership boundary: a title, timestamp, filename, or an absent
 * local lecture record is never evidence that a historical session belongs to
 * a newly-created lecture.
 *
 * Sessions outside that set remain physically preserved for forensic/manual
 * recovery, but are logically detached from normal recording creation and
 * recovery discovery.  In particular, a deleted lecture, a lecture whose
 * parent course is deleted, and another account's lecture cannot block or be
 * adopted by the current account.
 */
export function ownedUnresolvedRecoverableSessions(sessions, excludeLectureId, activeRecoveryLectureIds) {
  const ownedLectureIds = activeRecoveryLectureIds instanceof Set
    ? activeRecoveryLectureIds
    : new Set(activeRecoveryLectureIds ?? []);

  return unresolvedRecoverableSessions(sessions, excludeLectureId)
    .filter((session) => ownedLectureIds.has(session.lectureId));
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
  'build_default',
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
 * Strict parser for the release build's default engine
 * (`EXPO_PUBLIC_RECORDING_DEFAULT_ENGINE`).
 *
 * Only the exact string `nativeDurable` selects a build default. Absent, empty,
 * `legacy`, differently-cased, padded, truthy-looking or unknown values all
 * resolve to null, i.e. NO build default, so a typo can never silently choose an
 * engine — it leaves the existing legacy behavior in place.
 */
export function parseBuildDefaultEngine(raw) {
  return raw === 'nativeDurable' ? 'nativeDurable' : null;
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
    buildDefaultEngine = null,
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
  } else if (buildDefaultEngine === 'nativeDurable') {
    // The release build's own default. Deliberately independent of remote state: a missing, unresolved or failed
    // rollout lookup must not downgrade it (only an authoritative, resolved remote "no" above can). It reaches here
    // only after the frozen-session, guest (forceLegacy), test and developer-override rules have been applied.
    desired = 'nativeDurable';
    source = 'build_default';
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
