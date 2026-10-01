import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));
const profile = eas.build['integrated-physical-validation-release'];
const envGuard = readFileSync(new URL('../lib/envGuard.mjs', import.meta.url), 'utf8');

assert.ok(profile, 'the release-style physical-QA profile must exist');
assert.equal(profile.developmentClient, undefined, 'it must not be a Development Client');
assert.equal(profile.distribution, 'internal', 'it must remain an internal QA artifact');
assert.equal(profile.environment, 'production', 'production config is an intentional QA input');
assert.equal(profile.env.APP_VARIANT, 'development', 'it must retain the separate Dev identity');
assert.equal(profile.env.EXPO_PUBLIC_SUBSCRIPTIONS_LIVE, 'true', 'live subscription UI must be enabled');
assert.equal(profile.env.EXPO_PUBLIC_USE_REAL_IAP, 'true', 'the real-IAP adapter must be enabled');
assert.equal(Object.hasOwn(profile.env, 'EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD'), false, 'the QA artifact defaults to legacy');
assert.match(envGuard, /if \(!isDev\) return;/, 'the production-Supabase guard remains release-safe and unchanged');
assert.match(envGuard, /if \(urlRef === PRODUCTION_SUPABASE_REF\)/, 'the Dev guard still rejects production Supabase');

console.log('integrated release physical-QA profile: 10 checks passed');
