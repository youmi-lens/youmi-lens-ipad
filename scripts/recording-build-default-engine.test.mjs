/**
 * Release decision (0.2.1 build 57): normal signed-in production users record with nativeDurable.
 *
 * The production EAS profile sets EXPO_PUBLIC_RECORDING_DEFAULT_ENGINE=nativeDurable. It is parsed strictly, fed into
 * the existing recording-engine policy as a `build_default`, and everything with higher precedence keeps it:
 * frozen in-flight engine, existing durable audio, guest -> legacy, test/developer overrides, and an authoritative
 * remote "no". Missing or unresolved remote rollout must NOT downgrade it. No env => the old legacy behavior.
 *
 * Run: node --experimental-strip-types scripts/recording-build-default-engine.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  RECORDING_ENGINE_SOURCES,
  parseBuildDefaultEngine,
  resolveRecordingEngineDecision,
  resolveRecordingEngineOwnershipDecision,
} from '../lib/recording/policy.mjs';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// What the production app feeds the policy: no test context, no developer override, no dogfood flag.
const production = (extra = {}) => ({
  isDevelopment: false, isTestContext: false, developerOverride: null, dogfoodEnabled: false,
  buildDefaultEngine: 'nativeDurable', rollout: null, capability: {}, ...extra,
});
const decide = (input) => resolveRecordingEngineDecision(input);
const owned = (input) => resolveRecordingEngineOwnershipDecision(input);

console.log('Strict parsing');
check('only the exact string "nativeDurable" yields a build default', () => {
  assert.equal(parseBuildDefaultEngine('nativeDurable'), 'nativeDurable');
  for (const bad of [undefined, null, '', 'legacy', 'NativeDurable', 'nativedurable', ' nativeDurable', 'nativeDurable ', '1', 'true', 'native', 'nativeDurable,legacy', 0, 1, true, {}, []]) {
    assert.equal(parseBuildDefaultEngine(bad), null, `${JSON.stringify(bad)} must not select an engine`);
  }
});
check('a malformed value in the policy input cannot select native either', () => {
  for (const bad of ['legacy', 'NativeDurable', 'true', '', 1, true]) {
    const result = decide(production({ buildDefaultEngine: bad }));
    assert.equal(result.engine, 'legacy');
    assert.equal(result.source, 'default');
  }
});

console.log('\nThe production default');
check('a normal signed-in production user selects nativeDurable via build_default', () => {
  assert.deepEqual(decide(production()), { engine: 'nativeDurable', source: 'build_default', fallbackReason: null, retainNativeRecovery: false });
  assert.deepEqual(owned(production()), { engine: 'nativeDurable', source: 'build_default', fallbackReason: null, retainNativeRecovery: false });
  assert.ok(RECORDING_ENGINE_SOURCES.includes('build_default'));
});
check('absent build default preserves the existing legacy behavior exactly', () => {
  const absent = production({ buildDefaultEngine: null });
  assert.deepEqual(decide(absent), { engine: 'legacy', source: 'default', fallbackReason: null, retainNativeRecovery: false });
  assert.deepEqual(decide({}), { engine: 'legacy', source: 'default', fallbackReason: null, retainNativeRecovery: false });
  assert.equal(decide({ dogfoodEnabled: true }).source, 'internal_dogfood', 'the dogfood cohort is untouched');
});

console.log('\nPrecedence is preserved');
check('guest stays legacy', () => {
  assert.deepEqual(decide(production({ forceLegacy: true })), { engine: 'legacy', source: 'default', fallbackReason: null, retainNativeRecovery: false });
  assert.equal(owned(production({ forceLegacy: true })).engine, 'legacy');
});
check('a frozen in-flight session keeps its engine, whichever it is', () => {
  assert.deepEqual(owned(production({ frozenEngine: 'legacy' })), { engine: 'legacy', source: 'frozen_session', fallbackReason: null, retainNativeRecovery: false });
  assert.deepEqual(owned(production({ frozenEngine: 'nativeDurable' })), { engine: 'nativeDurable', source: 'frozen_session', fallbackReason: null, retainNativeRecovery: false });
  assert.equal(decide(production({ frozenEngine: 'legacy' })).engine, 'legacy');
  assert.equal(owned(production({ frozenEngine: 'legacy', forceLegacy: false, hasDurableEvidence: true })).engine, 'legacy', 'frozen still outranks ownership, as before');
});
check('existing durable audio still selects nativeDurable, even for a build without the default', () => {
  assert.deepEqual(owned(production({ hasDurableEvidence: true })), { engine: 'nativeDurable', source: 'durable_ownership', fallbackReason: null, retainNativeRecovery: true });
  assert.equal(owned(production({ buildDefaultEngine: null, hasDurableEvidence: true })).engine, 'nativeDurable');
});
check('developer and test overrides outrank the build default only in their own context', () => {
  assert.deepEqual(decide(production({ isDevelopment: true, developerOverride: 'legacy' })).engine, 'legacy');
  assert.equal(decide(production({ isDevelopment: true, developerOverride: 'legacy' })).source, 'developer_override');
  assert.equal(decide(production({ isDevelopment: false, developerOverride: 'legacy' })).engine, 'nativeDurable', 'a release build ignores the override');
  assert.equal(decide(production({ isTestContext: true, testOverride: 'legacy' })).source, 'test_override');
  assert.equal(decide(production({ isTestContext: false, testOverride: 'legacy' })).engine, 'nativeDurable', 'inert outside a test context');
});

console.log('\nRemote rollout');
const remote = (extra) => ({ eligible: false, resolved: true, reason: null, cohort: null, revision: null, ...extra });
check('an authoritative remote "no" (including the kill switch) wins when the remote path is actually active', () => {
  const kill = decide(production({ rollout: remote({ reason: 'rollout_kill_switch' }) }));
  assert.deepEqual(kill, { engine: 'legacy', source: 'remote_rollout', fallbackReason: 'rollout_kill_switch', retainNativeRecovery: false });
  assert.equal(decide(production({ rollout: remote({ reason: 'rollout_disabled' }) })).engine, 'legacy');
  assert.equal(owned(production({ rollout: remote({ reason: 'rollout_kill_switch' }) })).engine, 'legacy');
  assert.equal(owned(production({ rollout: remote({ reason: 'rollout_kill_switch' }), hasDurableEvidence: true })).engine, 'nativeDurable', 'existing durable audio is never redirected into legacy');
});
check('an eligible remote result selects native as before (source remote_rollout)', () => {
  const result = decide(production({ rollout: remote({ eligible: true, cohort: 'internal', revision: 3 }) }));
  assert.equal(result.engine, 'nativeDurable');
  assert.equal(result.source, 'remote_rollout');
});
check('missing, unresolved or failed remote rollout does NOT downgrade the build default', () => {
  for (const rollout of [
    null,
    undefined,
    remote({ eligible: false, resolved: false, reason: 'rollout_record_missing' }),
    remote({ eligible: false, resolved: false, reason: 'rollout_fetch_failed' }),
    remote({ eligible: false, resolved: false, reason: 'rollout_infrastructure_unavailable' }),
    remote({ eligible: false, resolved: false, reason: 'rollout_timed_out' }),
    remote({ eligible: false, resolved: false, reason: null }),
  ]) {
    const result = decide(production({ rollout }));
    assert.equal(result.engine, 'nativeDurable', JSON.stringify(rollout));
    assert.equal(result.source, 'build_default');
  }
  assert.equal(decide(production({ buildDefaultEngine: null, rollout: remote({ resolved: false }) })).engine, 'legacy', 'without the build default an unresolved rollout still fails closed');
});
check('the unavailable-native fallback vocabulary is unchanged: an explicit capability probe still degrades to legacy', () => {
  const result = decide(production({ capability: { moduleAvailable: false } }));
  assert.deepEqual(result, { engine: 'legacy', source: 'build_default', fallbackReason: 'native_module_unavailable', retainNativeRecovery: false });
});

console.log('\nEnd to end through the real feature gate (release build, __DEV__ = false)');
const loadGate = async (envValue, dev = false) => {
  globalThis.__DEV__ = dev;
  if (envValue === undefined) delete process.env.EXPO_PUBLIC_RECORDING_DEFAULT_ENGINE;
  else process.env.EXPO_PUBLIC_RECORDING_DEFAULT_ENGINE = envValue;
  delete process.env.EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD;
  delete process.env.EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE;
  return import(`../lib/recording/featureGate.ts?env=${encodeURIComponent(String(envValue))}&dev=${dev}`);
};
{
  const gate = await loadGate('nativeDurable');
  check('EXPO_PUBLIC_RECORDING_DEFAULT_ENGINE=nativeDurable: the runtime decision is nativeDurable for a signed-in user', () => {
    assert.equal(gate.BUILD_DEFAULT_RECORDING_ENGINE, 'nativeDurable');
    assert.equal(gate.CONFIGURED_RECORDING_ENGINE, 'legacy', 'the committed constant is untouched');
    assert.equal(gate.REMOTE_ROLLOUT_ENABLED, false, 'remote rollout stays off');
    assert.equal(gate.INTERNAL_DOGFOOD_ENABLED, false, 'no dogfood flag');
    const decision = gate.resolveRecordingEngineOwnershipDecisionForRuntime({});
    assert.equal(decision.engine, 'nativeDurable');
    assert.equal(decision.source, 'build_default');
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({ rollout: null, forceLegacy: false, hasDurableEvidence: false }).engine, 'nativeDurable');
  });
  check('guest, frozen and durable-ownership decisions through the real gate', () => {
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({ forceLegacy: true }).engine, 'legacy');
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({ frozenEngine: 'legacy' }).engine, 'legacy');
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({ frozenEngine: 'nativeDurable' }).source, 'frozen_session');
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({ hasDurableEvidence: true }).source, 'durable_ownership');
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({ rollout: { eligible: false, resolved: false, reason: 'rollout_fetch_failed', cohort: null, revision: null } }).engine, 'nativeDurable');
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({ rollout: { eligible: false, resolved: true, reason: 'rollout_kill_switch', cohort: null, revision: null } }).engine, 'legacy');
    assert.equal(gate.resolveRecordingEngineDecisionForRuntime({}).engine, 'nativeDurable');
  });
}
for (const [label, value] of [['absent', undefined], ['empty', ''], ['legacy', 'legacy'], ['wrong case', 'NativeDurable'], ['padded', ' nativeDurable '], ['truthy', 'true']]) {
  const gate = await loadGate(value);
  check(`env ${label}: the real gate keeps the existing legacy behavior`, () => {
    assert.equal(gate.BUILD_DEFAULT_RECORDING_ENGINE, null);
    const decision = gate.resolveRecordingEngineOwnershipDecisionForRuntime({});
    assert.equal(decision.engine, 'legacy');
    assert.equal(decision.source, 'default');
  });
}
{
  const gate = await loadGate('nativeDurable', true);
  check('Dev build: the developer override still outranks the build default; no override => build default', () => {
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({}).engine, 'nativeDurable');
    gate.setDeveloperRecordingEngineOverride('legacy');
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({}).engine, 'legacy');
    assert.equal(gate.resolveRecordingEngineOwnershipDecisionForRuntime({}).source, 'developer_override');
    gate.setDeveloperRecordingEngineOverride(null);
  });
}

console.log('\nConfiguration: production only, no other recording switch');
check('only the production EAS profile carries the build default; no profile carries an injector or new switch', () => {
  const eas = JSON.parse(read('eas.json'));
  assert.deepEqual(eas.build.production.env, { EXPO_PUBLIC_USE_REAL_IAP: 'true', EXPO_PUBLIC_RECORDING_DEFAULT_ENGINE: 'nativeDurable' });
  const carriers = Object.entries(eas.build).filter(([, profile]) => profile.env && 'EXPO_PUBLIC_RECORDING_DEFAULT_ENGINE' in profile.env).map(([name]) => name);
  assert.deepEqual(carriers, ['production']);
  const production = eas.build.production;
  assert.equal(production.env.EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD, undefined, 'no dogfood flag in production');
  assert.equal(production.env.EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE, undefined, 'remote rollout is not enabled');
  assert.equal(production.env.APP_VARIANT, undefined, 'production stays the production bundle');
  assert.doesNotMatch(JSON.stringify(eas), /INJECT|Injector|inject-retry/i);
  for (const [name, profile] of Object.entries(eas.build)) {
    if (profile.env && ('EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD' in profile.env || 'EXPO_PUBLIC_RECORDING_ENGINE_DIAGNOSTIC' in profile.env)) {
      assert.equal(profile.env.APP_VARIANT, 'development', `${name}: dogfood/diagnostic flags exist only in Dev-variant profiles`);
    }
  }
});
check('featureGate parses through the strict parser, passes it to BOTH runtime resolvers, and changes nothing else', () => {
  const gate = read('lib/recording/featureGate.ts');
  assert.match(gate, /parseBuildDefaultEngine\(\s*process\.env\.EXPO_PUBLIC_RECORDING_DEFAULT_ENGINE,?\s*\)/);
  assert.equal((gate.match(/buildDefaultEngine: BUILD_DEFAULT_RECORDING_ENGINE/g) ?? []).length, 2);
  assert.match(gate, /export const CONFIGURED_RECORDING_ENGINE: RecordingEngine = 'legacy'/);
  assert.match(gate, /process\.env\.EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE === '1'/);
});

console.log('\nrecording-build-default-engine: PASS');
