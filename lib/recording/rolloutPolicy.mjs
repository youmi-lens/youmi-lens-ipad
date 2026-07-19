/**
 * Phase 4 — per-user rollout evaluation.
 *
 * Pure and deterministic: parsing, expiry, cache validity and kill-switch
 * handling all live here so the whole failure matrix is testable without a
 * network, a device, or a backend.
 *
 * Every unknown, malformed or missing input resolves to "not eligible", so a
 * broken rollout config can only ever leave users on the legacy recorder.
 */

/** Rollout cohorts. Percentage bucketing is deliberately not supported. */
export const ROLLOUT_COHORTS = Object.freeze(['disabled', 'internal', 'limited_beta']);

/** Stable, non-identifying reasons a rollout did not grant native. */
export const ROLLOUT_REASONS = Object.freeze([
  'rollout_record_missing',
  'rollout_disabled',
  'rollout_expired',
  'rollout_invalid_config',
  'rollout_kill_switch',
  'rollout_fetch_failed',
  'rollout_unauthorized',
  'rollout_cache_expired',
  'rollout_cache_foreign',
]);

export const ROLLOUT_STATUSES = Object.freeze([
  'eligible',
  'not_eligible',
  'unavailable',
  'expired',
  'invalid',
]);

/**
 * Short by design. This is a dogfood control, and the TTL is the upper bound on
 * how long a remote disable or kill switch takes to reach a running app. Longer
 * TTLs would make a revoke feel unresponsive; shorter ones would add request
 * load for no benefit while the cohort is small.
 */
export const ROLLOUT_CACHE_TTL_MS = 15 * 60 * 1000;

const ENGINES = ['legacy', 'nativeDurable'];

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function result(status, extra = {}) {
  return {
    status,
    engine: extra.engine ?? 'legacy',
    cohort: extra.cohort ?? null,
    revision: extra.revision ?? null,
    reason: extra.reason ?? null,
  };
}

/**
 * Strictly parses one rollout record. Anything unexpected is invalid rather
 * than best-effort, so a partially-written row cannot enable native.
 */
export function parseRolloutRecord(raw, options = {}) {
  const now = options.now ?? Date.now();

  if (raw === null || raw === undefined) {
    return result('unavailable', { reason: 'rollout_record_missing' });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return result('invalid', { reason: 'rollout_invalid_config' });
  }

  const { engine, enabled, cohort, expires_at: expiresAt, rollout_revision: revision } = raw;

  if (typeof enabled !== 'boolean') return result('invalid', { reason: 'rollout_invalid_config' });
  if (!ENGINES.includes(engine)) return result('invalid', { reason: 'rollout_invalid_config' });
  if (cohort !== null && cohort !== undefined && !ROLLOUT_COHORTS.includes(cohort)) {
    return result('invalid', { reason: 'rollout_invalid_config' });
  }
  if (revision !== null && revision !== undefined && !Number.isInteger(revision)) {
    return result('invalid', { reason: 'rollout_invalid_config' });
  }
  // Absent expiry is allowed; a present but unparseable one is not.
  if (expiresAt !== null && expiresAt !== undefined && !isIsoTimestamp(expiresAt)) {
    return result('invalid', { reason: 'rollout_invalid_config' });
  }

  const normalized = {
    engine,
    cohort: cohort ?? null,
    revision: revision ?? null,
  };

  if (expiresAt && Date.parse(expiresAt) <= now) {
    return result('expired', { ...normalized, engine: 'legacy', reason: 'rollout_expired' });
  }
  if (enabled !== true || cohort === 'disabled') {
    return result('not_eligible', { ...normalized, engine: 'legacy', reason: 'rollout_disabled' });
  }
  if (engine !== 'nativeDurable') {
    return result('not_eligible', { ...normalized, reason: 'rollout_disabled' });
  }
  return result('eligible', normalized);
}

/** Coarse cache-age buckets. Exact ages are unnecessary for diagnostics. */
export function cacheAgeBucket(ageMs) {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
  if (ageMs < 60_000) return '<1m';
  if (ageMs < 5 * 60_000) return '1-5m';
  if (ageMs < 15 * 60_000) return '5-15m';
  return '>15m';
}

/**
 * Validates a cached decision. The cache is keyed per user, and the entry also
 * carries its subject so a mismatched entry is rejected rather than trusted —
 * defence in depth against cross-account leakage.
 */
export function readCachedRollout(entry, options = {}) {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? ROLLOUT_CACHE_TTL_MS;
  const subject = options.subject ?? null;

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ...result('unavailable', { reason: 'rollout_record_missing' }), ageMs: null };
  }
  if (!isIsoTimestamp(entry.fetchedAt)) {
    return { ...result('invalid', { reason: 'rollout_invalid_config' }), ageMs: null };
  }
  if (typeof entry.subject !== 'string' || entry.subject.length === 0 || entry.subject !== subject) {
    return { ...result('invalid', { reason: 'rollout_cache_foreign' }), ageMs: null };
  }

  const ageMs = now - Date.parse(entry.fetchedAt);
  if (ageMs < 0 || ageMs > ttlMs) {
    return { ...result('expired', { reason: 'rollout_cache_expired' }), ageMs };
  }

  const parsed = parseRolloutRecord(entry.record, { now });
  return { ...parsed, ageMs };
}

/**
 * Normalizes a rollout outcome into what the engine policy consumes.
 *
 * The kill switch is checked first and wins over any per-user record, so a
 * single remote change stops all new native sessions without a rebuild. It
 * never touches durable state — recovery precedence is handled by the engine
 * policy, not here.
 */
export function evaluateRollout(input = {}) {
  const {
    killSwitch = false,
    fetch: fetchOutcome = null,
    cache: cacheOutcome = null,
  } = input;

  if (killSwitch === true) {
    return { eligible: false, resolved: true, reason: 'rollout_kill_switch', cohort: null, revision: null, source: 'kill_switch' };
  }

  // A successful fetch always wins over cache.
  if (fetchOutcome && fetchOutcome.status !== 'unavailable') {
    if (fetchOutcome.status === 'eligible') {
      return {
        eligible: true,
        resolved: true,
        reason: null,
        cohort: fetchOutcome.cohort,
        revision: fetchOutcome.revision,
        source: 'remote',
      };
    }
    return {
      eligible: false,
      // An authoritative "no" is resolved; malformed config is not, but both
      // land on legacy so the distinction only matters for diagnostics.
      resolved: fetchOutcome.status !== 'invalid',
      reason: fetchOutcome.reason,
      cohort: fetchOutcome.cohort,
      revision: fetchOutcome.revision,
      source: 'remote',
    };
  }

  // Fetch unavailable (offline, timeout, unauthorized): an unexpired cached
  // decision may be reused. An expired or foreign cache may never enable native.
  if (cacheOutcome) {
    if (cacheOutcome.status === 'eligible') {
      return {
        eligible: true,
        resolved: true,
        reason: null,
        cohort: cacheOutcome.cohort,
        revision: cacheOutcome.revision,
        source: 'cache',
      };
    }
    return {
      eligible: false,
      resolved: cacheOutcome.status === 'not_eligible',
      reason: cacheOutcome.reason,
      cohort: cacheOutcome.cohort,
      revision: cacheOutcome.revision,
      source: 'cache',
    };
  }

  return {
    eligible: false,
    resolved: false,
    reason: fetchOutcome?.reason ?? 'rollout_fetch_failed',
    cohort: null,
    revision: null,
    source: 'none',
  };
}
