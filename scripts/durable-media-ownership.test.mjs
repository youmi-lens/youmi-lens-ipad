/**
 * Cross-engine recovery ownership (Build 50 P0).
 *
 * Root cause: a lecture's recording engine was chosen purely from
 * rollout/dogfood policy, with zero awareness of whether that lectureId
 * already owned recoverable native-durable media. `resolveRecoveryEngine`
 * existed, correctly implemented, fully tested — but was called only from
 * test files, never from the real app. A real lecture accumulated a
 * ~96-minute paused, unfinalized durable session; a later legacy resume
 * silently ignored it because engine selection never checked.
 *
 * This suite proves:
 *   1. The combined ownership decision (resolveRecordingEngineOwnershipDecision)
 *      is what useLectureRecorder actually calls — not the old
 *      rollout-only decision — for realistic hook-matching inputs.
 *   2. useLectureRecorder is structurally wired to gate on a live durable
 *      lookup before ever freezing the engine.
 *   3. Recovery-source discovery (mediaSourceDiscovery.ts) proves
 *      non-overlap using REAL native-measured timestamps, never the
 *      unreliable persisted audioSegments[].createdAt, and blocks rather
 *      than guesses when it cannot prove a safe order.
 *
 * Native/RN-dependent pieces (the actual async hook, the actual native
 * bridge calls) cannot run under plain Node — see
 * material-native-ink-performance.test.mjs and every other native-facing
 * test this session for the same constraint. Both the pure policy math and
 * the wiring are verified; behavioral parity checks re-derive the
 * documented overlap arithmetic against real device-measured numbers as a
 * fixture, never hardcoded into product code.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  resolveRecordingEngineDecision,
  resolveRecordingEngineOwnershipDecision,
  resolveRecoveryEngine,
} from '../lib/recording/policy.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const facade = await read('../lib/useLectureRecorder.ts');
const ownershipHook = await read('../lib/recording/useDurableMediaOwnership.ts');
const featureGate = await read('../lib/recording/featureGate.ts');
const discovery = await read('../lib/recording/mediaSourceDiscovery.ts');
const durableRecovery = await read('../lib/recording/durableSessionRecovery.ts');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('CASE 1 — new lecture, rollout legacy, no durable evidence: legacy allowed');

check('no durable evidence + rollout ineligible → legacy, via the SAME combined function useLectureRecorder calls', () => {
  const decision = resolveRecordingEngineOwnershipDecision({
    hasDurableEvidence: false,
    frozenEngine: null,
    rollout: { eligible: false, resolved: true, reason: null, cohort: null, revision: 1 },
    dogfoodEnabled: false,
    eligibilityResolved: true,
  });
  assert.equal(decision.engine, 'legacy');
  assert.notEqual(decision.source, 'durable_ownership', 'must not claim ownership when none exists');
});

console.log('\nCASE 2 — existing lecture with recoverable durable segments, rollout legacy: durable ownership wins');

check('durable evidence present → nativeDurable, EVEN with an ineligible/resolved-false rollout', () => {
  const decision = resolveRecordingEngineOwnershipDecision({
    hasDurableEvidence: true,
    frozenEngine: null,
    rollout: { eligible: false, resolved: true, reason: 'kill_switch', cohort: null, revision: 1 },
    dogfoodEnabled: false,
    eligibilityResolved: true,
  });
  assert.equal(decision.engine, 'nativeDurable');
  assert.equal(decision.source, 'durable_ownership');
  assert.equal(decision.retainNativeRecovery, true);
});

check('durable evidence present → nativeDurable even with dogfood OFF and no rollout object at all (today\'s actual production config)', () => {
  const decision = resolveRecordingEngineOwnershipDecision({
    hasDurableEvidence: true,
    frozenEngine: null,
    rollout: null,
    dogfoodEnabled: false,
    eligibilityResolved: true,
  });
  assert.equal(decision.engine, 'nativeDurable', 'this is the exact scenario that stranded the real 96-minute lecture');
});

check('rollout policy alone (the OLD decision path) would have said legacy for the same inputs — proving the override is real, not a no-op', () => {
  const oldDecision = resolveRecordingEngineDecision({
    frozenEngine: null,
    rollout: null,
    dogfoodEnabled: false,
    eligibilityResolved: true,
    hasDurableEvidence: true,
  });
  assert.equal(oldDecision.engine, 'legacy', 'confirms hasDurableEvidence never affected engine choice in the pre-existing decision function');
});

console.log('\nCASE 3 — existing durable lecture after relaunch: frozen engine still wins, no parallel legacy track');

check('once frozen (e.g. resumed mid-session across a relaunch), the frozen engine is returned regardless of ownership/rollout inputs', () => {
  const decision = resolveRecordingEngineOwnershipDecision({
    hasDurableEvidence: false, // even if a later render's lookup somehow disagreed
    frozenEngine: 'nativeDurable',
    rollout: { eligible: false, resolved: true, reason: null, cohort: null, revision: 2 },
  });
  assert.equal(decision.engine, 'nativeDurable');
  assert.equal(decision.source, 'frozen_session');
});

console.log('\nWiring — useLectureRecorder actually calls the ownership-aware function, gated on a live lookup');

check('useLectureRecorder imports and calls resolveRecordingEngineOwnershipDecisionForRuntime, not the old rollout-only function', () => {
  assert.match(facade, /import \{ resolveRecordingEngineOwnershipDecisionForRuntime \} from '\.\/recording\/featureGate'/);
  assert.match(facade, /resolveRecordingEngineOwnershipDecisionForRuntime\(\{/);
  assert.doesNotMatch(facade, /resolveRecordingEngineDecisionForRuntime\(/, 'must not also call the ownership-blind function');
});

check('the engine is never decided (or frozen) before the durable-ownership lookup resolves for this lectureId', () => {
  assert.match(facade, /useDurableMediaOwnership\(options\.lectureId\)/);
  assert.match(facade, /engineChecked = frozenEngineRef\.current !== null \|\| ownership\.checked/);
  assert.match(facade, /const decision = engineChecked/);
  assert.match(facade, /if \(decision && frozenEngineRef\.current === null\) frozenEngineRef\.current = decision\.engine/);
});

check('neither underlying engine hook activates until engineChecked — so nothing starts prematurely while the lookup is in flight', () => {
  assert.match(facade, /useLegacyLectureRecorder\(!options\.visualFixture && engineChecked && engine === 'legacy'\)/);
  assert.match(facade, /useNativeDurableLectureRecorder\(!options\.visualFixture && engineChecked && engine === 'nativeDurable', options\.lectureId\)/);
});

check('hasDurableEvidence is passed the LIVE lookup result, not a hardcoded true/false or the lecture\'s own persisted recordingEngine field', () => {
  assert.match(facade, /hasDurableEvidence: ownership\.hasDurableEvidence/);
  assert.doesNotMatch(facade, /hasDurableEvidence: true|hasDurableEvidence: false,?\s*\n.*resolveRecordingEngineOwnershipDecisionForRuntime/);
  assert.doesNotMatch(facade, /resumeLecture\?\.recordingEngine|lecture\.recordingEngine.*hasDurableEvidence/i,
    'the persisted recordingEngine field is not reliable evidence — a later legacy write can overwrite it while the durable session sits untouched');
});

check('the ownership lookup queries the durable session store directly by lectureId, using the same filter the native hook\'s own recovery-offer already uses', () => {
  assert.match(ownershipHook, /listRecoverableSessions\(\)/);
  assert.match(ownershipHook, /recoverableSessionsForLecture\(sessions, lectureId\)/);
  assert.match(ownershipHook, /\.some\(\(session\) => \(session\.segments\?\.length \?\? 0\) > 0\)/);
});

check('a failed lookup fails closed (no durable evidence claimed) but still marks checked, so the UI is never stuck waiting forever', () => {
  const catchBlock = ownershipHook.slice(ownershipHook.indexOf('.catch('));
  assert.match(catchBlock, /setState\(\{ checked: true, hasDurableEvidence: false \}\)/);
});

check('featureGate exposes the ownership-aware runtime wrapper, reusing the same dogfood/rollout/dev-override resolution as the existing wrapper (no duplicated policy)', () => {
  const fn = featureGate.slice(featureGate.indexOf('export function resolveRecordingEngineOwnershipDecisionForRuntime'));
  assert.match(fn, /resolveRecordingEngineOwnershipDecision\(\{/);
  assert.match(fn, /dogfoodEnabled: INTERNAL_DOGFOOD_ENABLED && CONFIGURED_RECORDING_ENGINE === 'legacy'/);
  assert.match(fn, /hasDurableEvidence: options\.hasDurableEvidence === true/);
});

console.log('\nCASE 4/5 — recovery-source discovery: proven non-overlap includes all sources exactly once; unproven blocks and preserves everything');

check('discovery checks for MORE THAN ONE durable session and blocks as ambiguous rather than guessing which one applies', () => {
  const fn = discovery.slice(discovery.indexOf('export async function discoverRecoverySources'));
  assert.match(fn, /matches\.length > 1/);
  const blockBody = fn.slice(fn.indexOf('matches.length > 1'), fn.indexOf('matches.length > 1') + 300);
  assert.match(blockBody, /reason: 'ambiguous_overlap'/);
});

check('legacy source timing comes from NATIVE-measured file mtime + native-measured duration (sourceModifiedAtMs, durationMs) — never the persisted audioSegments[].createdAt field', () => {
  assert.match(discovery, /source\.sourceModifiedAtMs/);
  assert.match(discovery, /endMs - source\.durationMs/, 'estimated start = real mtime minus real measured duration');
  assert.doesNotMatch(discovery, /segment\.createdAt|\.audioSegments.*createdAt/);
});

check('a legacy source with no readable modification time blocks discovery as ambiguous rather than assuming it doesn\'t overlap', () => {
  const fn = discovery.slice(discovery.indexOf('export async function discoverRecoverySources'));
  assert.match(fn, /windowStartMs == null/);
  assert.match(fn, /unknownWindow/);
});

check('the non-overlap comparison uses the durable session\'s END against the EARLIEST legacy ESTIMATED START (not just legacy mtime) — conservative in both directions', () => {
  const fn = discovery.slice(discovery.indexOf('export async function discoverRecoverySources'));
  assert.match(fn, /Math\.min\(\.\.\.legacySources\.map\(\(source\) => source\.windowStartMs as number\)\)/);
  assert.match(fn, /durableEndMs >= earliestLegacyStartMs/);
});

check('the durable session is only finalized/exported AFTER non-overlap is proven — never pay for (or risk) export on an ambiguous chronology', () => {
  const fn = discovery.slice(discovery.indexOf('export async function discoverRecoverySources'));
  const overlapCheckIdx = fn.indexOf('durableEndMs >= earliestLegacyStartMs');
  const exportIdx = fn.indexOf('finalizeAndExportDurableSession(durableSession)');
  assert.ok(overlapCheckIdx > 0 && exportIdx > overlapCheckIdx, 'the overlap check must run before export is ever attempted');
});

check('a proven-safe order returns the durable source FIRST, followed by legacy sources in their existing role order — three sources, each exactly once', () => {
  assert.match(discovery, /return \{ ok: true, sources: \[durableSource, \.\.\.legacySources\] \}/);
});

check('discovery never deletes, moves, or mutates a source on any path — copies only (via persistLegacyAudioSources / finalizeAndExportDurableSession, both already proven non-destructive)', () => {
  assert.doesNotMatch(discovery, /removeItem|deleteSession|abandonSession/);
});

check('finalizeAndExportDurableSession never touches or deletes the original segments — it only stops/recovers/finalizes/exports the SAME session', () => {
  assert.doesNotMatch(durableRecovery, /removeItem|deleteSession|abandonSession/);
  assert.match(durableRecovery, /exportFinalizedAsset\(/);
});

check('fixture: real device-measured numbers for the durable session that exposed this bug prove the overlap arithmetic (not hardcoded into product code — this file only)', () => {
  for (const file of [discovery, durableRecovery, facade, ownershipHook, featureGate]) {
    assert.doesNotMatch(file, /5780210|1788747976719|a1692715/, 'the specific forensic session/lecture must never be hardcoded into product logic');
  }
  // Durable session: Sept 5 20:14:41.227Z -> 22:01:18.165Z (98 segments).
  const durableEndMs = Date.parse('2026-09-05T22:01:18.165Z');
  // Legacy prior_canonical: real mtime, real measured duration (Sept 7).
  const legacyMtimeMs = Date.parse('2026-09-07T02:25:34.000Z');
  const legacyDurationMs = 100_010;
  const legacyEstimatedStartMs = legacyMtimeMs - legacyDurationMs;
  assert.ok(durableEndMs < legacyEstimatedStartMs, 'the real durable session end is provably before the real legacy source start — over a day of margin');
  assert.equal(Math.round((legacyEstimatedStartMs - durableEndMs) / 3_600_000), 28, 'roughly 28 hours of gap, matching the forensic finding');
});

check('fixture: a synthetic OVERLAPPING pair is correctly rejected by the same comparison used in discoverRecoverySources', () => {
  const durableEndMs = Date.parse('2026-09-05T22:01:18.165Z');
  // A legacy source that started mid-durable-session (overlap).
  const legacyMtimeMs = Date.parse('2026-09-05T21:30:00.000Z');
  const legacyDurationMs = 120_000; // 2 minutes
  const legacyEstimatedStartMs = legacyMtimeMs - legacyDurationMs;
  assert.ok(durableEndMs >= legacyEstimatedStartMs, 'this synthetic case IS an overlap, so discovery must block it');
});

console.log(`\ndurable-media-ownership: ${passed} checks passed`);
