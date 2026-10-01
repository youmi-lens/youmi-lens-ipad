import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));
const profile = eas.build['integrated-physical-validation'];

assert.ok(profile, 'the integrated physical-validation profile must exist');
assert.equal(profile.developmentClient, true, 'it must be a Development Client');
assert.equal(profile.distribution, 'internal', 'it must remain an internal Dev artifact');
assert.equal(profile.environment, 'production', 'it must read the existing production validation environment');
assert.equal(profile.env.APP_VARIANT, 'development', 'it must retain the separate Dev identity');
assert.equal(profile.env.EXPO_PUBLIC_RECORDING_ENGINE_DIAGNOSTIC, '1', 'runtime engine evidence must be enabled');
assert.equal(profile.env.EXPO_PUBLIC_SUBSCRIPTIONS_LIVE, 'true', 'live subscription UI must be enabled');
assert.equal(profile.env.EXPO_PUBLIC_USE_REAL_IAP, 'true', 'the real-IAP adapter must be enabled');
assert.equal(
  Object.hasOwn(profile.env, 'EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD'),
  false,
  'the artifact must default to legacy; nativeDurable is enabled only by the explicit DEV Metro switch',
);

console.log('integrated-physical-validation profile: 9 checks passed');
