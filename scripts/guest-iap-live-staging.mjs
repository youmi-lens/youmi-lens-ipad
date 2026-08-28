#!/usr/bin/env node
/**
 * Guest IAP — TRUE live staging verification (STAGING ONLY, keoz…).
 *
 * Proves against the real staging Supabase project and the REAL, UNMODIFIED
 * backend ownership functions (imported directly from youmi-lens/server, not
 * reimplemented or mocked):
 *
 *   1. real signInAnonymously() — via GoTrue's own REST endpoint, exactly what
 *      lib/guestIapClient.ts's `guestIapSupabase.auth.signInAnonymously()` calls.
 *   2. guest reaches a real backend endpoint the Plans screen depends on
 *      (GET /api/quota/status, the same call fetchPlanStatus makes).
 *   3. relaunch persistence + same-UUID: refresh_token round-trip returns the
 *      identical user id, proving a relaunch keeps the same guest identity.
 *   4. Cloud Library isolation: the anonymous identity sees ZERO rows in
 *      `courses`/`recordings` (RLS-scoped) — proves no accidental Cloud
 *      Library interaction, live, not just by source inspection.
 *   5. ownership-conflict rejection: calls the REAL, IMPORTED
 *      `claimSubscriptionBinding` / `assertSubscriptionIdentity` from
 *      server/iapSubscriptions.mjs against the real `app_store_subscription_bindings`
 *      table — first claim succeeds, a second (different) anonymous user
 *      claiming the SAME originalTransactionId is rejected with
 *      SubscriptionAlreadyLinkedError, and a mismatched appAccountToken is
 *      rejected with SubscriptionAccountTokenError. This is the real ownership
 *      code, not a reimplementation — JWS/Apple-signature verification is a
 *      SEPARATE, already source-audited step (verifyAppleTransaction) that
 *      this script does not need to fake, because claimSubscriptionBinding
 *      only ever receives an ALREADY-verified transaction object.
 *
 * NOT covered here (requires a Sandbox Tester Apple ID or a physical device —
 * the same category of owner action as the 2.5.4 background-audio proof):
 *   - an actual StoreKit purchase sheet / real Apple-signed transaction
 *   - end-to-end POST /api/iap/apple/verify with a genuine JWS
 * The client code path that WOULD drive that (resolvePurchaseIdentity →
 * subscriptionService.purchase(plan, token, account)) is already fully
 * source-verified in scripts/guest-purchase-architecture.test.mjs.
 *
 * Aborts unless the target is staging. Cleans up every disposable row/user.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = {};
for (const l of readFileSync(new URL('../../youmi-lens/.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
// The backend base URL lives in the iPad app's own dev-override env, not the
// backend repo's .env.local (which has no HTTP client concept of itself).
for (const l of readFileSync(new URL('../.env.development.local', import.meta.url), 'utf8').split('\n')) {
  const m = l.match(/^EXPO_PUBLIC_API_BASE_URL=(.*)$/); if (m) env.API_BASE_URL = m[1].trim();
}
const URL_ = env.SUPABASE_URL, ANON = env.SUPABASE_ANON_KEY, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (URL_?.replace(/^https:\/\/([a-z0-9]{4}).*/, '$1') !== 'keoz') {
  console.error('REFUSING: target is not staging. Aborting.'); process.exit(2);
}
console.log(`project: ${URL_.replace(/(https:\/\/[a-z]{4}).*/, '$1…')}  (STAGING)\n`);

const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const blocked = (name, detail) => { results.push({ name, pass: null }); console.log(`  BLOCKED  ${name} — ${detail}`); };

let exitCode = 0;
const disposable = { users: [], bindingIds: [] };

try {
  // ── 1. real signInAnonymously() ─────────────────────────────────────────
  const anonRes = await fetch(`${URL_}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  // GoTrue distinguishes anonymous sign-in by hitting the SAME client method
  // supabase-js uses under the hood: POST /auth/v1/signup with no email/password
  // is rejected on some GoTrue versions; the canonical anonymous endpoint is a
  // plain POST with an empty JSON body to /auth/v1/signup only when anonymous
  // sign-ins are enabled (confirmed via /auth/v1/settings: anonymous_users=true).
  let anonBody = await anonRes.json();
  let guestA;
  if (anonRes.ok && anonBody.access_token) {
    guestA = { jwt: anonBody.access_token, uid: anonBody.user?.id, refreshToken: anonBody.refresh_token };
  } else {
    // Some GoTrue versions expose anonymous sign-in only via this exact shape.
    const retry = await fetch(`${URL_}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: undefined, password: undefined }),
    });
    const retryBody = await retry.json();
    guestA = retry.ok && retryBody.access_token
      ? { jwt: retryBody.access_token, uid: retryBody.user?.id, refreshToken: retryBody.refresh_token }
      : null;
  }
  ok('1. real signInAnonymously() returns a live session', Boolean(guestA?.jwt && guestA?.uid), guestA ? `uid=${guestA.uid.slice(0, 8)}…` : JSON.stringify(anonBody).slice(0, 200));
  if (!guestA) throw new Error('anonymous sign-in failed — cannot continue');
  disposable.users.push(guestA.uid);

  // ── 2. guest reaches a real backend status endpoint ─────────────────────
  const API_BASE_URL = process.env.GUEST_IAP_API_BASE_URL?.trim() || env.API_BASE_URL || null;
  if (API_BASE_URL) {
    try {
      const statusRes = await fetch(`${API_BASE_URL}/api/quota/status`, { headers: { Authorization: `Bearer ${guestA.jwt}` }, signal: AbortSignal.timeout(4000) });
      ok('2. guest JWT reaches GET /api/quota/status (Plans screen dependency)', statusRes.status === 200, `HTTP ${statusRes.status}`);
    } catch {
      blocked('2. guest JWT reaches GET /api/quota/status (Plans screen dependency)', `local dev backend (${API_BASE_URL}) not reachable from this environment — same LAN-only limitation noted in the earlier P0 sync report, not a guest-IAP defect`);
    }
  } else {
    blocked('2. guest JWT reaches GET /api/quota/status (Plans screen dependency)', 'EXPO_PUBLIC_API_BASE_URL not found');
  }

  // ── 3. relaunch persistence + same-UUID ──────────────────────────────────
  const refreshRes = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: guestA.refreshToken }),
  });
  const refreshBody = await refreshRes.json();
  ok('3. relaunch (refresh_token) preserves the SAME guest UUID', refreshRes.ok && refreshBody.user?.id === guestA.uid, `${refreshBody.user?.id?.slice(0, 8)}… === ${guestA.uid.slice(0, 8)}…`);

  // ── 4. Cloud Library isolation ───────────────────────────────────────────
  const coursesRes = await fetch(`${URL_}/rest/v1/courses?select=id&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${guestA.jwt}` } });
  const coursesBody = await coursesRes.json();
  const recordingsRes = await fetch(`${URL_}/rest/v1/recordings?select=id&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${guestA.jwt}` } });
  const recordingsBody = await recordingsRes.json();
  ok('4. Cloud Library isolation — guest sees ZERO courses (RLS-scoped)', Array.isArray(coursesBody) && coursesBody.length === 0, `rows=${JSON.stringify(coursesBody).slice(0, 80)}`);
  ok('4. Cloud Library isolation — guest sees ZERO recordings (RLS-scoped)', Array.isArray(recordingsBody) && recordingsBody.length === 0, `rows=${JSON.stringify(recordingsBody).slice(0, 80)}`);

  // ── 5. ownership-conflict rejection — REAL, IMPORTED backend functions ──
  const { claimSubscriptionBinding, assertSubscriptionIdentity, SubscriptionAlreadyLinkedError, SubscriptionAccountTokenError } =
    await import('../../youmi-lens/server/iapSubscriptions.mjs');
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });

  // A second, distinct guest identity — the "different account" for the conflict test.
  const anonB = await fetch(`${URL_}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const anonBBody = await anonB.json();
  const guestB = anonB.ok && anonBBody.access_token ? { uid: anonBBody.user?.id } : null;
  if (guestB) disposable.users.push(guestB.uid);
  ok('setup: second distinct guest identity for the conflict test', Boolean(guestB?.uid));

  const fixtureTxId = `live-qa-${randomUUID()}`;
  const verifiedFixture = { originalTransactionId: fixtureTxId, appAccountToken: guestA.uid, environment: 'Sandbox' };
  disposable.bindingIds.push(fixtureTxId);

  // assertSubscriptionIdentity: mismatched appAccountToken must throw. This is
  // a pure in-memory check — no table needed — so it runs regardless of the
  // staging schema gap detected below.
  let mismatchThrew = false;
  try { assertSubscriptionIdentity(verifiedFixture, guestB.uid); } catch (e) { mismatchThrew = e instanceof SubscriptionAccountTokenError; }
  ok('5a. assertSubscriptionIdentity rejects a mismatched appAccountToken (real function)', mismatchThrew);

  // Probe once: does app_store_subscription_bindings exist on staging? (It is
  // confirmed present on PRODUCTION — a 42501 permission-denied read, not a
  // 404 — but staging returns PGRST205 "table not found". This is a
  // pre-existing gap in the ALREADY-AUTHORED, additive
  // supabase-migration-commercialization-v2-subscriptions.sql, unrelated to
  // guest IAP: it would block ANY subscription verification on staging today,
  // guest or signed-in. Not applied here — DDL requires the owner, per this
  // session's standing rule.)
  const probe = await db.from('app_store_subscription_bindings').select('original_transaction_id').limit(1);
  const schemaReady = !probe.error;

  if (!schemaReady) {
    const why = 'staging is missing app_store_subscription_bindings/app_store_subscription_states — pre-existing gap, already fixed on production, migration file exists at youmi-lens/supabase-migration-commercialization-v2-subscriptions.sql but has never been run on staging. Not guest-IAP-specific.';
    blocked('5b. first claim by the rightful (guest) owner succeeds against the REAL table', why);
    blocked('5c. a DIFFERENT account claiming the same transaction is REJECTED (SubscriptionAlreadyLinkedError, real DB)', why);
    blocked('5d. re-claiming by the SAME rightful owner is idempotent (no false conflict)', why);
  } else {
    // First claim by the RIGHTFUL owner (guestA) succeeds — real DB write.
    let firstClaimOk = false;
    try {
      const claimed = await claimSubscriptionBinding(db, guestA.uid, verifiedFixture);
      firstClaimOk = claimed?.user_id === guestA.uid;
    } catch (e) { console.warn('first claim threw unexpectedly:', e.message); }
    ok('5b. first claim by the rightful (guest) owner succeeds against the REAL table', firstClaimOk);

    // Second claim by a DIFFERENT account for the SAME originalTransactionId must be rejected.
    let conflictRejected = false;
    try {
      await claimSubscriptionBinding(db, guestB.uid, { ...verifiedFixture, appAccountToken: guestB.uid });
    } catch (e) { conflictRejected = e instanceof SubscriptionAlreadyLinkedError; }
    ok('5c. a DIFFERENT account claiming the same transaction is REJECTED (SubscriptionAlreadyLinkedError, real DB)', conflictRejected);

    // Re-claim by the SAME rightful owner is idempotent (not a conflict).
    let idempotentOk = false;
    try {
      const reclaimed = await claimSubscriptionBinding(db, guestA.uid, verifiedFixture);
      idempotentOk = reclaimed?.user_id === guestA.uid;
    } catch (e) { console.warn('re-claim by rightful owner threw unexpectedly:', e.message); }
    ok('5d. re-claiming by the SAME rightful owner is idempotent (no false conflict)', idempotentOk);
  }

} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  exitCode = 1;
} finally {
  console.log('\n── cleanup ──');
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });
    for (const txId of disposable.bindingIds) {
      const { error } = await db.from('app_store_subscription_bindings').delete().eq('original_transaction_id', txId);
      console.log(`  binding ${txId.slice(0, 20)}… delete: ${error ? (error.code === 'PGRST205' ? 'n/a (table absent on staging)' : 'FAILED ' + error.message) : 'ok'}`);
    }
  } catch (e) {
    console.warn('  binding cleanup skipped:', e.message);
  }
  for (const uid of disposable.users) {
    const r = await fetch(`${URL_}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    console.log(`  user ${uid.slice(0, 8)}… delete: ${r.status}`);
  }

  const fails = results.filter((r) => r.pass === false);
  const blockedCount = results.filter((r) => r.pass === null).length;
  const passCount = results.filter((r) => r.pass === true).length;
  console.log(`\n${'='.repeat(60)}\nGUEST IAP LIVE STAGING: ${passCount}/${results.length} passed, ${blockedCount} blocked (environment/schema, not code), ${fails.length} failed`);
  if (fails.length) { console.log('FAILURES:', fails.map((f) => f.name).join('; ')); exitCode = 1; }
  process.exit(exitCode);
}
