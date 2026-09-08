/**
 * Regression guard for the DEV-ONLY native-durable-recorder force switch
 * (Build 50 native-durable-recorder audit, Phase C).
 *
 * This must NEVER affect a Production/TestFlight/Release build. Two
 * independent layers enforce that:
 *  1. isNativeDurableRecorderDevForceEnabled() requires BOTH __DEV__ and the
 *     exact env value '1' (mirrors isR6SimulatorVerifyEnabled).
 *  2. setDeveloperRecordingEngineOverride() (featureGate.ts) is itself a
 *     no-op outside __DEV__, and the committed rollout default
 *     (CONFIGURED_RECORDING_ENGINE) stays 'legacy' regardless.
 *
 * Runtime behavior (via isNativeDurableRecorderDevForceEnabled's pure inputs)
 * is tested directly; the __DEV__-gated pieces are verified structurally,
 * the same way the existing recording-diagnostics test already verifies
 * setDeveloperRecordingEngineOverride's own __DEV__ gate.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isNativeDurableRecorderDevForceEnabled } from '../lib/recording/nativeDurableDevForce.ts';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

console.log('Pure gate: requires BOTH __DEV__ and the exact env value');

check('disabled when neither __DEV__ nor the env var is set', () => {
  assert.equal(isNativeDurableRecorderDevForceEnabled({ isDev: false, envValue: undefined }), false);
});

check('disabled in a release build even if the env var is somehow set', () => {
  assert.equal(isNativeDurableRecorderDevForceEnabled({ isDev: false, envValue: '1' }), false);
});

check('disabled in dev without the explicit opt-in env var', () => {
  assert.equal(isNativeDurableRecorderDevForceEnabled({ isDev: true, envValue: undefined }), false);
});

check("disabled for near-miss env values ('true', '0', 'yes', empty string)", () => {
  for (const value of ['true', '0', 'yes', '', ' 1', '1 ']) {
    assert.equal(
      isNativeDurableRecorderDevForceEnabled({ isDev: true, envValue: value }),
      false,
      `envValue=${JSON.stringify(value)} must not enable it`,
    );
  }
});

check("enabled only when __DEV__ is true AND envValue is exactly '1'", () => {
  assert.equal(isNativeDurableRecorderDevForceEnabled({ isDev: true, envValue: '1' }), true);
});

console.log('Structural: the gate file has zero local imports (nothing to fail to resolve)');

const devForceSource = read('../lib/recording/nativeDurableDevForce.ts');
check('nativeDurableDevForce.ts imports nothing local — a pure, standalone gate like r6VerifyGate.ts', () => {
  assert.doesNotMatch(devForceSource, /^import /m, 'no local imports at all');
});

console.log('Structural: the force call is wired at app bootstrap, not inside a user-facing screen');

const layoutSource = read('../app/_layout.tsx');
check('root layout gates setDeveloperRecordingEngineOverride behind the pure dev-force check', () => {
  assert.match(
    layoutSource,
    /if \(isNativeDurableRecorderDevForceEnabled\(\)\) \{\s*\n\s*setDeveloperRecordingEngineOverride\('nativeDurable'\);\s*\n\s*\}/,
  );
});

const recordingScreen = read('../app/recording.tsx');
check('the recording screen itself still never toggles the engine (unchanged pre-existing guarantee)', () => {
  assert.doesNotMatch(recordingScreen, /setDeveloperRecordingEngineOverride|isNativeDurableRecorderDevForceEnabled/);
});

console.log('Structural: Production defaults are untouched by this change');

const featureGateSource = read('../lib/recording/featureGate.ts');
check("CONFIGURED_RECORDING_ENGINE compile-time default is still 'legacy'", () => {
  assert.match(featureGateSource, /export const CONFIGURED_RECORDING_ENGINE: RecordingEngine = 'legacy';/);
});

check('setDeveloperRecordingEngineOverride remains a no-op outside __DEV__ (pre-existing guarantee, still intact)', () => {
  assert.match(
    featureGateSource,
    /export function setDeveloperRecordingEngineOverride[\s\S]{0,160}if \(!__DEV__\) return;/,
  );
});

check('developer_override still cannot win unless isDevelopment is true (policy.mjs precedence, unchanged)', () => {
  const policySource = read('../lib/recording/policy.mjs');
  assert.match(policySource, /isDevelopment && isEngine\(developerOverride\)/);
});

console.log(`\nnative-durable-dev-force: ${passed} checks passed`);
