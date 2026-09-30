/**
 * TestFlight build 57 physical failure (2026-09-30): a real Student purchase was rejected with "linked to another
 * account" and the NEXT tap on Subscribe then sat at "In Progress".
 *
 * Forensics (see the report) established:
 *  - the rejection is the backend's correct ownership protection (the Apple lineage is bound to another permanent
 *    account), returned as 409 `iap_already_linked` — a definitive outcome, so the client also finishes the transaction;
 *  - no service or UI guard stays set after that failure.
 * This file reproduces, against the REAL production purchase service (lib/subscriptions.ts, only StoreKit/HTTP/clock
 * mocked by the payment harness), the one path on which the SECOND attempt cannot finish: StoreKit hands back the
 * already-processed transaction (the Apple ID already owns that lineage), the listener drops it as a duplicate, and
 * nothing else can settle the attempt until the 120 s purchase timeout.
 *
 * Run: node --experimental-strip-types scripts/iap-linked-rejection-second-attempt.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT, MONTHLY, flush, paymentHarness, track } from './helpers/payment-harness.mjs';

const alreadyLinked = (h) => {
  const normal = h.state.fetch;
  h.state.fetch = async (url, init) => {
    if (url.endsWith('/verify')) return h.response({ ok: false, error: 'iap_already_linked', message: 'This App Store subscription is already linked to another account.' }, 409);
    return normal(url, init);
  };
};
const verifyCalls = (h) => h.state.http.filter(({ url }) => url.endsWith('/verify')).length;

test('CHARACTERIZATION: after a backend ownership rejection no service/UI guard stays set', async () => {
  const h = paymentHarness();
  alreadyLinked(h);
  const first = h.plansAction();
  await flush();
  h.emit(h.transaction());
  await first;
  assert.equal(h.state.busy, null, 'the Plans busy state is cleared');
  assert.equal(h.state.active, false, 'no entitlement was granted');
  assert.equal(h.state.finishes.length, 1, 'a definitive ownership rejection finishes the transaction');
  assert.equal(h.state.alerts.at(-1)[0], 'plans.purchaseIncomplete');
  assert.match(h.state.alerts.at(-1)[1], /linked to another Youmi Lens account/);

  // A second tap is accepted (not "purchase_in_progress") and reaches StoreKit again.
  const requestsBefore = h.state.requests.length;
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  assert.equal(second.settled, false);
  assert.equal(h.state.requests.length, requestsBefore + 1, 'the second attempt is a real, new StoreKit request');
  h.error({ code: 'user-cancelled', message: 'User cancelled the purchase flow', productId: MONTHLY });
  await flush();
  assert.equal(second.value.code, 'cancelled', 'and it can be ended normally when StoreKit does report an outcome');
});

test('REPRODUCTION: second attempt after an ownership rejection, StoreKit re-delivers the already-processed transaction', async () => {
  const h = paymentHarness();
  alreadyLinked(h);
  const first = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await flush();
  const owned = h.transaction(MONTHLY, 'apple-lineage-transaction');
  h.emit(owned);
  assert.equal((await first).code, 'already_linked');
  assert.equal(verifyCalls(h), 1);

  // Tap Subscribe again. The Apple ID already owns this subscription lineage, so StoreKit answers the new request with
  // the SAME transaction instead of a new one.
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(owned);
  await h.advance(15_000);

  const events = h.state.diagnostics.map(([event]) => event);
  assert.ok(events.includes('purchase_update_received'), 'the listener saw the re-delivered transaction');
  assert.ok(!events.includes('purchase_error_received'), 'StoreKit reported no error');
  assert.equal(second.settled, true,
    'the second attempt must reach a terminal result promptly; currently the duplicate is dropped silently and the attempt stays "in progress" until the 120 s timeout');
  assert.notEqual(second.value?.code, 'success', 'and it must never grant an entitlement for a transaction another account owns');
  assert.equal(h.state.active, false);
});

test('BOUND: the current code does eventually release the attempt at the 120 s purchase timeout', async () => {
  const h = paymentHarness();
  alreadyLinked(h);
  const first = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await flush();
  const owned = h.transaction(MONTHLY, 'apple-lineage-transaction');
  h.emit(owned);
  await first;
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush(); h.emit(owned);
  await h.advance(119_000);
  assert.equal(second.settled, false, 'still waiting just before the bound');
  await h.advance(2_000);
  assert.equal(second.settled, true);
  assert.equal(second.value.code, 'storekit_error', 'and it surfaces as a generic failure, not as the ownership outcome the user already saw');
});
