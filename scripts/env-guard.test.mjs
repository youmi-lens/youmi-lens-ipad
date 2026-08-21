/**
 * Development environment isolation guard.
 *
 * Pins the contract that a __DEV__ build can never silently resolve to the
 * production Supabase project, while release/TestFlight builds are untouched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PRODUCTION_SUPABASE_REF,
  assertDevNotProduction,
  refFromLegacyJwtKey,
  supabaseRefFromUrl,
} from '../lib/envGuard.mjs';

const STAGING = 'keozbnzainrcuiwhmjae';
const PROD = PRODUCTION_SUPABASE_REF; // lbwsrnjbiayepshrdult

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

// A minimal legacy JWT with a given ref (header.payload.sig, base64url).
const jwtWithRef = (ref) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', ref })}.sig`;
};

console.log('ref extraction');
check('supabaseRefFromUrl parses the project ref', () => {
  assert.equal(supabaseRefFromUrl(`https://${STAGING}.supabase.co`), STAGING);
  assert.equal(supabaseRefFromUrl(`https://${PROD}.supabase.co/rest/v1/`), PROD);
  assert.equal(supabaseRefFromUrl(undefined), null);
  assert.equal(supabaseRefFromUrl('not a url'), null);
});

check('refFromLegacyJwtKey decodes .ref; new sb_ keys return null', () => {
  assert.equal(refFromLegacyJwtKey(jwtWithRef(PROD)), PROD);
  assert.equal(refFromLegacyJwtKey(jwtWithRef(STAGING)), STAGING);
  assert.equal(refFromLegacyJwtKey('sb_publishable_abc123'), null);
  assert.equal(refFromLegacyJwtKey('sb_secret_abc123'), null);
  assert.equal(refFromLegacyJwtKey(undefined), null);
});

console.log('dev guard');
check('dev build pointed at production URL throws', () => {
  assert.throws(
    () => assertDevNotProduction({ url: `https://${PROD}.supabase.co`, key: 'sb_publishable_x', isDev: true }),
    /pointed at PRODUCTION Supabase/,
  );
});

check('dev build using a production legacy key throws', () => {
  assert.throws(
    () => assertDevNotProduction({ url: `https://${STAGING}.supabase.co`, key: jwtWithRef(PROD), isDev: true }),
    /PRODUCTION Supabase key/,
  );
});

check('dev build with mismatched URL/key projects throws', () => {
  assert.throws(
    () => assertDevNotProduction({ url: `https://${STAGING}.supabase.co`, key: jwtWithRef('someotherref00000'), isDev: true }),
    /does not match the key project/,
  );
});

check('dev build on staging (publishable key) passes', () => {
  assert.doesNotThrow(() =>
    assertDevNotProduction({ url: `https://${STAGING}.supabase.co`, key: 'sb_publishable_stagingkey', isDev: true }),
  );
});

console.log('release builds are never affected');
check('production URL in a NON-dev build does NOT throw', () => {
  // Release / TestFlight / App Store must ship against production unaffected.
  assert.doesNotThrow(() =>
    assertDevNotProduction({ url: `https://${PROD}.supabase.co`, key: jwtWithRef(PROD), isDev: false }),
  );
});

check('missing isDev is treated as non-dev (no throw)', () => {
  assert.doesNotThrow(() => assertDevNotProduction({ url: `https://${PROD}.supabase.co` }));
});

// Wiring: the guard must actually be invoked at client init.
check('lib/supabase.ts invokes the guard with __DEV__', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/supabase.ts', import.meta.url)), 'utf8');
  assert.match(src, /assertDevNotProduction\(\{ url: supabaseUrl, key: supabaseAnonKey, isDev: __DEV__ \}\)/);
});

console.log(`\nenv guard: ${passed} checks passed`);
