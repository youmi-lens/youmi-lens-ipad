import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Build 46 — StoreKit purchase-presentation reliability + safe TestFlight
 * diagnostics.
 *
 * The vendored openiap CocoaPod (ios/Pods/openiap/...) is NOT part of this
 * repo (ios/ is gitignored, regenerated fresh by every EAS Build), so it
 * cannot be patched here in a way that ships. The equivalent-effect fix lives
 * at the JS layer we do control: never invoke requestPurchase unless
 * AppState.currentState is 'active' — the same protection the missing native
 * scene check was supposed to provide, applied one layer up.
 */
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const subscriptions = stripComments(read('../lib/subscriptions.ts'));
const plans = stripComments(read('../app/plans.tsx'));
const iapDiag = stripComments(read('../lib/iapDiag.ts'));

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const requestWithTimeoutFn = subscriptions.slice(
  subscriptions.indexOf('private requestWithTimeout('),
  subscriptions.indexOf('private async verify('),
);

// =====================================================================
console.log('A-D — presentation only proceeds against a confirmed active scene');
// =====================================================================

check('A: the guard checks AppState.currentState === \'active\' before anything else runs', () => {
  assert.match(requestWithTimeoutFn, /const appState = AppState\.currentState;/);
  assert.match(requestWithTimeoutFn, /const sceneActive = appState === 'active';/);
  // The active-scene check must appear textually BEFORE requestPurchase is
  // invoked — proving requestPurchase can never fire while inactive.
  const checkIndex = requestWithTimeoutFn.indexOf('const sceneActive');
  const purchaseIndex = requestWithTimeoutFn.indexOf('requestPurchase({');
  assert.ok(checkIndex > -1 && purchaseIndex > -1 && checkIndex < purchaseIndex, 'active-scene check must precede requestPurchase');
});

check('B/C/D: any non-\'active\' AppState (inactive, background, or unknown) is rejected — single inclusive guard, no partial allowlist', () => {
  // The guard is `!sceneActive`, i.e. `appState !== 'active'` — this collapses
  // 'inactive', 'background', and any other/undefined value into one
  // rejection path. There must be no additional `|| appState === 'inactive'`
  // style carve-out that would let a non-active state slip through.
  assert.match(requestWithTimeoutFn, /if \(!sceneActive\) \{/);
  assert.doesNotMatch(requestWithTimeoutFn, /appState === 'inactive'/);
  assert.doesNotMatch(requestWithTimeoutFn, /appState === 'background'/);
});

check('requestPurchase is never reached on the inactive path — it is inside the early-return branch\'s sibling code, not called before the guard', () => {
  const guardBlock = requestWithTimeoutFn.slice(
    requestWithTimeoutFn.indexOf('if (!sceneActive) {'),
    requestWithTimeoutFn.indexOf('timer = setTimeout('),
  );
  assert.doesNotMatch(guardBlock, /requestPurchase/, 'requestPurchase must not appear in the inactive-scene branch');
  assert.match(guardBlock, /finish\('reject', error\);\s*return;/);
});

// =====================================================================
console.log('E — rejection propagates through the existing, unmodified error path');
// =====================================================================

check('E: presentation_not_active is mapped to a normal, recoverable SubscriptionResult (never an uncaught throw)', () => {
  assert.match(subscriptions, /error\.name = 'presentation_not_active';/);
  assert.match(subscriptions, /if \(name === 'presentation_not_active'\) return result\('presentation_unavailable'\);/);
  assert.match(subscriptions, /presentation_unavailable: '/, 'a user-facing message must exist for the new code');
  // mapError is only ever reached via purchase()'s catch block — confirming
  // the new error name is handled by the SAME catch-all used for every other
  // StoreKit error, not a new bespoke throw path.
  const purchaseFn = subscriptions.slice(subscriptions.indexOf('async purchase('), subscriptions.indexOf('private requestWithTimeout'));
  assert.match(purchaseFn, /catch \(error\) \{\s*return this\.mapError\(error\);/);
});

// =====================================================================
console.log('F/G — busy clears, and the 120s bound is untouched');
// =====================================================================

check('F: plans.tsx still clears `busy` for the current account in handlePurchase\'s finally, now alongside a diagnostic (not instead of clearing it)', () => {
  const handlePurchaseFn = plans.slice(plans.indexOf('const handlePurchase = async'), plans.indexOf('const handleRefreshAccess'));
  assert.match(handlePurchaseFn, /finally \{\s*if \(actionIdentity\.owns\(actionTicket\)\) \{\s*purchaseLockRef\.current = false;\s*setBusy\(null\);\s*logDiag\('purchase_busy_cleared', \{ plan: selectedPlan \}\);\s*\}/);
});

check('G: the 120s purchase timeout constant and setTimeout wiring are unchanged', () => {
  assert.match(subscriptions, /const PURCHASE_TIMEOUT_MS = 120_000;/);
  assert.match(requestWithTimeoutFn, /timer = setTimeout\(\(\) => \{[\s\S]*?\}, PURCHASE_TIMEOUT_MS\);/);
});

// =====================================================================
console.log('H — diagnostics carry no sensitive identifiers');
// =====================================================================

check('H: logDiag event names are a closed, non-account-scoped allowlist', () => {
  assert.match(iapDiag, /const DIAG_EVENTS = \[/);
  for (const forbidden of ['account', 'email', 'token', 'uuid', 'receipt', 'jws', 'transaction_id']) {
    // Event *names* themselves must not reference identifiers (values are
    // checked separately below) — this catches an event like 'user_account_id'.
    const eventsBlock = iapDiag.slice(iapDiag.indexOf('const DIAG_EVENTS'), iapDiag.indexOf('] as const'));
    assert.doesNotMatch(eventsBlock, new RegExp(forbidden, 'i'), `DIAG_EVENTS must not include a "${forbidden}"-named event`);
  }
});

check('H: no logDiag call site in subscriptions.ts or plans.tsx passes an account/token/transaction/receipt value', () => {
  for (const source of [subscriptions, plans]) {
    const calls = source.match(/logDiag\([^)]*\)/gs) ?? [];
    for (const call of calls) {
      assert.doesNotMatch(call, /accessToken|accountId|appAccountToken|purchase\.(purchaseToken|transactionId|originalTransactionIdentifierIOS)|\bjws\b|receipt|\bemail\b/i, `logDiag call carries a forbidden identifier: ${call}`);
    }
  }
});

check('H: logDiag itself only accepts primitive values (string | number | boolean | null) — structurally cannot carry an object/blob', () => {
  assert.match(iapDiag, /type DiagValue = string \| number \| boolean \| null;/);
  assert.match(iapDiag, /data\?: Record<string, DiagValue>/);
});

console.log(`\nstorekit-presentation: ${passed} checks passed`);
