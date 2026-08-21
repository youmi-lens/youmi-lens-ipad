#!/usr/bin/env node
/**
 * Empirical RLS verification for public.recording_engine_rollout.
 *
 * Run this immediately after applying the migration and BEFORE enrolling
 * anyone. It attempts every operation that must fail, and reports a pass/fail
 * matrix. Exits non-zero if any unsafe access succeeds.
 *
 *   node scripts/rollout-rls-verify.mjs
 *
 * Credentials come from the environment; nothing is committed and no token,
 * full identifier, or raw response body is ever printed.
 *
 *   EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY   (from .env)
 *
 * Optional, for the full four-principal matrix — two DISPOSABLE test accounts:
 *   ROLLOUT_TEST_A_EMAIL / ROLLOUT_TEST_A_PASSWORD
 *   ROLLOUT_TEST_B_EMAIL / ROLLOUT_TEST_B_PASSWORD
 *
 * Optional, to verify the admin path (operator shell only, never .env):
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Without the optional values the anon-only subset still runs, and the
 * user-context rows are reported as SKIPPED rather than passed.
 */
import { readFile } from 'node:fs/promises';

const TABLE = 'recording_engine_rollout';

async function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = await readFile(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].trim();
    }
  } catch {
    // .env is optional when the values are already exported.
  }
  return env;
}

const redact = (id) =>
  typeof id === 'string' && id.length >= 8 ? `${id.slice(0, 8)}…` : 'unknown';

/** Performs one REST call and reduces it to a safe outcome summary. */
async function attempt(url, anonKey, jwt, { method, path, body }) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${jwt ?? anonKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const rows = Array.isArray(payload) ? payload.length : null;
  return {
    status: response.status,
    ok: response.ok,
    rows,
    // Only the stable PostgREST code is retained — never the message body.
    code: payload && !Array.isArray(payload) ? (payload.code ?? null) : null,
  };
}

async function signIn(url, anonKey, email, password) {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data?.access_token ? { jwt: data.access_token, userId: data.user?.id ?? null } : null;
}

const results = [];
function record(principal, operation, expected, outcome) {
  // "denied" means: an error status, or a read that returned no rows.
  const denied = !outcome.ok || (outcome.rows === 0 && expected === 'no rows');
  const pass = expected === 'allowed' ? outcome.ok : denied;
  results.push({ principal, operation, expected, actual: describe(outcome), pass });
}
function describe(outcome) {
  if (!outcome.ok) return `denied (${outcome.status}${outcome.code ? ` ${outcome.code}` : ''})`;
  return outcome.rows === null ? `succeeded (${outcome.status})` : `succeeded, ${outcome.rows} row(s)`;
}
function skip(principal, operation, why) {
  results.push({ principal, operation, expected: '—', actual: `SKIPPED (${why})`, pass: null });
}

async function main() {
  const env = await loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    console.error('error: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY are required.');
    process.exit(2);
  }
  const ref = url.replace(/^https:\/\/([a-z0-9]+)\.supabase\.co.*$/, '$1');
  console.log(`project: ${ref.slice(0, 4)}…${ref.slice(-4)}   table: ${TABLE}\n`);

  // Precondition: the table must exist, or nothing below is meaningful.
  const probe = await attempt(url, anonKey, null, { method: 'GET', path: `${TABLE}?select=user_id&limit=1` });
  if (probe.code === 'PGRST205') {
    console.error('PRECONDITION FAILED: the rollout table does not exist.');
    console.error('Apply supabase/migrations/20260719_recording_engine_rollout.sql first.');
    process.exit(2);
  }

  // The table's user_id references auth.users, so an admin write needs a real
  // user. ROLLOUT_ADMIN_TEST_UUID supplies a disposable one; without it the
  // admin rows are reported as skipped rather than failing on a foreign key.
  const adminSubject = env.ROLLOUT_ADMIN_TEST_UUID ?? null;
  const fakeId = '00000000-0000-4000-8000-000000000000';
  const writeBody = { user_id: fakeId, engine: 'nativeDurable', enabled: true, cohort: 'internal' };

  // --- Principal 1: unauthenticated (anon key only) --------------------------
  record('anon', 'select', 'no rows', await attempt(url, anonKey, null, { method: 'GET', path: `${TABLE}?select=user_id&limit=5` }));
  record('anon', 'insert', 'denied', await attempt(url, anonKey, null, { method: 'POST', path: TABLE, body: writeBody }));
  record('anon', 'update', 'denied', await attempt(url, anonKey, null, { method: 'PATCH', path: `${TABLE}?user_id=eq.${fakeId}`, body: { enabled: true } }));
  record('anon', 'delete', 'denied', await attempt(url, anonKey, null, { method: 'DELETE', path: `${TABLE}?user_id=eq.${fakeId}` }));

  // --- Principals 2 and 3: ordinary users A and B ----------------------------
  const a = env.ROLLOUT_TEST_A_EMAIL && env.ROLLOUT_TEST_A_PASSWORD
    ? await signIn(url, anonKey, env.ROLLOUT_TEST_A_EMAIL, env.ROLLOUT_TEST_A_PASSWORD)
    : null;
  const b = env.ROLLOUT_TEST_B_EMAIL && env.ROLLOUT_TEST_B_PASSWORD
    ? await signIn(url, anonKey, env.ROLLOUT_TEST_B_EMAIL, env.ROLLOUT_TEST_B_PASSWORD)
    : null;

  for (const [label, principal, other] of [['user A', a, b], ['user B', b, a]]) {
    if (!principal) {
      skip(label, 'all checks', 'no test credentials provided');
      continue;
    }
    console.log(`${label}: signed in as ${redact(principal.userId)}`);
    record(label, 'read own row', 'allowed', await attempt(url, anonKey, principal.jwt, { method: 'GET', path: `${TABLE}?select=user_id&user_id=eq.${principal.userId}` }));
    if (other?.userId) {
      record(label, "read other user's row", 'no rows', await attempt(url, anonKey, principal.jwt, { method: 'GET', path: `${TABLE}?select=user_id&user_id=eq.${other.userId}` }));
    } else {
      skip(label, "read other user's row", 'second test account not provided');
    }
    record(label, 'self-enroll (insert)', 'denied', await attempt(url, anonKey, principal.jwt, { method: 'POST', path: TABLE, body: { ...writeBody, user_id: principal.userId } }));
    record(label, 'update enabled', 'denied', await attempt(url, anonKey, principal.jwt, { method: 'PATCH', path: `${TABLE}?user_id=eq.${principal.userId}`, body: { enabled: true } }));
    record(label, 'update engine', 'denied', await attempt(url, anonKey, principal.jwt, { method: 'PATCH', path: `${TABLE}?user_id=eq.${principal.userId}`, body: { engine: 'nativeDurable' } }));
    record(label, 'update kill_switch', 'denied', await attempt(url, anonKey, principal.jwt, { method: 'PATCH', path: `${TABLE}?user_id=eq.${principal.userId}`, body: { kill_switch: false } }));
    record(label, 'update expires_at', 'denied', await attempt(url, anonKey, principal.jwt, { method: 'PATCH', path: `${TABLE}?user_id=eq.${principal.userId}`, body: { expires_at: '2030-01-01T00:00:00Z' } }));
    record(label, 'delete', 'denied', await attempt(url, anonKey, principal.jwt, { method: 'DELETE', path: `${TABLE}?user_id=eq.${principal.userId}` }));
  }

  // --- Principal 4: admin / service role -------------------------------------
  if (env.SUPABASE_SERVICE_ROLE_KEY) {
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    record('admin', 'insert disposable row', 'allowed', await attempt(url, key, key, { method: 'POST', path: TABLE, body: { ...writeBody, enabled: false, cohort: 'disabled', engine: 'legacy' } }));
    record('admin', 'update kill_switch', 'allowed', await attempt(url, key, key, { method: 'PATCH', path: `${TABLE}?user_id=eq.${fakeId}`, body: { kill_switch: true } }));
    record('admin', 'set expiry', 'allowed', await attempt(url, key, key, { method: 'PATCH', path: `${TABLE}?user_id=eq.${fakeId}`, body: { expires_at: '2030-01-01T00:00:00Z' } }));
    record('admin', 'delete disposable row', 'allowed', await attempt(url, key, key, { method: 'DELETE', path: `${TABLE}?user_id=eq.${fakeId}` }));
  } else {
    skip('admin', 'all checks', 'SUPABASE_SERVICE_ROLE_KEY not set');
  }

  // --- Report ----------------------------------------------------------------
  const width = Math.max(...results.map((r) => r.principal.length + r.operation.length)) + 4;
  console.log(`\n${'principal / operation'.padEnd(width)} ${'expected'.padEnd(10)} ${'actual'.padEnd(28)} result`);
  console.log('-'.repeat(width + 50));
  for (const r of results) {
    const label = `${r.principal} / ${r.operation}`.padEnd(width);
    const verdict = r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
    console.log(`${label} ${r.expected.padEnd(10)} ${r.actual.padEnd(28)} ${verdict}`);
  }

  const failures = results.filter((r) => r.pass === false);
  const skipped = results.filter((r) => r.pass === null);
  console.log('');
  if (failures.length > 0) {
    console.error(`SECURITY FAILURE: ${failures.length} check(s) failed.`);
    console.error('STOP. Do not enroll anyone. Apply the rollback and correct the policy set.');
    process.exit(1);
  }
  console.log(`All ${results.length - skipped.length} executed check(s) passed.`);
  if (skipped.length > 0) {
    console.log(`${skipped.length} check(s) SKIPPED — the matrix is incomplete until those run.`);
    process.exit(3);
  }
}

await main();
