/**
 * Regression test for the purchase/payment-screen infinite-spinner bug.
 *
 * Root cause: `finishTransaction` (expo-iap's native StoreKit bridge call,
 * `ExpoIapModule.finishTransaction`) was awaited directly in
 * lib/subscriptions.ts's `verify()` and `restore()` with no bound. By the
 * time it's called the backend has ALREADY granted or rejected the
 * entitlement, so a hang in that native call left `purchaseInFlight` /
 * `busy` stuck forever even though the purchase itself was already decided
 * — the classic "successful purchase but UI never reconciled it" hang class.
 *
 * Fix: route every `finishTransaction` call through `finishTransactionBounded`,
 * which uses the pure, RN-free `boundedVoidTask` helper (lib/boundedTask.ts)
 * to cap the wait and never reject, leaving the terminal purchase/restore
 * result to return promptly regardless of the native call's outcome.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { boundedVoidTask } from '../lib/boundedTask.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const subs = read('lib/subscriptions.ts');
const verifyFn = subs.slice(subs.indexOf('private async verify('), subs.indexOf('async restore('));
const restoreFn = subs.slice(subs.indexOf('async restore('), subs.indexOf('async getEntitlement('));

// ── Behavioral: boundedVoidTask actually bounds a hanging task ─────────────

test('boundedVoidTask resolves within the bound even if the task never settles', async () => {
  const start = Date.now();
  let timedOut = false;
  const neverResolves = () => new Promise(() => {}); // simulates a hung native bridge call
  await boundedVoidTask(neverResolves, 30, () => {
    timedOut = true;
  });
  assert.ok(timedOut, 'onTimeout must fire when the task never settles');
  assert.ok(Date.now() - start < 500, 'must not wait anywhere near the real deadline of "never"');
});

test('boundedVoidTask resolves promptly (not after the full timeout) when the task succeeds fast', async () => {
  const start = Date.now();
  await boundedVoidTask(() => Promise.resolve(), 5_000, () => {
    throw new Error('should not time out');
  });
  assert.ok(Date.now() - start < 200);
});

test('boundedVoidTask never rejects, even when the task rejects — the error is reported via onError', async () => {
  let reportedError = null;
  await assert.doesNotReject(
    boundedVoidTask(
      () => Promise.reject(new Error('native finishTransaction failed')),
      1_000,
      () => {},
      (error) => {
        reportedError = error;
      },
    ),
  );
  assert.ok(reportedError instanceof Error);
});

test('boundedVoidTask leaves no unhandled rejection when the task rejects AFTER the timeout already fired', async () => {
  let timedOut = false;
  let resolveTask;
  const task = () => new Promise((_resolve, reject) => { resolveTask = reject; });
  const p = boundedVoidTask(task, 20, () => {
    timedOut = true;
  });
  await p;
  assert.ok(timedOut);
  // Reject the underlying task well after boundedVoidTask already resolved.
  // node:test fails the run on an unhandled rejection, so this proves the
  // late rejection is safely swallowed (caught inside boundedVoidTask).
  resolveTask(new Error('late native rejection'));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

// ── Static: every finishTransaction call site in subscriptions.ts is bounded ─

test('finishTransactionBounded wraps the native finishTransaction call', () => {
  assert.match(subs, /function finishTransactionBounded\(purchase: Purchase, isConsumable: boolean\): Promise<void> \{/);
  assert.match(subs, /finishTransaction\(\{ purchase, isConsumable \}\)/);
  assert.match(subs, /boundedVoidTask\(\s*\(\) => finishTransaction/);
});

test('the purchase-verify path never awaits finishTransaction directly (only through the bounded wrapper)', () => {
  assert.match(verifyFn, /await finishTransactionBounded\(purchase, false\)/);
  assert.doesNotMatch(verifyFn, /await finishTransaction\(/);
});

test('the restore path never awaits finishTransaction directly (only through the bounded wrapper)', () => {
  assert.match(restoreFn, /await finishTransactionBounded\(purchase, /);
  assert.doesNotMatch(restoreFn, /await finishTransaction\(/);
});

test('no raw "await finishTransaction(" remains anywhere in subscriptions.ts', () => {
  assert.doesNotMatch(subs, /await finishTransaction\(\{/);
});

test('the finish-transaction bound is short relative to the 120s StoreKit purchase bound', () => {
  assert.match(subs, /const FINISH_TRANSACTION_TIMEOUT_MS = 10_000;/);
  assert.match(subs, /const PURCHASE_TIMEOUT_MS = 120_000;/);
});

test('a finish-transaction timeout is logged, not thrown, so it can never surface as a purchase failure', () => {
  assert.match(subs, /finishTransaction timed out; transaction left unfinished for replay\/restore/);
});
