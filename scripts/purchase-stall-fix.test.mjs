/**
 * Build 44 — purchase-stall fix guards.
 *
 * Pins the invariant that NO backend/network stage in the subscription workflow
 * can leave the Subscribe UI spinning unbounded, and that the StoreKit purchase
 * has a single authoritative completion path (the event listener, not the
 * requestPurchase return value).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BoundedFetchTimeoutError,
  boundedFetch,
  isBoundedFetchTimeout,
  SUBSCRIPTION_FETCH_TIMEOUT_MS,
} from '../lib/boundedFetch.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const subs = read('lib/subscriptions.ts');
const planStatus = read('lib/planStatus.ts');
const plans = read('app/plans.tsx');

const purchaseFn = subs.slice(subs.indexOf('async purchase('), subs.indexOf('private requestWithTimeout('));
const verifyFn = subs.slice(subs.indexOf('private async verify('), subs.indexOf('async restore('));
const requestFn = subs.slice(subs.indexOf('private requestWithTimeout('), subs.indexOf('private async verify('));
const handlePurchaseFn = plans.slice(plans.indexOf('const handlePurchase = async'), plans.indexOf('const handleRefreshAccess = async'));
const loadStatusFn = plans.slice(plans.indexOf('const loadStatus = useCallback'), plans.indexOf('const loadProducts = useCallback'));

// ── Shared bounded fetch ────────────────────────────────────────────────────

test('boundedFetch aborts and throws a recognizable timeout error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }
    });
  try {
    await assert.rejects(boundedFetch('https://example.com/x', {}, 40), isBoundedFetchTimeout);
  } finally {
    globalThis.fetch = original;
  }
});

test('boundedFetch uses one centralized constant within 20–30s', () => {
  assert.ok(SUBSCRIPTION_FETCH_TIMEOUT_MS >= 20_000 && SUBSCRIPTION_FETCH_TIMEOUT_MS <= 30_000);
  assert.ok(subs.includes("from './boundedFetch'"));
  assert.ok(planStatus.includes("from './boundedFetch'"));
});

// ── P1/P2/P10/P13: single purchase, duplicate-blocked, bounded ──────────────

test('P1: requestPurchase begins once via the requestWithTimeout path', () => {
  assert.match(requestFn, /requestPurchase\(\{/);
});

test('P2/P13: duplicate taps/verify are blocked by purchaseInFlight + UI lock', () => {
  assert.match(purchaseFn, /if \(this\.purchaseInFlight\) return result\('purchase_in_progress'\)/);
  assert.match(handlePurchaseFn, /if \(purchaseLockRef\.current \|\| busy !== null/);
});

test('P10: the Apple purchase operation is bounded (120s) and pending is terminal', () => {
  assert.match(subs, /const PURCHASE_TIMEOUT_MS = 120_000/);
  assert.match(purchaseFn, /if \(purchase\.purchaseState === 'pending'\) return result\('pending'\)/);
});

// ── P12: single authoritative StoreKit completion path ─────────────────────

test('P12: requestPurchase completion is listener-authoritative (no .then resolution)', () => {
  // After requestPurchase(...) there must be a .catch, not a .then((value) => ...) that resolves.
  const call = requestFn.slice(requestFn.indexOf('requestPurchase({'));
  assert.match(call, /\.catch\(/);
  assert.doesNotMatch(call, /\.then\(\(value\)/);
  assert.doesNotMatch(call, /finish\('resolve', direct\)/);
});

test('P12: purchaseUpdatedListener is the authoritative resolve path', () => {
  assert.match(subs, /purchaseUpdatedListener\(\(purchase\) => \{/);
  assert.match(subs, /pending\?\.resolve\(purchase\)/);
});

// ── P6/P7: verify timeout / network error are bounded and recoverable ──────

test('P6: verify maps a bounded-fetch timeout to verify_timeout (never hangs)', () => {
  assert.match(verifyFn, /isBoundedFetchTimeout\(error\) \? result\('verify_timeout'\)/);
  assert.match(subs, /'verify_timeout'/);
  assert.match(subs, /verify_timeout:[\s\S]*You will not be charged again/);
});

test('P7: verify network/HTTP failure clears loading via a terminal result', () => {
  assert.match(verifyFn, /return isBoundedFetchTimeout\(error\) \? result\('verify_timeout'\) : result\('offline'\)/);
  assert.match(handlePurchaseFn, /finally \{\s*if \(actionIdentity\.owns\(actionTicket\)\) \{\s*purchaseLockRef\.current = false;\s*setBusy\(null\);[\s\S]*?\}/);
});

test('P6: fetchJson is bounded (mutation A: removing the timeout would fail)', () => {
  assert.match(subs, /const response = await boundedFetch\(url/);
  assert.doesNotMatch(subs, /const response = await fetch\(url/);
});

// ── P3/P4/P5: loading invariant ─────────────────────────────────────────────

test('P3/P4/P5: every purchase path reaches setBusy(null) in finally', () => {
  assert.match(handlePurchaseFn, /finally \{\s*if \(actionIdentity\.owns\(actionTicket\)\) \{\s*purchaseLockRef\.current = false;\s*setBusy\(null\);[\s\S]*?\}/);
});

test('P5: cancel is a terminal, loading-clearing path', () => {
  assert.match(handlePurchaseFn, /if \(result\.code === 'cancelled'\) return;/);
});

test('P6: verify timeout uses a non-"purchase failed" alert title', () => {
  assert.match(handlePurchaseFn, /if \(result\.code === 'verify_timeout'\) \{[\s\S]*?Alert\.alert\(t\('plans\.refreshNeeded'\), result\.message\);/);
});

// ── P8/P15: plan status bounded and non-destructive ─────────────────────────

test('P8: fetchPlanStatus is bounded (mutation B)', () => {
  assert.match(planStatus, /await boundedFetch\(\`\$\{API_BASE_URL\}\/api\/quota\/status\`/);
  assert.doesNotMatch(planStatus, /await fetch\(\`\$\{API_BASE_URL\}\/api\/quota\/status\`/);
});

test('P15: a refresh timeout does not wipe a previously known active entitlement', () => {
  // loadStatus only clears planStatus on sign-out; the catch path never setPlanStatus(null).
  assert.match(loadStatusFn, /setPlanStatus\(null\);[\s\S]*?return null;\s*\}/); // sign-out branch
  const catchBlock = loadStatusFn.slice(loadStatusFn.indexOf('catch (nextError)'));
  assert.doesNotMatch(catchBlock, /setPlanStatus\(null\)/);
});

// ── P9: restore bounded ─────────────────────────────────────────────────────

test('P9: restore maps timeout through mapError and is bounded', () => {
  assert.match(subs, /if \(isBoundedFetchTimeout\(error\)\) return result\('verify_timeout'\)/);
  assert.match(plans, /finally \{\s*if \(actionIdentity\.owns\(actionTicket\)\) \{\s*setBusy\(null\);\s*logDiag\('restore_busy_cleared'\);\s*\}/); // handleRefreshAccess
});

// ── P11/P13: transaction safety ─────────────────────────────────────────────

test('P11: verify timeout returns BEFORE finishTransaction (transaction not consumed/repurchased)', () => {
  const timeoutReturnIdx = verifyFn.indexOf("return isBoundedFetchTimeout(error) ? result('verify_timeout')");
  const finishIdx = verifyFn.indexOf('finishTransaction');
  assert.ok(timeoutReturnIdx > -1 && finishIdx > -1 && timeoutReturnIdx < finishIdx);
  assert.doesNotMatch(purchaseFn, /requestWithTimeout\(.*\)[\s\S]*requestWithTimeout\(/);
});

// ── P14: no sensitive logging ──────────────────────────────────────────────

test('P14: diagnostics never log transaction/auth secrets', () => {
  const logCalls = (subs.match(/logIap\([^)]*\)/g) ?? []).join(' ');
  assert.doesNotMatch(logCalls, /purchaseToken|signedTransactionInfo|accessToken|Authorization|Bearer/);
});
