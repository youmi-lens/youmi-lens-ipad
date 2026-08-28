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

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const plans = read('../app/plans.tsx');
const settings = read('../app/(tabs)/settings.tsx');
const guestIap = read('../lib/guestIap.ts');
const guestIapClient = read('../lib/guestIapClient.ts');
const authLib = read('../lib/auth.tsx');
const storeLib = read('../lib/store.tsx');
const iapSubscriptions = read('../../youmi-lens/server/iapSubscriptions.mjs');
const iapRoutes = read('../../youmi-lens/server/iapRoutes.mjs');

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
check('G1: purchase visibility defaults to true for a guest with no known status (never hidden by a main-account-only gate)', () => {
  assert.match(plans, /const purchaseVisible = isGuest\s*\n\s*\? \(currentStatus \? shouldShowPurchaseEntry\(currentStatus\) : true\)/);
});
check('G2: handlePurchase no longer alerts sign-in-required for a guest — it resolves a guest-IAP identity instead', () => {
  const fn = plans.slice(plans.indexOf('const handlePurchase = async () => {'), plans.indexOf('const handleRefreshAccess = async () => {'));
  assert.doesNotMatch(fn, /isGuest.*Alert\.alert\(t\('plans\.signInRequired'\)/);
  assert.match(fn, /const identity = await resolvePurchaseIdentity\(\);/);
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
  assert.match(fn, /const identity = await resolvePurchaseIdentity\(\);/);
  assert.match(fn, /const result = await subscriptionService\.restore\(identity\.token\);/);
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
  assert.match(fn, /if \(!\(await hasGuestIapIdentity\(\)\)\) \{/);
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

console.log('\nG7/G8 — backend ownership: no cross-account claim, no transfer (unmodified)');
check('G7: assertSubscriptionIdentity requires appAccountToken === the verifying user — a different account cannot claim it', () => {
  assert.match(iapSubscriptions, /if \(verified\.appAccountToken\.toLowerCase\(\) !== requestingUserId\.toLowerCase\(\)\) \{/);
  assert.match(iapSubscriptions, /throw new SubscriptionAccountTokenError/);
});
check('G8: claimSubscriptionBinding rejects a second user for an existing originalTransactionId — no transfer path exists', () => {
  const fn = iapSubscriptions.slice(iapSubscriptions.indexOf('export async function claimSubscriptionBinding'), iapSubscriptions.indexOf('export function shouldReplaceSubscriptionState'));
  assert.match(fn, /if \(existing\.owner_state !== 'active' \|\| existing\.user_id !== userId\) \{/);
  assert.match(fn, /throw new SubscriptionAlreadyLinkedError/);
  // the race-condition branch (23505) enforces the SAME rule, not a bypass.
  assert.match(fn, /if \(raced\?\.owner_state === 'active' && raced\.user_id === userId/);
});
check('AlreadyLinkedError / already-linked responses are still wired through the route (unchanged)', () => {
  assert.match(iapRoutes, /AlreadyLinkedError/);
  assert.match(iapRoutes, /iap_already_linked/);
});
check('no JWS/receipt payload is echoed back to the client (unchanged security posture)', () => {
  assert.doesNotMatch(iapRoutes, /res\.json\(\{[^}]*signedPayload/);
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

check('M4: allowing ownership transfer (skip the appAccountToken check) makes the G7 assertion fail', () => {
  const mutant = iapSubscriptions.replace(
    "if (verified.appAccountToken.toLowerCase() !== requestingUserId.toLowerCase()) {\n    throw new SubscriptionAccountTokenError('Subscription appAccountToken does not match this account')\n  }",
    '// ownership check removed',
  );
  assert.notEqual(mutant, iapSubscriptions);
  assert.doesNotMatch(mutant, /if \(verified\.appAccountToken\.toLowerCase\(\) !== requestingUserId\.toLowerCase\(\)\) \{/);
});

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
