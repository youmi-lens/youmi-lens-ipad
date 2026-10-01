/**
 * TestFlight Build 60 physical result (2026-10-01, after the iPad restart): StoreKit presented Apple's
 * "You're currently subscribed" sheet, Product.purchase returned `success` and the purchase listener delivered the
 * account's EXISTING Monthly transaction. It matched the pending product and account but is older than the attempt, so
 * the listener classified it `not_matching_pending` and sent it to late reconciliation. The backend answered 409
 * `iap_already_linked` (correct ownership protection) and the client remembered it — but nothing ended the waiting
 * attempt, so the spinner stayed up ~60 s until StoreKit closed the connection and a generic `storekit_error` was shown.
 *
 * These tests drive the REAL production purchase service through the payment harness; only StoreKit, HTTP and the clock
 * are simulated. Nothing here changes who owns a transaction: the backend stays the authority and nothing is granted.
 *
 * Run: node --experimental-strip-types --test scripts/iap-late-ownership-rejection-settles-attempt.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT, ANNUAL, MONTHLY, flush, paymentHarness, track } from './helpers/payment-harness.mjs';

const OTHER_ACCOUNT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EXISTING = 'existing-subscription-transaction';
const LINKED_MESSAGE = 'This Apple subscription is linked to another Youmi Lens account.';

/** The account's pre-existing subscription transaction: same product + account, but older than the purchase attempt. */
const olderExisting = (h, { id = EXISTING, product = MONTHLY, account = ACCOUNT, original = 'otx-existing' } = {}) => ({
  ...h.transaction(product, id), appAccountToken: account, originalTransactionIdentifierIOS: original, transactionDate: 1,
});

/** Backend answers `error` (default: 409 ownership rejection) for the listed transaction ids; grants for every other one. */
const backendRejects = (h, ids, { error = 'iap_already_linked', status = 409 } = {}) => {
  const normal = h.state.fetch;
  h.state.fetch = async (url, init) => {
    if (url.endsWith('/verify') && ids.includes(JSON.parse(init.body).transactionId)) {
      return h.response({ ok: false, error, message: 'rejected' }, status);
    }
    return normal(url, init);
  };
};
const verifyCalls = (h) => h.state.http.filter(({ url }) => url.endsWith('/verify')).length;
const events = (h) => h.state.diagnostics.map(([event]) => event);

test('REPRODUCTION: an older matching transaction rejected for ownership ends the CURRENT attempt immediately', async () => {
  const h = paymentHarness();
  backendRejects(h, [EXISTING]);
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  assert.equal(h.state.requests.length, 1);

  h.emit(olderExisting(h));            // StoreKit's "already subscribed" answer
  await flush();                       // no clock advance at all: no 60 s / 120 s wait

  assert.ok(events(h).includes('transaction_ignored_wrong_attempt'), 'it went down the late-reconciliation path');
  assert.equal(verifyCalls(h), 1);
  assert.equal(attempt.settled, true, 'the waiting attempt is settled by the definitive backend verdict');
  assert.equal(attempt.value.code, 'already_linked');
  assert.equal(attempt.value.message, LINKED_MESSAGE);
  assert.equal(attempt.value.ok, false);
  assert.equal(h.state.active, false, 'no entitlement is granted');
  assert.equal(h.state.finishes.length, 1, 'finish policy unchanged: a definitive rejection finishes once');
  assert.equal(verifyCalls(h), 1, 'the backend is asked exactly once');
});

test('the Plans screen clears busy and shows the ownership message straight after the late verdict', async () => {
  const h = paymentHarness();
  backendRejects(h, [EXISTING]);
  const action = track(h.plansAction());
  await flush();
  h.emit(olderExisting(h));
  await flush();
  assert.equal(action.settled, true, 'the Plans handler returns without waiting for any timeout');
  assert.equal(h.state.busy, null);
  assert.equal(h.state.alerts.at(-1)[0], 'plans.purchaseIncomplete');
  assert.equal(h.state.alerts.at(-1)[1], LINKED_MESSAGE);
  assert.equal(h.state.active, false);
});

test('iap_deleted_account_binding (same permanent class) settles with the same result the first-attempt path gives', async () => {
  const h = paymentHarness();
  backendRejects(h, [EXISTING], { error: 'iap_deleted_account_binding' });
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(olderExisting(h));
  await flush();
  assert.equal(attempt.settled, true);
  assert.equal(attempt.value.code, 'backend_verification_failed');
  assert.equal(h.state.active, false);
});

test('afterwards StoreKit closing its connection changes nothing and the next tap is accepted', async () => {
  const h = paymentHarness();
  backendRejects(h, [EXISTING]);
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(olderExisting(h));
  await flush();
  assert.equal(attempt.value.code, 'already_linked');
  h.error({ code: 'service-error', message: 'StoreKit connection closed', productId: MONTHLY });
  await flush();
  assert.equal(attempt.value.code, 'already_linked', 'the settled result is final');
  const requests = h.state.requests.length;
  const next = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  assert.equal(next.settled, false);
  assert.equal(h.state.requests.length, requests + 1);
});

// ---------------------------------------------------------------- negative controls

test('NEG wrong product: an older ANNUAL transaction rejected for ownership cannot settle a pending MONTHLY attempt', async () => {
  const h = paymentHarness();
  backendRejects(h, ['annual-history']);
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(olderExisting(h, { id: 'annual-history', product: ANNUAL, original: 'otx-annual' }));
  await flush();
  assert.equal(verifyCalls(h), 1, 'the late reconciliation itself still runs');
  assert.equal(attempt.settled, false);
  h.emit(h.transaction(MONTHLY, 'new-monthly'));       // the real purchase still completes normally afterwards
  await flush();
  assert.equal(attempt.value.code, 'success');
});

test('NEG wrong account: an older transaction bound to another account is never verified for, or settles, this attempt', async () => {
  const h = paymentHarness();
  backendRejects(h, [EXISTING]);
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(olderExisting(h, { account: OTHER_ACCOUNT }));
  await flush();
  assert.equal(verifyCalls(h), 0, 'never guess an account for a paid transaction');
  assert.equal(attempt.settled, false);
  await h.advance(120_000);
  assert.equal(attempt.value.code, 'storekit_error', 'only the unchanged 120 s timeout ends it');
});

test('NEG unrelated historical transaction: one delivered BEFORE the attempt (replayed at attempt start) cannot settle it', async () => {
  const h = paymentHarness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const normal = h.state.fetch;
  let started = 0;
  h.state.fetch = async (url, init) => {
    if (url.endsWith('/verify') && JSON.parse(init.body).transactionId === EXISTING) {
      started += 1;
      await gate;
      return h.response({ ok: false, error: 'iap_already_linked', message: 'rejected' }, 409);
    }
    return normal(url, init);
  };
  await h.service.loadProducts();      // StoreKit connection + listeners are up (Plans screen opened)
  h.emit(olderExisting(h));            // delivered at launch with no attempt and no account context: preserved, not guessed
  await flush();
  assert.equal(started, 0);
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();                       // purchase() start replays it for reconciliation; the verdict is still outstanding
  assert.equal(started, 1);
  release();
  await flush();
  assert.equal(attempt.settled, false, 'a transaction that predates the attempt cannot end it');
  h.emit(h.transaction(MONTHLY, 'new-monthly'));
  await flush();
  assert.equal(attempt.value.code, 'success');
});

test('NEG unrelated historical transaction: a verdict arriving after the attempt that saw it ended cannot settle a LATER attempt', async () => {
  const h = paymentHarness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const normal = h.state.fetch;
  h.state.fetch = async (url, init) => {
    if (url.endsWith('/verify') && JSON.parse(init.body).transactionId === EXISTING) {
      await gate;
      return h.response({ ok: false, error: 'iap_already_linked', message: 'rejected' }, 409);
    }
    return normal(url, init);
  };
  const first = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(olderExisting(h));            // verification starts during attempt 1 and is held open by the backend
  await flush();
  h.error({ code: 'user-cancelled', message: 'User cancelled the purchase flow', productId: MONTHLY });
  await flush();                       // attempt 1 ends (the verdict for what it saw is still outstanding)
  assert.equal(first.value.code, 'cancelled');

  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  release();                           // the verdict for the OLD delivery now arrives while attempt 2 waits
  await flush();
  assert.ok(events(h).includes('ownership_rejection_remembered'), 'the late verdict did arrive and was recorded');
  assert.equal(second.settled, false, 'a verdict belonging to attempt 1 must not end attempt 2');
  h.emit(h.transaction(MONTHLY, 'new-monthly'));
  await flush();
  assert.equal(second.value.code, 'success');
});

test('NEG non-definitive failures never settle the attempt as an ownership rejection', async () => {
  for (const [label, backend] of [
    ['other 409 error', { error: 'iap_something_else', status: 409 }],
    ['server 500', { error: 'server_error', status: 500 }],
    ['403 without ownership error', { error: 'forbidden', status: 403 }],
  ]) {
    const h = paymentHarness();
    backendRejects(h, [EXISTING], backend);
    const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
    await flush();
    h.emit(olderExisting(h));
    await flush();
    assert.equal(attempt.settled, false, `${label}: attempt stays pending`);
    assert.ok(!events(h).includes('ownership_rejection_remembered'), `${label}: nothing remembered`);
  }
  // network failure
  const h = paymentHarness();
  const normal = h.state.fetch;
  h.state.fetch = async (url, init) => {
    if (url.endsWith('/verify')) throw new TypeError('Network request failed');
    return normal(url, init);
  };
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(olderExisting(h));
  await flush();
  assert.equal(attempt.settled, false, 'network failure: attempt stays pending');
});

test('CONTROL a verdict of success for the older transaction still never resolves or fails the attempt', async () => {
  const h = paymentHarness();            // backend grants everything
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(olderExisting(h));
  await flush();
  assert.equal(attempt.settled, false);
  assert.equal(h.state.active, true, 'reconciled independently, as before');
});
