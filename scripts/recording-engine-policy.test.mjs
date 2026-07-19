import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_RECORDING_ENGINE,
  RECORDING_FALLBACK_REASONS,
  RECORDING_ENGINE_SOURCES,
  resolveRecordingEngineDecision,
} from '../lib/recording/policy.mjs';

const decide = (input) => resolveRecordingEngineDecision(input);

// --- A. Selection policy -----------------------------------------------------

assert.equal(DEFAULT_RECORDING_ENGINE, 'legacy');
assert.deepEqual(decide({}), {
  engine: 'legacy',
  source: 'default',
  fallbackReason: null,
  retainNativeRecovery: false,
}, 'the default with no inputs is legacy');

assert.equal(decide({ dogfoodEnabled: true }).engine, 'nativeDurable', 'internal cohort selects native');
assert.equal(decide({ dogfoodEnabled: true }).source, 'internal_dogfood');
assert.equal(decide({ dogfoodEnabled: false }).engine, 'legacy', 'ineligible users stay on legacy');

// Eligibility that cannot be resolved must fail closed.
assert.equal(decide({ eligibilityResolved: false }).engine, 'legacy');
assert.equal(decide({ eligibilityResolved: false }).fallbackReason, 'eligibility_unavailable');
assert.equal(
  decide({ dogfoodEnabled: true, eligibilityResolved: false }).engine,
  'legacy',
  'unresolved eligibility beats an enabled cohort',
);

// Guests / protected flows.
assert.equal(decide({ forceLegacy: true, dogfoodEnabled: true }).engine, 'legacy');
assert.equal(decide({ forceLegacy: true, isDevelopment: true, developerOverride: 'nativeDurable' }).engine, 'legacy');

// Overrides are inert without their context flag.
assert.equal(decide({ testOverride: 'nativeDurable' }).engine, 'legacy', 'test override is inert outside a test context');
assert.equal(decide({ developerOverride: 'nativeDurable' }).engine, 'legacy', 'developer override is inert in release');
assert.equal(decide({ isTestContext: true, testOverride: 'nativeDurable' }).source, 'test_override');
assert.equal(decide({ isDevelopment: true, developerOverride: 'nativeDurable' }).source, 'developer_override');
assert.equal(
  decide({ isDevelopment: true, developerOverride: 'legacy', dogfoodEnabled: true }).engine,
  'legacy',
  'a developer override to legacy beats cohort eligibility',
);

// Priority order: test > developer > dogfood > default.
assert.equal(
  decide({
    isTestContext: true, testOverride: 'legacy',
    isDevelopment: true, developerOverride: 'nativeDurable',
    dogfoodEnabled: true,
  }).source,
  'test_override',
);
assert.equal(
  decide({ isDevelopment: true, developerOverride: 'legacy', dogfoodEnabled: true }).source,
  'developer_override',
);

// Garbage override values are ignored rather than trusted.
assert.equal(decide({ isTestContext: true, testOverride: 'somethingElse' }).engine, 'legacy');
assert.equal(decide({ isDevelopment: true, developerOverride: '' }).engine, 'legacy');

// Determinism: identical input always yields an identical decision.
const input = { dogfoodEnabled: true, capability: { moduleAvailable: true }, hasDurableEvidence: true };
assert.deepEqual(decide(input), decide(input));
for (const source of RECORDING_ENGINE_SOURCES) assert.equal(typeof source, 'string');

// --- B. Fallback -------------------------------------------------------------

const cases = [
  ['supportedRuntime', 'unsupported_runtime'],
  ['moduleAvailable', 'native_module_unavailable'],
  ['contractCompatible', 'native_contract_incompatible'],
  ['storageAvailable', 'native_storage_unavailable'],
  ['initialized', 'native_initialization_failed'],
  ['microphoneAvailable', 'native_permission_unavailable'],
];
for (const [flag, reason] of cases) {
  const result = decide({ dogfoodEnabled: true, capability: { [flag]: false } });
  assert.equal(result.engine, 'legacy', `${flag} false must fall back`);
  assert.equal(result.fallbackReason, reason);
  assert.ok(RECORDING_FALLBACK_REASONS.includes(result.fallbackReason), 'reason code is stable');
}

// Fallback reasons are ordered deterministically when several apply.
assert.equal(
  decide({ dogfoodEnabled: true, capability: { supportedRuntime: false, moduleAvailable: false } }).fallbackReason,
  'unsupported_runtime',
);

// Native stays selected when every probe passes.
assert.equal(
  decide({ dogfoodEnabled: true, capability: { moduleAvailable: true, initialized: true } }).engine,
  'nativeDurable',
);

// Durable evidence must never be hidden by a policy decision.
assert.equal(
  decide({ hasDurableEvidence: true }).retainNativeRecovery,
  true,
  'legacy default still retains native recovery when audio exists',
);
assert.equal(
  decide({ dogfoodEnabled: true, capability: { moduleAvailable: false }, hasDurableEvidence: true }).retainNativeRecovery,
  true,
  'a fallback must not orphan existing native audio',
);
assert.equal(decide({ hasDurableEvidence: false }).retainNativeRecovery, false);
assert.equal(
  decide({ forceLegacy: true, hasDurableEvidence: true }).retainNativeRecovery,
  true,
  'even a forced-legacy flow keeps native audio reachable',
);

// --- Committed defaults ------------------------------------------------------

const featureGate = await readFile(new URL('../lib/recording/featureGate.ts', import.meta.url), 'utf8');
assert.match(featureGate, /CONFIGURED_RECORDING_ENGINE[^=]*= 'legacy'/, 'committed gate defaults to legacy');
assert.match(
  featureGate,
  /EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD/,
  'dogfood eligibility comes from build-time env, not a runtime toggle',
);
assert.match(featureGate, /if \(!__DEV__\) return;/, 'developer override is a no-op in release builds');
assert.doesNotMatch(featureGate, /@[a-z0-9.-]+\.[a-z]{2,}/i, 'no personal identifier is committed');

const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
assert.doesNotMatch(
  envExample,
  /EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD\s*=\s*1/,
  'the example env must not enable dogfooding by default',
);

console.log('Recording engine policy tests passed.');
