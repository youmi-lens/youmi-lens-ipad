/**
 * TestFlight build 57 physical failure (2026-09-30): a real Student purchase was rejected with "linked to another
 * account" and the NEXT tap on Subscribe then sat at "In Progress".
 *
 * Forensics established that the backend rejection is correct ownership protection (409 `iap_already_linked`, a
 * definitive outcome, so the client preserves the unfinished transaction) and that no service/UI guard stays set. The defect
 * was on the second attempt: when StoreKit re-delivers the already-processed transaction the listener dropped it as a
 * duplicate and nothing could settle the attempt until the 120 s purchase timeout.
 *
 * These tests drive the REAL production purchase service (lib/subscriptions.ts) and Plans handler through the payment
 * harness; only StoreKit, HTTP and the clock are simulated. The ownership rule itself is not touched: the backend
 * remains the authority, and nothing here ever grants an entitlement.
 *
 * Run: node --experimental-strip-types --test scripts/iap-linked-rejection-second-attempt.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT, ANNUAL, MONTHLY, flush, paymentHarness, track } from './helpers/payment-harness.mjs';

const OTHER_ACCOUNT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REJECTED = 'apple-lineage-transaction';
const LINKED_MESSAGE = 'This Apple subscription is linked to another Youmi Lens account.';

/** Backend answers 409 with `error` for the listed transaction ids and succeeds (grants) for every other one. */
const rejectTransactions = (h, ids, error = 'iap_already_linked') => {
  const normal = h.state.fetch;
  h.state.fetch = async (url, init) => {
    if (url.endsWith('/verify') && ids.includes(JSON.parse(init.body).transactionId)) {
      return h.response({ ok: false, error, message: 'linked to another account' }, 409);
    }
    return normal(url, init);
  };
};
const verifyCalls = (h) => h.state.http.filter(({ url }) => url.endsWith('/verify')).length;
const withLineage = (purchase, original) => ({ ...purchase, originalTransactionIdentifierIOS: original });

/** Attempt 1 that ends in a definitive ownership rejection; returns the rejected transaction. */
async function rejectedFirstAttempt(h, { id = REJECTED, original = 'otx-lineage-1', product = MONTHLY } = {}) {
  const first = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await flush();
  const owned = withLineage(h.transaction(product, id), original);
  h.emit(owned);
  const result = await first;
  return { owned, result };
}

test('1-2. first ownership rejection returns the linked-account error and clears all in-flight state', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  const first = h.plansAction();
  await flush();
  h.emit(h.transaction(MONTHLY, REJECTED));
  await first;
  assert.equal(h.state.busy, null, 'the Plans busy state is cleared');
  assert.equal(h.state.active, false, 'no entitlement is granted');
  assert.equal(h.state.finishes.length, 0, 'an unauthorized transaction remains unfinished');
  assert.equal(h.state.alerts.at(-1)[0], 'plans.purchaseIncomplete');
  assert.equal(h.state.alerts.at(-1)[1], LINKED_MESSAGE);
});

test('3. the second tap is accepted (not "purchase in progress") and reaches StoreKit', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  await rejectedFirstAttempt(h);
  const requests = h.state.requests.length;
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  assert.equal(second.settled, false);
  assert.equal(h.state.requests.length, requests + 1);
});

test('REPRODUCTION 4-6. StoreKit re-delivers the same transaction: the second attempt ends promptly with the same ownership error', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  const { owned, result } = await rejectedFirstAttempt(h);
  assert.equal(result.code, 'already_linked');
  assert.equal(verifyCalls(h), 1);

  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(owned);                      // the Apple ID already owns this lineage: StoreKit answers with the SAME transaction
  await flush();
  assert.equal(second.settled, true, 'settled without advancing the clock at all — no 120 s wait');
  assert.equal(second.value.code, 'already_linked');
  assert.equal(second.value.message, LINKED_MESSAGE);
  assert.equal(second.value.ok, false);
  assert.equal(h.state.active, false, 'no entitlement is granted');
  assert.equal(verifyCalls(h), 1, 'the remembered verdict is reused; the backend is not asked again');
  assert.equal(h.state.finishes.length, 0, 'repeated unauthorized transaction remains unfinished');
  const events = h.state.diagnostics.map(([event]) => event);
  assert.ok(events.includes('ownership_rejection_remembered') && events.includes('ownership_rejection_reused'));
  assert.doesNotMatch(JSON.stringify(h.state.diagnostics), new RegExp(`${ACCOUNT}|external-test-token|external-test-payload|${REJECTED}`));

  // Everything is clean again: a third tap is accepted.
  const requests = h.state.requests.length;
  const third = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  assert.equal(third.settled, false);
  assert.equal(h.state.requests.length, requests + 1);
});

test('the Plans screen also clears busy on the prompt terminal result', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  const { owned } = await rejectedFirstAttempt(h);
  const second = h.plansAction();
  await flush();
  h.emit(owned);
  await second;
  assert.equal(h.state.busy, null);
  assert.equal(h.state.alerts.at(-1)[1], LINKED_MESSAGE);
  assert.equal(h.state.active, false);
});

test('same lineage under a NEW transaction id (stale callback) also ends the attempt promptly, still without granting', async () => {
  const h = paymentHarness();
  // The real backend binds by original transaction id, so it rejects every transaction of this lineage.
  rejectTransactions(h, [REJECTED, 'renewal-in-same-lineage']);
  await rejectedFirstAttempt(h);
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit({ ...withLineage(h.transaction(MONTHLY, 'renewal-in-same-lineage'), 'otx-lineage-1'), transactionDate: 1 });
  await flush();
  assert.equal(second.value.code, 'already_linked');
  assert.equal(h.state.active, false);
});

test('iap_deleted_account_binding is the same permanent class: its result is remembered and replayed unchanged', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED], 'iap_deleted_account_binding');
  const { owned, result } = await rejectedFirstAttempt(h);
  assert.equal(result.code, 'backend_verification_failed', 'the first-attempt result is unchanged');
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush(); h.emit(owned); await flush();
  assert.equal(second.value.code, 'backend_verification_failed');
  assert.equal(second.value.message, result.message);
  assert.equal(h.state.active, false);
});

test('7. duplicates of a SUCCESSFUL transaction are unaffected: no grant, no ownership error, still pending', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  await rejectedFirstAttempt(h);
  // A different, successful purchase completes normally...
  const good = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await flush();
  const paid = withLineage(h.transaction(MONTHLY, 'paid-transaction'), 'otx-paid');
  h.emit(paid);
  assert.equal((await good).code, 'success');
  // ...and a duplicate of it does not resolve a later attempt or borrow the ownership rejection.
  const later = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush(); h.emit(paid); await flush();
  assert.equal(later.settled, false);
  h.error({ code: 'user-cancelled', message: 'User cancelled the purchase flow', productId: MONTHLY });
  await flush();
  assert.equal(later.value.code, 'cancelled');
});

test('a rejection never poisons unrelated attempts: other product, other lineage, other account', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  const { owned } = await rejectedFirstAttempt(h);

  // Other product: the rejected MONTHLY transaction cannot end an ANNUAL attempt.
  const annual = track(h.service.purchase('annual', 'external-test-token', ACCOUNT));
  await flush(); h.emit(owned); await flush();
  assert.equal(annual.settled, false);
  h.emit(h.transaction(ANNUAL, 'annual-new'));
  await flush();
  assert.equal(annual.value.code, 'success', 'and the annual attempt still completes normally');

  // Other lineage: a different, non-rejected transaction for the same product completes normally.
  const monthly = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await flush();
  h.emit(withLineage(h.transaction(MONTHLY, 'unrelated-new'), 'otx-other'));
  assert.equal((await monthly).code, 'success');

  // Other account: the same Apple transaction is not pre-judged for a different signed-in Youmi account.
  const h2 = paymentHarness();
  rejectTransactions(h2, [REJECTED]);
  const { owned: owned2 } = await rejectedFirstAttempt(h2);
  const switched = track(h2.service.purchase('monthly', 'external-test-token', OTHER_ACCOUNT));
  await flush(); h2.emit({ ...owned2, appAccountToken: OTHER_ACCOUNT }); await flush();
  assert.notEqual(switched.value?.code, 'already_linked', 'no reuse across accounts');
});

test('the remembered rejection is bounded: it expires, is size-capped, and is cleared on cleanup', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  const { owned } = await rejectedFirstAttempt(h);
  await h.advance(15 * 60 * 1000 + 1000);
  const late = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush(); h.emit(owned); await flush();
  assert.equal(late.settled, false, 'after the TTL the old verdict is not reused (existing safe behavior)');
  await h.advance(120_000);
  assert.equal(late.value.code, 'storekit_error');

  const many = paymentHarness();
  const ids = Array.from({ length: 50 }, (_, index) => `rejected-${index}`);
  rejectTransactions(many, ids);
  for (const id of ids) await rejectedFirstAttempt(many, { id, original: `otx-${id}` });
  assert.ok(many.service.ownershipRejections.size <= 32, `size capped, got ${many.service.ownershipRejections.size}`);
  many.service.cleanup();
  assert.equal(many.service.ownershipRejections.size, 0);
});

test('9. cancellation is unchanged after a rejection', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  await rejectedFirstAttempt(h);
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.error({ code: 'user-cancelled', message: 'User cancelled the purchase flow', productId: MONTHLY });
  await flush();
  assert.equal(second.value.code, 'cancelled');
  assert.equal(h.state.active, false);
});

test('10. with genuinely no terminal information the 120 s timeout still applies', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  await rejectedFirstAttempt(h);
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));   // StoreKit says nothing at all
  await h.advance(119_000);
  assert.equal(second.settled, false);
  await h.advance(2_000);
  assert.equal(second.value.code, 'storekit_error');
});

test('8. a stale/wrong-product callback stays safe: it is reconciled, never completes or fails the attempt', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  await rejectedFirstAttempt(h);
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(h.transaction(ANNUAL, 'annual-history'));
  await flush();
  assert.equal(second.settled, false);
  assert.ok(h.state.diagnostics.some(([event]) => event === 'transaction_ignored_wrong_attempt'));
  h.emit(h.transaction(MONTHLY, 'new-monthly'));
  await flush();
  assert.equal(second.value.code, 'success');
});

test('11. Restore is unchanged after a rejection', async () => {
  const h = paymentHarness();
  rejectTransactions(h, [REJECTED]);
  await rejectedFirstAttempt(h);
  h.state.purchases = [h.transaction(MONTHLY, 'restorable')];
  await h.settingsRestore();
  assert.equal(h.state.active, true);
  assert.ok(h.state.http.some(({ url }) => url.endsWith('/api/iap/restore')));
  assert.equal(h.state.restoring, false);
});
