import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ROLLOUT_CACHE_TTL_MS,
  ROLLOUT_COHORTS,
  ROLLOUT_REASONS,
  cacheAgeBucket,
  evaluateRollout,
  parseRolloutRecord,
  readCachedRollout,
} from '../lib/recording/rolloutPolicy.mjs';
import {
  resolveRecordingEngineDecision,
  resolveRecoveryEngine,
} from '../lib/recording/policy.mjs';

const NOW = Date.parse('2026-07-19T12:00:00Z');
const future = '2026-08-19T12:00:00Z';
const past = '2026-06-19T12:00:00Z';
const nativeRow = { engine: 'nativeDurable', enabled: true, cohort: 'internal', expires_at: future, rollout_revision: 3 };

// --- A. Provider parsing -----------------------------------------------------

assert.equal(parseRolloutRecord(nativeRow, { now: NOW }).status, 'eligible');
assert.equal(parseRolloutRecord(nativeRow, { now: NOW }).cohort, 'internal');
assert.equal(parseRolloutRecord(nativeRow, { now: NOW }).revision, 3);

// 2. Remote config success: legacy.
assert.equal(parseRolloutRecord({ ...nativeRow, engine: 'legacy' }, { now: NOW }).status, 'not_eligible');
assert.equal(parseRolloutRecord({ ...nativeRow, enabled: false }, { now: NOW }).reason, 'rollout_disabled');
assert.equal(parseRolloutRecord({ ...nativeRow, cohort: 'disabled' }, { now: NOW }).status, 'not_eligible');

// 3. Remote config missing.
assert.equal(parseRolloutRecord(null, { now: NOW }).status, 'unavailable');
assert.equal(parseRolloutRecord(undefined, { now: NOW }).reason, 'rollout_record_missing');

// 4. Remote config malformed — strict parsing, unknown values fail closed.
for (const bad of [
  { ...nativeRow, engine: 'somethingElse' },
  { ...nativeRow, engine: null },
  { ...nativeRow, enabled: 'true' },
  { ...nativeRow, enabled: 1 },
  { ...nativeRow, cohort: 'everyone' },
  { ...nativeRow, expires_at: 'not-a-date' },
  { ...nativeRow, rollout_revision: 1.5 },
  { ...nativeRow, rollout_revision: 'three' },
  'a string',
  [nativeRow],
  42,
]) {
  const parsed = parseRolloutRecord(bad, { now: NOW });
  assert.equal(parsed.status, 'invalid', `malformed config must be invalid: ${JSON.stringify(bad)}`);
  assert.equal(parsed.engine, 'legacy', 'malformed config never yields native');
}

// A record with no expiry is allowed.
assert.equal(parseRolloutRecord({ engine: 'nativeDurable', enabled: true, cohort: 'internal' }, { now: NOW }).status, 'eligible');

// Expired record.
assert.equal(parseRolloutRecord({ ...nativeRow, expires_at: past }, { now: NOW }).status, 'expired');
assert.equal(parseRolloutRecord({ ...nativeRow, expires_at: past }, { now: NOW }).engine, 'legacy');
// Expiry exactly at now counts as expired.
assert.equal(parseRolloutRecord({ ...nativeRow, expires_at: new Date(NOW).toISOString() }, { now: NOW }).status, 'expired');

for (const reason of ROLLOUT_REASONS) assert.equal(typeof reason, 'string');
assert.deepEqual([...ROLLOUT_COHORTS], ['disabled', 'internal', 'limited_beta']);

// --- B. Cache ----------------------------------------------------------------

const entry = (overrides = {}) => ({
  subject: 'user-a',
  fetchedAt: new Date(NOW - 60_000).toISOString(),
  record: nativeRow,
  ...overrides,
});

// 9. Valid unexpired native cache.
const fresh = readCachedRollout(entry(), { now: NOW, subject: 'user-a' });
assert.equal(fresh.status, 'eligible');
assert.equal(cacheAgeBucket(fresh.ageMs), '1-5m');

// 10. Valid unexpired legacy cache.
assert.equal(
  readCachedRollout(entry({ record: { ...nativeRow, enabled: false } }), { now: NOW, subject: 'user-a' }).status,
  'not_eligible',
);

// 8. Expired cache must never enable native.
const stale = readCachedRollout(
  entry({ fetchedAt: new Date(NOW - ROLLOUT_CACHE_TTL_MS - 1000).toISOString() }),
  { now: NOW, subject: 'user-a' },
);
assert.equal(stale.status, 'expired');
assert.equal(stale.reason, 'rollout_cache_expired');

// 11. No cross-account leakage: another user's entry is rejected outright.
const foreign = readCachedRollout(entry({ subject: 'user-b' }), { now: NOW, subject: 'user-a' });
assert.equal(foreign.status, 'invalid');
assert.equal(foreign.reason, 'rollout_cache_foreign');
// Signed out (no subject) can never match a cached entry.
assert.equal(readCachedRollout(entry(), { now: NOW, subject: null }).reason, 'rollout_cache_foreign');

// Invalid cache shapes.
for (const bad of [null, undefined, 'x', [], { subject: 'user-a' }, entry({ fetchedAt: 'nope' })]) {
  const parsed = readCachedRollout(bad, { now: NOW, subject: 'user-a' });
  assert.notEqual(parsed.status, 'eligible', 'invalid cache can never enable native');
}
// A clock moving backwards must not extend cache life.
assert.equal(readCachedRollout(entry({ fetchedAt: new Date(NOW + 60_000).toISOString() }), { now: NOW, subject: 'user-a' }).status, 'expired');

// Deterministic: identical inputs give identical output.
assert.deepEqual(
  readCachedRollout(entry(), { now: NOW, subject: 'user-a' }),
  readCachedRollout(entry(), { now: NOW, subject: 'user-a' }),
);

// --- Failure matrix via evaluateRollout --------------------------------------

const eligibleFetch = parseRolloutRecord(nativeRow, { now: NOW });
const unavailableFetch = { status: 'unavailable', reason: 'rollout_fetch_failed', engine: 'legacy', cohort: null, revision: null };

// 1. Remote success, eligible.
assert.equal(evaluateRollout({ fetch: eligibleFetch }).eligible, true);
// 12. Rollout revoked remotely — remote wins over a still-valid native cache.
assert.equal(
  evaluateRollout({ fetch: parseRolloutRecord({ ...nativeRow, enabled: false }, { now: NOW }), cache: fresh }).eligible,
  false,
  'a remote revoke beats an unexpired native cache',
);
// 13. Kill switch wins over everything.
const killed = evaluateRollout({ killSwitch: true, fetch: eligibleFetch, cache: fresh });
assert.equal(killed.eligible, false);
assert.equal(killed.reason, 'rollout_kill_switch');
assert.equal(killed.source, 'kill_switch');

// 5/6/7. Network timeout, backend unavailable, unauthorized: cache may be used.
assert.equal(evaluateRollout({ fetch: unavailableFetch, cache: fresh }).eligible, true, 'unexpired cache survives an outage');
assert.equal(evaluateRollout({ fetch: unavailableFetch, cache: fresh }).source, 'cache');
assert.equal(evaluateRollout({ fetch: unavailableFetch, cache: stale }).eligible, false, 'expired cache cannot enable native');
assert.equal(evaluateRollout({ fetch: unavailableFetch, cache: foreign }).eligible, false, 'foreign cache cannot enable native');
assert.equal(evaluateRollout({ fetch: unavailableFetch, cache: null }).eligible, false);
assert.equal(evaluateRollout({}).eligible, false, 'no data at all means legacy');

// --- C. Selection policy -----------------------------------------------------

const eligible = evaluateRollout({ fetch: eligibleFetch });
const revoked = evaluateRollout({ fetch: parseRolloutRecord({ ...nativeRow, enabled: false }, { now: NOW }) });

assert.equal(resolveRecordingEngineDecision({ rollout: eligible }).engine, 'nativeDurable');
assert.equal(resolveRecordingEngineDecision({ rollout: eligible }).source, 'remote_rollout');
assert.equal(resolveRecordingEngineDecision({ rollout: revoked }).engine, 'legacy');

// A remote revoke beats the build-time dogfood flag, so revoking needs no rebuild.
assert.equal(
  resolveRecordingEngineDecision({ rollout: revoked, dogfoodEnabled: true }).engine,
  'legacy',
  'remote disable overrides the build-time cohort flag',
);
assert.equal(
  resolveRecordingEngineDecision({ rollout: evaluateRollout({ killSwitch: true }), dogfoodEnabled: true }).engine,
  'legacy',
  'the kill switch stops new native sessions even for the dogfood cohort',
);
assert.equal(
  resolveRecordingEngineDecision({ rollout: evaluateRollout({ killSwitch: true }), dogfoodEnabled: true }).fallbackReason,
  'rollout_kill_switch',
);

// An unresolved provider falls closed, but the build-time flag still applies.
const unresolved = evaluateRollout({ fetch: unavailableFetch, cache: null });
assert.equal(resolveRecordingEngineDecision({ rollout: unresolved }).engine, 'legacy');
assert.equal(resolveRecordingEngineDecision({ rollout: unresolved }).fallbackReason, 'rollout_fetch_failed');
assert.equal(resolveRecordingEngineDecision({ rollout: unresolved, dogfoodEnabled: true }).engine, 'nativeDurable');

// 18/19. Native unavailable despite eligibility.
assert.equal(
  resolveRecordingEngineDecision({ rollout: eligible, capability: { moduleAvailable: false } }).fallbackReason,
  'native_module_unavailable',
);
assert.equal(
  resolveRecordingEngineDecision({ rollout: eligible, capability: { initialized: false } }).fallbackReason,
  'native_initialization_failed',
);

// Guests are never routed to native, whatever rollout says.
assert.equal(resolveRecordingEngineDecision({ rollout: eligible, forceLegacy: true }).engine, 'legacy');

// 14. Config changing during an active recording cannot switch engines.
const frozen = resolveRecordingEngineDecision({ rollout: revoked, frozenEngine: 'nativeDurable' });
assert.equal(frozen.engine, 'nativeDurable', 'an in-flight session keeps its engine');
assert.equal(frozen.source, 'frozen_session');
assert.equal(
  resolveRecordingEngineDecision({ rollout: eligible, frozenEngine: 'legacy' }).engine,
  'legacy',
  'a legacy session is not switched to native mid-recording',
);
assert.equal(
  resolveRecordingEngineDecision({ rollout: evaluateRollout({ killSwitch: true }), frozenEngine: 'nativeDurable' }).engine,
  'nativeDurable',
  'the kill switch does not interrupt an active native recording',
);
// An invalid frozen value is ignored rather than trusted.
assert.equal(resolveRecordingEngineDecision({ rollout: eligible, frozenEngine: 'bogus' }).engine, 'nativeDurable');

// --- Recovery precedence (15, 16, 17, 20) ------------------------------------

// Durable audio stays reachable no matter what rollout says.
for (const rollout of [revoked, evaluateRollout({ killSwitch: true }), unresolved]) {
  assert.equal(
    resolveRecordingEngineDecision({ rollout, hasDurableEvidence: true }).retainNativeRecovery,
    true,
    'rollout state must never hide durable native audio',
  );
}
assert.equal(resolveRecoveryEngine({ hasDurableEvidence: true }).engine, 'nativeDurable');
assert.equal(
  resolveRecoveryEngine({ hasDurableEvidence: true }).overrodeRollout,
  true,
  'native recovery overrides rollout disablement',
);
assert.equal(resolveRecoveryEngine({ hasDurableEvidence: false }).engine, 'legacy');
assert.equal(resolveRecoveryEngine({}).overrodeRollout, false);

// --- D. Security / privacy ---------------------------------------------------

const provider = await readFile(new URL('../lib/recording/rolloutProvider.ts', import.meta.url), 'utf8');
assert.doesNotMatch(provider, /SERVICE_ROLE|service_role|serviceRole/, 'no service-role secret in the client');
assert.match(provider, /\.eq\('user_id', userId\)/, 'the client only ever reads its own row');
assert.doesNotMatch(provider, /\.(insert|update|upsert|delete)\(/, 'the client has no rollout write path');
assert.match(provider, /youmi\.recordingRollout\.v1\.\$\{userId\}/, 'cache key is scoped per user');
assert.match(provider, /clearRolloutCache/, 'sign-out can clear the cached decision');
// The raw backend error body must never be logged.
assert.doesNotMatch(provider, /logRecordingEvent\([^)]*error\.message/, 'raw backend responses are never logged');

const app = await readFile(new URL('../app/recording.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(app, /recording_engine_rollout|setDeveloperRecordingEngineOverride/, 'no public rollout toggle');

console.log('Recording rollout control tests passed.');
