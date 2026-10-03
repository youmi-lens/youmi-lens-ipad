/**
 * App Review Guideline 5.1.1(v) — guest (account-optional) IAP architecture.
 * STAGING-approved design: purchase without registration, via a SECOND,
 * FULLY ISOLATED Supabase client (lib/guestIapClient.ts) used only for an
 * anonymous identity — never wired into AuthProvider or Cloud Library.
 *
 * Backend ownership is REUSED, unmodified: `assertSubscriptionIdentity`
 * (server/iapSubscriptions.mjs) already requires the verified transaction's
 * appAccountToken to equal the CURRENTLY authenticated user id, and
 * `claimSubscriptionBinding` already rejects a second, different user
 * claiming an existing originalTransactionId (SubscriptionAlreadyLinkedError).
 * Neither depends on how that user id was authenticated — email/password,
 * Apple, Google, or Supabase's own anonymous sign-in are all just "a valid
 * JWT" to this code, so no backend change was needed or made.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadFixture } from './backend-billing-contract.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const plans = read('../app/plans.tsx');
const settings = read('../app/(tabs)/settings.tsx');
const guestIap = read('../lib/guestIap.ts');
const guestIapClient = read('../lib/guestIapClient.ts');
const authLib = read('../lib/auth.tsx');
const storeLib = read('../lib/store.tsx');
// The backend facts below come from a fixture pinned to one backend revision (scripts/fixtures/backend-billing-contract.json,
// regenerated/verified by scripts/backend-billing-contract.mjs against an explicitly named backend checkout) — never
// from a sibling checkout, so this test is identical on every machine and in CI.
const backend = loadFixture();
const iapSubscriptions = backend.subscriptions.verifyAndPersistSubscription;
const iapRoutes = Object.values(backend.routes.fragments).map((fragment) => fragment.text).join('\n');

console.log('B — isolated client design');
check('a SECOND createClient exists, pointed at the same project, with its OWN distinct storage key', () => {
  assert.match(guestIapClient, /export const guestIapSupabase = createClient\(/);
  assert.match(guestIapClient, /storageKey: GUEST_IAP_STORAGE_KEY/);
  assert.match(guestIapClient, /const GUEST_IAP_STORAGE_KEY = 'sb-guest-iap-auth-token'/);
  // same project URL/anon key as the main client — one project, two client instances.
  assert.match(guestIapClient, /EXPO_PUBLIC_SUPABASE_URL/);
  assert.match(guestIapClient, /EXPO_PUBLIC_SUPABASE_ANON_KEY/);
});
check('production guard is preserved on the isolated client too', () => {
  assert.match(guestIapClient, /assertDevNotProduction\(\{ url: supabaseUrl, key: supabaseAnonKey, isDev: __DEV__ \}\)/);
});

console.log('\nG1/G2 — guest can reach Plans and initiate purchase');
check('G1: the real guest Settings composition exposes a direct Plans route', () => {
  const guestBranch = settings.slice(
    settings.indexOf('{isGuest ? ('),
    settings.indexOf(') : (', settings.indexOf('{isGuest ? (')),
  );
  assert.match(guestBranch, /router\.push\('\/plans'\)/);
  assert.match(guestBranch, /settings\.plan\.studentBasicRow/);
});
check('G1: live subscriptions are not blocked by the retired Student Basic sales gate, while a guest with no known status remains purchasable', () => {
  assert.match(plans, /const purchaseVisible = SUBSCRIPTIONS_LIVE\s*\n\s*\? !activeEntitlement/);
  assert.match(plans, /: isGuest\s*\n\s*\? \(currentStatus \? shouldShowPurchaseEntry\(currentStatus\) : true\)/);
  assert.match(plans, /const purchaseUnavailable = !SUBSCRIPTIONS_LIVE && currentStatus\?\.studentPass\?\.isPurchasable === false/);
});
check('G2: handlePurchase no longer alerts sign-in-required for a guest — it resolves a guest-IAP identity instead', () => {
  const fn = plans.slice(plans.indexOf('const handlePurchase = async () => {'), plans.indexOf('const handleRefreshAccess = async () => {'));
  assert.doesNotMatch(fn, /isGuest.*Alert\.alert\(t\('plans\.signInRequired'\)/);
  assert.match(fn, /const identity = await boundedPaymentTask\(resolvePurchaseIdentity, PAYMENT_UI_WAIT_TIMEOUT_MS,/);
});

console.log('\nG3 — guest purchase reuses the unmodified purchase call + backend');
check('G3: purchase is called with the guest-IAP token/uuid via the SAME unmodified subscriptionService.purchase', () => {
  assert.match(plans, /const result = await subscriptionService\.purchase\(selectedPlan, identity\.token, identity\.account\);/);
  // resolvePurchaseIdentity is the ONLY place a guest identity is minted, and it is guest-gated.
  assert.match(plans, /const resolvePurchaseIdentity = async \(\): Promise<\{ token: string; account: string \} \| null> => \{\s*\n\s*if \(!isGuest\)/);
  assert.match(plans, /const identity = await ensureGuestIapIdentity\(\);/);
});
check('ensureGuestIapIdentity never fabricates a token — returns null when anonymous auth is unavailable', () => {
  const fn = guestIap.slice(guestIap.indexOf('export async function ensureGuestIapIdentity'), guestIap.indexOf('export async function hasGuestIapIdentity'));
  assert.match(fn, /if \(!isGuestIapClientConfigured\) return null;/);
  assert.match(fn, /if \(error \|\| !data\.session\?\.access_token \|\| !data\.session\.user\?\.id\) \{[\s\S]{0,120}return null;/);
});
check('a guest with no available identity sees a real "unavailable" alert, never a silent fake success', () => {
  const fn = plans.slice(plans.indexOf('const handlePurchase = async () => {'), plans.indexOf('const handleRefreshAccess = async () => {'));
  assert.match(fn, /if \(!identity\) \{\s*\n\s*Alert\.alert\(t\('plans\.purchaseUnavailableTitle'\), t\('plans\.guestPurchaseUnavailable'\)\);\s*\n\s*return;/);
});

console.log('\nG4 — guest Restore works the same way');
check('G4: handleRefreshAccess also resolves the guest-IAP identity and calls the unmodified restore', () => {
  const fn = plans.slice(plans.indexOf('const handleRefreshAccess = async () => {'), plans.indexOf('const handleManageSubscription = async () => {'));
  assert.doesNotMatch(fn, /isGuest.*Alert\.alert\(t\('plans\.signInRequired'\)/);
  assert.match(fn, /const identity = await boundedPaymentTask\(resolvePurchaseIdentity, PAYMENT_UI_WAIT_TIMEOUT_MS,/);
  assert.match(fn, /const result = await subscriptionService\.restore\(identity\.token, identity\.account\);/);
});
check('the Restore button is no longer disabled for guests', () => {
  assert.doesNotMatch(plans, /disabled=\{busy !== null \|\| isGuest \|\| !accessToken\}/);
});

console.log('\nG5 — relaunch preserves the guest entitlement');
check('G5: ensureGuestIapIdentity reuses a PERSISTED session first — it does not mint a new identity every call', () => {
  const fn = guestIap.slice(guestIap.indexOf('export async function ensureGuestIapIdentity'), guestIap.indexOf('export async function hasGuestIapIdentity'));
  const getAt = fn.indexOf('guestIapSupabase.auth.getSession()');
  const signInAt = fn.indexOf('guestIapSupabase.auth.signInAnonymously()');
  assert.ok(getAt > 0 && signInAt > getAt, 'an existing persisted session must be checked before minting a new anonymous one');
  assert.match(guestIapClient, /persistSession: true/);
  assert.match(guestIapClient, /autoRefreshToken: true/);
});
check('the Plans screen re-checks guest status on focus/foreground WITHOUT creating a new identity just from viewing', () => {
  assert.match(plans, /if \(isGuest\) void loadGuestStatus\(\);/);
  const fn = guestIap.length ? plans.slice(plans.indexOf('const loadGuestStatus = useCallback'), plans.indexOf('const loadProducts = useCallback')) : '';
  assert.match(fn, /const hasIdentity = await hasGuestIapIdentity\(\);[\s\S]*if \(!hasIdentity\) \{/);
});

console.log('\nG6 — safe later account-link (same UUID, no silent transfer)');
check('G6: the upgrade uses SUPABASE\'S OWN anonymous-user upgrade (updateUser on the SAME session) — never a new signup', () => {
  const fn = guestIap.slice(guestIap.indexOf('export async function initiateGuestIapUpgrade'), guestIap.indexOf('export async function verifyGuestIapUpgrade'));
  assert.match(fn, /guestIapSupabase\.auth\.updateUser\(\{ email, password \}\)/);
  assert.doesNotMatch(fn, /supabase\.auth\.signUp/); // never the main client's normal signup
});
check('the upgrade is confirmed (not instant) and resolves to the SAME account id throughout', () => {
  const fn = guestIap.slice(guestIap.indexOf('export async function verifyGuestIapUpgrade'), guestIap.indexOf('export type GuestIapAccountConflict'));
  assert.match(fn, /guestIapSupabase\.auth\.verifyOtp\(\{ email, token: code, type: 'email_change' \}\)/);
  assert.match(fn, /const accountId = data\.session\?\.user\?\.id \?\? data\.user\?\.id;/);
});
check('a genuine ownership conflict (different pre-existing account) is DETECTED and surfaced, never silently bypassed', () => {
  assert.match(guestIap, /export function detectGuestIapAccountConflict/);
  const fn = guestIap.slice(guestIap.indexOf('export function detectGuestIapAccountConflict'));
  assert.match(fn, /conflict: Boolean\(guestAccountId && mainAccountId && guestAccountId !== mainAccountId\)/);
  // it only ever DETECTS — no code path in this module writes to any backend
  // table (no `.from(`, no ownership row mutation); it is auth-session-only.
  assert.doesNotMatch(guestIap, /\.from\(['"]/);
});

console.log('\nG7/G8 — backend ownership: Guest cross-device restore fixed, permanent-account anti-theft intact');
// Ownership now runs through a single database operation for guests and permanent users.
const ownershipSql = Object.values(backend.migration.fragments).map((fragment) => fragment.text).join('\n');
check('G7: every guest/permanent claim uses atomic ownership and state persistence', () => {
  const fn = iapSubscriptions.slice(iapSubscriptions.indexOf('export async function verifyAndPersistSubscription'));
  assert.match(fn, /return persistAtomic\(db, userId, verified, options\)/);
});
check('G7: a new anonymous or permanent claim requires its signed token to match', () => {
  assert.match(ownershipSql, /if v_token<>p_user_id then raise exception 'subscription_token_mismatch'/);
});
check('G8: a different permanent owner and guest duplicate are rejected before state creation', () => {
  assert.match(ownershipSql, /v_notification or v_caller_anonymous or not v_owner_anonymous/);
  assert.match(ownershipSql, /raise exception 'subscription_owner_conflict'/);
});
check('G8: promotion checks anonymous owner and atomically retires old guest state', () => {
  assert.match(ownershipSql, /v_owner_anonymous=billing_private\.lock_auth_identity\(b.user_id\)/);
  assert.match(ownershipSql, /update public.app_store_subscription_states set status='expired'/);
  assert.match(ownershipSql, /where original_transaction_id=v_original and user_id=b.user_id and owner_state='active'/);
});
check('AlreadyLinkedError / already-linked responses are still wired through the route (unchanged)', () => {
  assert.match(iapRoutes, /AlreadyLinkedError/);
  assert.match(iapRoutes, /iap_already_linked/);
});
check('no JWS/receipt payload is echoed back to the client (unchanged security posture)', () => {
  assert.doesNotMatch(iapRoutes, /res\.json\(\{[^}]*signedPayload/);
  // Whole-file negative: computed from the full backend routes file at the pinned revision (see the verifier script).
  assert.equal(backend.routes.echoesSignedPayloadInJson, false);
});

console.log('\nBackend contract provenance (pinned, machine-independent)');
const PINNED_BACKEND_REVISION = 'a1af8f42e980523437495af36bd3d997fbdd4bb1';
const PINNED_MIGRATION = 'supabase/migrations/20261003190154_payment_delivery_recovery.sql';
check('the backend contract is pinned to the payment delivery-recovery revision and its persistence migration', () => {
  assert.equal(backend.provenance.revision, PINNED_BACKEND_REVISION);
  assert.ok(Object.hasOwn(backend.provenance.files, PINNED_MIGRATION), 'the delivery-recovery persistence migration is part of the pinned contract');
  for (const blob of Object.values(backend.provenance.files)) assert.match(blob, /^[0-9a-f]{40}$/);
});
check('every pinned fragment is non-empty and nothing machine-specific is embedded in the fixture', () => {
  const fragments = [...Object.values(backend.migration.fragments), ...Object.values(backend.routes.fragments)];
  assert.equal(fragments.length, 8);
  for (const fragment of fragments) { assert.ok(fragment.text.length > 0); assert.ok(Number.isInteger(fragment.line) && fragment.line > 0); }
  assert.doesNotMatch(JSON.stringify(backend), /\/Users\/|\/home\/|[A-Za-z]:\\/);
});

console.log('\nG9 — signed-in purchase path unchanged');
check('G9: the non-guest branch of resolvePurchaseIdentity returns the EXACT SAME main-session token/account as before', () => {
  assert.match(plans, /if \(!isGuest\) return accessToken && accountId \? \{ token: accessToken, account: accountId \} : null;/);
});
check('subscriptionService.purchase/.restore signatures and call sites for the signed-in path are untouched', () => {
  assert.match(plans, /subscriptionService\.purchase\(selectedPlan, identity\.token, identity\.account\)/);
  // identity.token === accessToken and identity.account === accountId for a signed-in user (proven above) — same values, same call.
});

console.log('\nG10 — Cloud Library stays completely inactive for the guest IAP identity');
check('G10: guestIapSupabase is never imported by AuthProvider (lib/auth.tsx)', () => {
  assert.doesNotMatch(authLib, /guestIap/i);
});
check('G10: guestIapSupabase is never imported by the Cloud Library store (lib/store.tsx)', () => {
  assert.doesNotMatch(storeLib, /guestIap/i);
});
check('G10: Cloud Library keys sync ONLY off the main session\'s user id — never off any guest-IAP identity', () => {
  assert.match(storeLib, /const currentUserId = user\?\.id \?\? null;/);
});

console.log(`\nguest-purchase-architecture (G1–G10): ${passed} checks passed`);

// ══ Mutation guards ═══════════════════════════════════════════════════════
console.log('\nMutation guards');

// Ownership mutation/race coverage now lives in backend subscriptionAtomic.test.mjs,
// exercising the real PostgreSQL operation rather than obsolete JS claim helpers.

check('M5: requiring registration before purchase again makes the G2 assertion fail', () => {
  const mutant = plans.replace(
    "const handlePurchase = async () => {\n    if (purchaseLockRef.current",
    "const handlePurchase = async () => {\n    if (isGuest) return Alert.alert(t('plans.signInRequired'), t('plans.signInPurchase'));\n    if (purchaseLockRef.current",
  );
  assert.notEqual(mutant, plans);
  const fn = mutant.slice(mutant.indexOf('const handlePurchase = async () => {'), mutant.indexOf('const handleRefreshAccess = async () => {'));
  assert.match(fn, /isGuest.*Alert\.alert\(t\('plans\.signInRequired'\)/);
});

check('M6: wiring the isolated client into AuthProvider makes the G10 (AuthProvider) assertion fail', () => {
  const mutant = `${authLib}\nimport { guestIapSupabase } from './guestIapClient';`;
  assert.notEqual(mutant, authLib);
  assert.match(mutant, /guestIap/i);
});

check('M7: making the isolated client feed Cloud Library makes the G10 (store) assertion fail', () => {
  const mutant = storeLib.replace(
    'const currentUserId = user?.id ?? null;',
    "const currentUserId = user?.id ?? null; // guestIapSupabase.auth.getUser() fallback",
  );
  assert.notEqual(mutant, storeLib);
  assert.match(mutant, /guestIap/i);
});

console.log(`\nguest-purchase-architecture: ${passed} checks passed`);
