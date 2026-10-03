/**
 * Follow-up to 7efca44 ("bound finishTransaction so a hung StoreKit finish
 * call can't spin the purchase UI forever").
 *
 * That fix covered the live purchase flow (lib/subscriptions.ts). It left
 * one other LIVE path with the identical bug class:
 *
 *   Settings -> Restore Purchase -> RealPurchaseService.restoreStudentPass
 *   (lib/purchases.ts)
 *
 * which used a raw, unbounded `fetch` (via its own local fetchJson) and an
 * unbounded `finishTransaction` call. `purchaseStudentPass` in the same
 * service is dead/unreferenced and is intentionally left untouched — only
 * restoreStudentPass and the helpers it actually calls are in scope here.
 *
 * lib/purchases.ts imports 'expo-iap' and 'react-native', which cannot be
 * executed under plain Node, so — matching the existing convention for this
 * file (see purchase-stall-fix.test.mjs, phase3-purchases.test.mjs) — the
 * purchases.ts-specific checks below are static/regex. The shared bounded
 * primitives it now reuses (boundedFetch, boundedVoidTask) are pure and are
 * exercised with real, restore-shaped behavioral tests.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { boundedFetch, BoundedFetchTimeoutError, isBoundedFetchTimeout } from '../lib/boundedFetch.ts';
import { boundedVoidTask } from '../lib/boundedTask.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const purchases = read('lib/purchases.ts');
const settings = read('app/(tabs)/settings.tsx');

const fetchJsonFn = purchases.slice(purchases.indexOf('async function fetchJson'), purchases.indexOf('function hasConnectionPrereqs'));
const restoreFn = purchases.slice(purchases.indexOf('async restoreStudentPass(accessToken'), purchases.indexOf('cleanup() {'));
const verifyFn = purchases.slice(purchases.indexOf('private async verifyPurchaseWithBackend('), purchases.length);
const handleRestoreFn = settings.slice(settings.indexOf('const handleRestorePurchases = async'), settings.indexOf('const handleClearData ='));

// ── Behavioral: the shared bounded primitives actually bound a hung backend
//    call and a hung finishTransaction call, in restore-shaped scenarios. ──

test('restore backend timeout: boundedFetch aborts a hung /api/iap/entitlement-shaped call', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  try {
    await assert.rejects(
      boundedFetch('https://example.com/api/iap/entitlement', {}, 30),
      isBoundedFetchTimeout,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('restore backend failure: a non-timeout fetch rejection is NOT reclassified as a timeout', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
  try {
    await assert.rejects(boundedFetch('https://example.com/api/iap/entitlement', {}, 1_000), (error) => {
      assert.equal(isBoundedFetchTimeout(error), false);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('finishTransaction hang: boundedVoidTask still resolves and reports the timeout', async () => {
  const start = Date.now();
  let timedOut = false;
  await boundedVoidTask(() => new Promise(() => {}), 30, () => {
    timedOut = true;
  });
  assert.ok(timedOut);
  assert.ok(Date.now() - start < 500);
});

test('finishTransaction success: boundedVoidTask resolves promptly without firing onTimeout', async () => {
  const start = Date.now();
  let timedOut = false;
  await boundedVoidTask(() => Promise.resolve(), 5_000, () => {
    timedOut = true;
  });
  assert.equal(timedOut, false);
  assert.ok(Date.now() - start < 200);
});

test('a BoundedFetchTimeoutError is recognizable so restore/verify callers can distinguish it', () => {
  assert.ok(isBoundedFetchTimeout(new BoundedFetchTimeoutError('x')));
  assert.ok(!isBoundedFetchTimeout(new Error('plain network error')));
});

// ── Static: purchases.ts now routes restore's network + native calls through
//    the shared bounded primitives — no second timeout implementation. ──

test('fetchJson (used by getBackendEntitlement + verifyPurchaseWithBackend) is bounded', () => {
  assert.match(fetchJsonFn, /await boundedFetch\(url/);
  assert.doesNotMatch(fetchJsonFn, /await fetch\(url/);
});

test('no raw unbounded fetch remains anywhere in purchases.ts', () => {
  assert.doesNotMatch(purchases, /await fetch\(/);
});

test('purchases.ts reuses the same primitives as the purchase-flow fix, not a second implementation', () => {
  assert.match(purchases, /from '\.\/boundedFetch'/);
  assert.match(purchases, /from '\.\/boundedTask'/);
  assert.doesNotMatch(purchases, /new AbortController\(\)/); // that logic lives only in boundedFetch.ts
});

test('finishTransaction in the restore/verify path is bounded, never awaited raw', () => {
  assert.match(purchases, /function finishTransactionBounded\(purchase: Purchase, isConsumable: boolean\): Promise<void> \{/);
  assert.match(purchases, /boundedVoidTask\(\s*\(\) => finishTransaction/);
  assert.match(verifyFn, /await finishTransactionBounded\(purchase, true\)/);
  assert.doesNotMatch(purchases, /await finishTransaction\(\{/);
});

// ── Static: every stage of restoreStudentPass reaches an explicit terminal
//    result — success, timeout, failure, no-purchases-found, already-active. ──

test('restore success: an active backend entitlement returns active_restored', () => {
  assert.match(purchases, /code: 'active_restored'/);
  assert.match(purchases, /entitlement\?\.active &&[\s\S]*STUDENT_ACCESS_PRODUCT_IDS\.has\(entitlement\.productId\)/);
});

test('entitlement already present: restore checks it BEFORE attempting any StoreKit recovery', () => {
  const initialResultIdx = restoreFn.indexOf('const initialResult = entitlementRestoreResult(initial.entitlement');
  const recoveryIdx = restoreFn.indexOf('const recovery = await this.recoverUnfinishedPurchases(accessToken)');
  assert.ok(initialResultIdx > -1 && recoveryIdx > -1 && initialResultIdx < recoveryIdx);
  assert.match(restoreFn, /if \(initialResult\) return initialResult;/);
});

test('restore backend timeout/failure on the FIRST entitlement read is a terminal, recoverable result (never hangs, never throws out)', () => {
  assert.match(
    restoreFn,
    /try \{\s*initial = await this\.getBackendEntitlement\(accessToken\);\s*\} catch \{\s*return \{ ok: false, code: 'failed'/,
  );
});

test('restore backend timeout/failure on the RECOVERY entitlement re-read falls back to the known-good prior read (never hangs, never throws out)', () => {
  assert.match(
    restoreFn,
    /try \{\s*refreshed = await this\.getBackendEntitlement\(accessToken\);\s*\} catch \{\s*refreshed = initial;\s*\}/,
  );
});

test('no purchases found: restore reaches an explicit no_eligible_purchase / unverified_history_unavailable result, not a hang', () => {
  assert.match(restoreFn, /'no_eligible_purchase'/);
  assert.match(restoreFn, /'unverified_history_unavailable'/);
  assert.match(restoreFn, /return \{\s*ok: false,\s*code,/);
});

test('no entitlement is granted without a valid backend verification (granted only on payload.ok && payload.granted)', () => {
  assert.match(verifyFn, /if \(status >= 200 && status < 300 && payload\?\.ok && payload\.granted\)/);
  assert.match(verifyFn, /return mapBackendError\(payload \?\? \{\}, status\);/);
});

// ── Static: the UI never spins forever and can't fire duplicate requests. ──

test('duplicate restore tap is blocked: guarded before dispatch and the row is disabled while restoring', () => {
  assert.match(handleRestoreFn, /if \(restoringPurchases\) return;/);
  assert.match(settings, /onPress=\{restoringPurchases \? undefined : \(\) => void handleRestorePurchases\(\)\}/);
});

test('restoringPurchases (the Restore Purchase spinner/busy flag) always clears via finally', () => {
  assert.match(handleRestoreFn, /finally \{\s*if \(restoreIdentity\.owns\(ticket\)\) \{\s*setRestoringPurchases\(false\);\s*logDiag\('restore_busy_cleared'\);\s*\}/);
});

test('a restore failure never throws out of handleRestorePurchases uncaught (caught and shown, loading still clears)', () => {
  assert.match(handleRestoreFn, /catch \(error\) \{[\s\S]*Alert\.alert\([\s\S]*\} finally \{/);
});
