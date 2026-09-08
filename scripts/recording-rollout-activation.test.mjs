import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  evaluateRollout,
  parseRolloutRecord,
  ROLLOUT_REASONS,
} from '../lib/recording/rolloutPolicy.mjs';
import {
  resolveRecordingEngineDecision,
  resolveRecoveryEngine,
} from '../lib/recording/policy.mjs';
import { createRequestDeduper } from '../lib/recording/requestDedupe.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const gate = await read('../lib/recording/featureGate.ts');
const hook = await read('../lib/recording/useRolloutEligibility.ts');
const provider = await read('../lib/recording/rolloutProvider.ts');
const facade = await read('../lib/useLectureRecorder.ts');
const screen = await read('../app/recording.tsx');
const envExample = await read('../.env.example');

// --- A. Activation gate ------------------------------------------------------

assert.match(
  gate,
  /REMOTE_ROLLOUT_ENABLED =\s*process\.env\.EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE === '1'/,
  'the activation gate is a strict equality check against the exact string 1',
);
// Strictness: absent, '0', 'true', 'yes' must all be false. A === '1' check
// gives exactly that; anything looser (truthiness, Boolean(), !== '0') would not.
assert.doesNotMatch(gate, /EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE\s*!==\s*'0'/, 'must not be an inverted check');
assert.doesNotMatch(gate, /Boolean\(process\.env\.EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE\)/, 'must not be a truthiness check');

// The committed default must be disabled.
assert.doesNotMatch(
  envExample,
  /EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE\s*=\s*1/,
  'the example env must never enable remote rollout',
);
assert.match(envExample, /EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE=0/, 'the flag is documented as disabled');

// No public toggle: the gate is a single `export const` and is never reassigned.
const gateAssignments = [...gate.matchAll(/REMOTE_ROLLOUT_ENABLED\s*=[^=]/g)];
assert.equal(gateAssignments.length, 1, 'the gate is assigned exactly once, at its declaration');
assert.match(gate, /export const REMOTE_ROLLOUT_ENABLED =/, 'the gate is an immutable const');
for (const [name, source] of [['hook', hook], ['provider', provider], ['facade', facade], ['screen', screen]]) {
  assert.doesNotMatch(source, /REMOTE_ROLLOUT_ENABLED\s*=[^=]/, `${name} must never reassign the gate`);
}
assert.doesNotMatch(screen, /setDeveloperRecordingEngineOverride|EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE/,
  'no screen exposes the rollout gate');

// --- Default no-query proof --------------------------------------------------

// The hook must return before any fetch when the gate is off. Assert the guard
// precedes every call site of the fetching helper.
const guardIndex = hook.indexOf('if (!REMOTE_ROLLOUT_ENABLED)');
assert.ok(guardIndex > 0, 'the hook guards on the activation gate');
const fetchIndex = hook.indexOf('dedupedFetch(userId)');
assert.ok(fetchIndex > guardIndex, 'the gate check precedes the fetch');
assert.match(
  hook.slice(guardIndex, fetchIndex),
  /return;/,
  'the disabled branch returns before reaching a request',
);
assert.match(hook, /return REMOTE_ROLLOUT_ENABLED \? eligibility : null/,
  'a disabled gate always yields null regardless of state');

// The recording screen must never call Supabase directly.
assert.doesNotMatch(screen, /supabase|from\('recording_engine_rollout'\)/,
  'the screen never queries Supabase for rollout');
assert.match(screen, /useRolloutEligibility\(/, 'the screen resolves rollout through the guarded hook');
assert.match(screen, /rollout\b/, 'the screen passes rollout into the recorder facade');

// Provider queries live only in the provider.
assert.match(provider, /\.from\(ROLLOUT_TABLE\)/);
assert.doesNotMatch(facade, /\.from\(/, 'the facade contains no query');

// --- B. Integration behaviour (through the pure policy) ----------------------

const NOW = Date.parse('2026-07-19T12:00:00Z');
const eligible = evaluateRollout({
  fetch: parseRolloutRecord(
    { engine: 'nativeDurable', enabled: true, cohort: 'internal', expires_at: '2026-08-19T12:00:00Z' },
    { now: NOW },
  ),
});
const revoked = evaluateRollout({
  fetch: parseRolloutRecord({ engine: 'legacy', enabled: false, cohort: 'disabled' }, { now: NOW }),
});

// Default committed state: rollout is null (gate off) → legacy.
assert.equal(resolveRecordingEngineDecision({ rollout: null }).engine, 'legacy');
assert.equal(resolveRecordingEngineDecision({}).engine, 'legacy');

// Enabled + eligible → native; enabled + ineligible → legacy.
assert.equal(resolveRecordingEngineDecision({ rollout: eligible }).engine, 'nativeDurable');
assert.equal(resolveRecordingEngineDecision({ rollout: revoked }).engine, 'legacy');

// A pending decision (null) must never enable native.
assert.equal(resolveRecordingEngineDecision({ rollout: null, dogfoodEnabled: false }).engine, 'legacy');

// --- E. Pre-deployment / failure behaviour -----------------------------------

for (const reason of ['rollout_infrastructure_unavailable', 'rollout_timed_out', 'rollout_unauthorized', 'rollout_fetch_failed']) {
  assert.ok(ROLLOUT_REASONS.includes(reason), `${reason} is a stable reason code`);
  const failed = evaluateRollout({
    fetch: { status: 'unavailable', reason, engine: 'legacy', cohort: null, revision: null },
    cache: null,
  });
  assert.equal(failed.eligible, false, `${reason} must fall closed`);
  const decision = resolveRecordingEngineDecision({ rollout: failed });
  assert.equal(decision.engine, 'legacy');
  assert.equal(decision.fallbackReason, reason, 'the stable reason survives to the decision');
}

// Missing table is classified, and the raw message never escapes.
assert.match(provider, /export function classifyRolloutError/, 'errors are classified at the provider boundary');
assert.match(provider, /does not exist|PGRST205|42P01/, 'a missing table is recognised');
assert.doesNotMatch(provider, /logRecordingEvent\([^)]*error\.message/, 'raw backend errors are never logged');
assert.doesNotMatch(provider, /Alert|setError\(.*error\.message/, 'no database error reaches the UI');
assert.match(provider, /ROLLOUT_FETCH_TIMEOUT_MS/, 'the request is bounded by a timeout');

// --- C. Recovery precedence over every rollout state -------------------------

const killSwitch = evaluateRollout({ killSwitch: true });
const unavailable = evaluateRollout({
  fetch: { status: 'unavailable', reason: 'rollout_infrastructure_unavailable', engine: 'legacy', cohort: null, revision: null },
  cache: null,
});
for (const [label, rollout] of [
  ['default/disabled', null],
  ['remote revoked', revoked],
  ['kill switch', killSwitch],
  ['timed out', evaluateRollout({ fetch: { status: 'unavailable', reason: 'rollout_timed_out', engine: 'legacy', cohort: null, revision: null }, cache: null })],
  ['table missing', unavailable],
]) {
  assert.equal(
    resolveRecordingEngineDecision({ rollout, hasDurableEvidence: true }).retainNativeRecovery,
    true,
    `${label} must still retain native recovery`,
  );
  assert.equal(resolveRecoveryEngine({ hasDurableEvidence: true }).engine, 'nativeDurable');
}

// --- D. Active-session freeze ------------------------------------------------

assert.equal(
  resolveRecordingEngineDecision({ rollout: revoked, frozenEngine: 'nativeDurable' }).engine,
  'nativeDurable',
  'a remote revoke cannot switch an active native recording',
);
assert.equal(
  resolveRecordingEngineDecision({ rollout: killSwitch, frozenEngine: 'nativeDurable' }).engine,
  'nativeDurable',
  'the kill switch cannot switch an active native recording',
);
assert.equal(
  resolveRecordingEngineDecision({ rollout: eligible, frozenEngine: 'legacy' }).engine,
  'legacy',
  'an eligible refresh cannot switch an active legacy recording',
);
assert.equal(resolveRecordingEngineDecision({ rollout: eligible, frozenEngine: 'legacy' }).source, 'frozen_session');

// The freeze must actually be wired, not just implemented.
assert.match(facade, /frozenEngineRef/, 'the facade holds a frozen engine ref');
assert.match(facade, /frozenEngine: frozenEngineRef\.current/, 'the frozen engine feeds the policy');
assert.match(
  facade,
  /if \(decision && frozenEngineRef\.current === null\) frozenEngineRef\.current = decision\.engine/,
  'the engine is frozen on first resolution and never reassigned afterwards ' +
    '(decision can be null only while the durable-ownership lookup has not resolved yet, ' +
    'in which case nothing freezes)',
);

// --- Stale results and deduplication ----------------------------------------

assert.match(hook, /generationRef/, 'requests carry a generation token');
assert.match(hook, /generation !== generationRef\.current/, 'superseded results are discarded');
assert.match(hook, /rollout_resolution_ignored_as_stale/, 'stale results are reported');
assert.match(hook, /if \(authLoading\) return;/, 'resolution waits for auth to settle');
assert.match(hook, /if \(!userId\)/, 'a signed-out user resolves without a request');
assert.match(hook, /createRequestDeduper\(\)/, 'in-flight requests are deduplicated per user');
assert.match(hook, /deduper\.run\(/, 'the fetch goes through the deduper');
assert.match(hook, /\[userId, authLoading\]/, 'resolution re-runs only on identity change');

// Behavioural deduplication: concurrent callers share one request, and a
// different user never reuses another user's in-flight result.
{
  const deduper = createRequestDeduper();
  let calls = 0;
  let deduplicated = 0;
  let resolveA;
  const start = () => {
    calls += 1;
    return new Promise((resolve) => { resolveA = resolve; });
  };

  const first = deduper.run('user-a', start, () => { deduplicated += 1; });
  const second = deduper.run('user-a', start, () => { deduplicated += 1; });
  assert.equal(calls, 1, 'a concurrent second call must not start a new request');
  assert.equal(deduplicated, 1, 'the reuse is reported');
  assert.equal(first, second, 'both callers receive the same promise');

  // A different user must get its own request, never the first user's.
  const other = deduper.run('user-b', () => Promise.resolve('b-result'), () => {});
  assert.notEqual(other, first, 'a different user never reuses another request');
  assert.equal(deduper.size(), 2);

  resolveA('a-result');
  assert.equal(await first, 'a-result');
  await other;
  // Once settled the key is released, so a later session can refetch.
  assert.equal(deduper.size(), 0, 'settled requests are released');

  const third = deduper.run('user-a', start, () => { deduplicated += 1; });
  assert.equal(calls, 2, 'a new session after settling starts a fresh request');
  resolveA('later');
  await third;

  // A synchronous throw must not wedge the key permanently.
  const failing = deduper.run('user-c', () => { throw new Error('boom'); }, () => {});
  await failing.catch(() => {});
  assert.equal(deduper.size(), 0, 'a failed request is released');
}

// --- F. Privacy / security ---------------------------------------------------

for (const [name, source] of [['hook', hook], ['provider', provider]]) {
  assert.doesNotMatch(source, /SERVICE_ROLE|service_role/, `${name} contains no service-role secret`);
  assert.doesNotMatch(source, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, `${name} contains no email`);
  assert.doesNotMatch(source, /logRecordingEvent\([^)]*userId/, `${name} never logs a raw user id`);
}
// Rollout must never consult billing state.
for (const source of [gate, hook, provider, facade]) {
  assert.doesNotMatch(source, /entitlement|purchase|studentbasic|subscription|quota/i,
    'rollout must not depend on billing or entitlement state');
}

console.log('Rollout activation wiring tests passed.');
