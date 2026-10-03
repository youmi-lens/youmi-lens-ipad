import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCOUNT, ANNUAL, MONTHLY, flush, never, paymentHarness, track, transaction } from './helpers/payment-harness.mjs';

for (const product of [MONTHLY, ANNUAL]) {
  test(`P1 Settings restores current subscription ${product}`, async () => {
    const h = paymentHarness();
    h.state.purchases = [transaction(product)];
    await h.settingsRestore();
    assert.equal(h.state.active, true);
    assert.ok(h.state.http.some(({ url }) => url.endsWith('/api/iap/restore')));
    assert.equal(h.state.finishes.length, 1);
    assert.equal(h.state.finishes[0].purchase.productId, product);
    assert.equal(h.state.refreshes, 1);
    assert.equal(h.state.restoring, false);
    assert.equal(h.state.alerts[0][0], 'settings.alerts.accessRefreshedTitle');
  });
}

for (const stage of ['initConnection', 'fetchProducts']) {
  test(`P2 purchase ${stage} timeout clears actual UI busy and permits retry`, async () => {
    const h = paymentHarness();
    const normal = h.iap[stage];
    h.iap[stage] = never;
    const first = track(h.plansAction());
    await h.advance(60_000);
    assert.equal(first.settled, true);
    assert.equal(h.state.busy, null);
    assert.equal(h.state.active, false);
    h.iap[stage] = normal;
    const second = h.plansAction();
    await flush();
    h.emit(h.transaction());
    await second;
    assert.equal(h.state.active, true);
    assert.equal(h.state.busy, null);
  });
}
for (const stage of ['initConnection', 'syncIOS', 'getAvailablePurchases']) {
  test(`P2 Settings restore ${stage} timeout clears busy without success`, async () => {
    const h = paymentHarness();
    h.iap[stage] = never;
    const attempt = track(h.settingsRestore());
    await h.advance(60_000);
    assert.equal(attempt.settled, true);
    assert.equal(h.state.restoring, false);
    assert.equal(h.state.active, false);
    assert.equal(h.state.alerts[0][0], 'settings.alerts.accessStatusTitle');
  });
}
test('P2 purchase-sheet interaction keeps the existing 120-second window', async () => {
  const h = paymentHarness();
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await h.advance(30_000);
  assert.equal(attempt.settled, false);
  await h.advance(90_000);
  assert.equal(attempt.settled, true);
  assert.equal(h.state.active, false);
});

test('P3 simultaneous product/eligibility callers own one init and listener pair', async () => {
  const h = paymentHarness();
  await Promise.all([h.service.loadProducts(), h.service.getIntroOfferEligibility(), h.service.loadProducts(true)]);
  assert.equal(h.state.initCalls, 1);
  assert.deepEqual(h.listenerCounts(), { updates: 1, errors: 1 });
  h.service.cleanup();
  assert.deepEqual(h.listenerCounts(), { updates: 0, errors: 0 });
});

test('P3 cleanup during initialization cannot install stale listeners', async () => {
  const h = paymentHarness();
  let complete;
  h.iap.initConnection = () => new Promise((resolve) => { complete = resolve; });
  const oldLoad = h.service.loadProducts().catch(() => null);
  await flush();
  h.service.cleanup();
  complete(true);
  await oldLoad;
  assert.deepEqual(h.listenerCounts(), { updates: 0, errors: 0 });
  h.iap.initConnection = async () => true;
  await h.service.loadProducts();
  assert.deepEqual(h.listenerCounts(), { updates: 1, errors: 1 });
});

test('P4 matching callback completes the active attempt once', async () => {
  const h = paymentHarness();
  const attempt = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await flush();
  h.emit(h.transaction());
  h.emit(h.transaction());
  assert.equal((await attempt).code, 'success');
  assert.equal(h.state.http.filter(({ url }) => url.endsWith('/verify')).length, 1);
});

test('P4 wrong-product callback cannot complete a monthly attempt', async () => {
  const h = paymentHarness();
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(h.transaction(ANNUAL, 'annual-history'));
  await flush();
  assert.equal(attempt.settled, false);
  assert.ok(h.state.diagnostics.some(([event]) => event === 'transaction_ignored_wrong_attempt'));
  h.emit(h.transaction(MONTHLY, 'new-monthly'));
  await flush();
  assert.equal(attempt.value.code, 'success');
});

test('P4 paid transaction arriving after timeout is independently verified once', async () => {
  const h = paymentHarness();
  const first = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await h.advance(120_000);
  await first;
  const paid = h.transaction();
  h.emit(paid); h.emit(paid);
  await flush();
  assert.equal(h.state.http.filter(({ url }) => url.endsWith('/verify')).length, 1);
  assert.equal(h.state.active, true);
  assert.equal(h.state.finishes.length, 1);
  assert.ok(h.state.diagnostics.some(([event]) => event === 'late_transaction_received'));
});

test('P4 old same-product callback is reconciled without completing the next attempt', async () => {
  const h = paymentHarness();
  const first = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await flush();
  const old = h.transaction(MONTHLY, 'old-monthly');
  await h.advance(120_000); await first;
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit(old);
  await flush();
  assert.equal(second.settled, false);
  h.emit(h.transaction(MONTHLY, 'new-monthly'));
  await flush();
  assert.equal(second.value.code, 'success');
});

test('P4 duplicate of a completed transaction cannot resolve a later attempt', async () => {
  const h = paymentHarness();
  const first = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await flush();
  const paid = h.transaction();
  h.emit(paid); await first;
  const second = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush(); h.emit(paid); await flush();
  assert.equal(second.settled, false);
  assert.equal(h.state.http.filter(({ url }) => url.endsWith('/verify')).length, 1);
  h.error({ code: 'user-cancelled', message: 'User cancelled the purchase flow', productId: MONTHLY });
  await flush();
  assert.equal(second.value.code, 'cancelled');
});

for (const shape of ['native-listener', 'canonical-error', 'canonical-object', 'camel-code', 'legacy-code', 'expo-error']) {
  test(`P5 ${shape} cancellation clears busy, never verifies/refreshes, and permits retry`, async () => {
    const h = paymentHarness();
    if (shape !== 'native-listener') {
      const code = shape === 'camel-code' ? 'UserCancelled' : shape === 'legacy-code' ? 'E_USER_CANCELLED' : 'user-cancelled';
      let error = shape === 'canonical-object' ? { code, message: 'Operation interrupted' }
        : Object.assign(new Error('Operation interrupted'), { code });
      if (shape === 'expo-error') error = h.iap.createPurchaseError({ code, message: 'Operation interrupted' });
      h.iap.requestPurchase = async () => { throw error; };
    }
    const action = h.plansAction();
    await flush();
    if (shape === 'native-listener') h.error({ code: 'user-cancelled', message: 'User cancelled the purchase flow', productId: MONTHLY });
    await action;
    assert.equal(h.state.alerts.length, 0);
    assert.equal(h.state.http.filter(x=>!x.url.endsWith('/availability')&&!x.url.endsWith('/authorize')).length, 0);
    assert.equal(h.state.refreshes, 0);
    assert.equal(h.state.active, false);
    assert.equal(h.state.busy, null);
    assert.ok(h.state.diagnostics.some(([event]) => event === 'purchase_cancelled'));
    h.iap.requestPurchase = async () => [];
    const retry = h.plansAction();
    await flush(); h.emit(h.transaction()); await retry;
    assert.equal(h.state.active, true);
    assert.equal(h.state.busy, null);
  });
}

test('P6 no-purchase is a distinct terminal result from StoreKit query failure', async () => {
  const empty = paymentHarness();
  const noPurchase = await empty.service.restore('external-test-token');
  assert.equal(noPurchase.code, 'no_purchase');
  const failed = paymentHarness();
  failed.iap.getAvailablePurchases = async () => { throw new Error('private native stack detail'); };
  const failure = await failed.service.restore('external-test-token');
  assert.equal(failure.code, 'storekit_error');
  assert.notEqual(failure.message, noPurchase.message);
  assert.doesNotMatch(failure.message, /private|stack/);
  assert.equal(failed.state.http.length, 0);
  assert.ok(empty.state.diagnostics.some(([event]) => event === 'restore_no_purchase'));
  assert.ok(failed.state.diagnostics.some(([event]) => event === 'restore_query_failed'));
});

test('P6 Settings distinguishes empty history and query failure, and clears both spinners', async () => {
  const empty = paymentHarness();
  await empty.settingsRestore();
  const failed = paymentHarness();
  failed.iap.getAvailablePurchases = async () => { throw new Error('private native detail'); };
  await failed.settingsRestore();
  assert.notEqual(empty.state.alerts[0][1], failed.state.alerts[0][1]);
  assert.doesNotMatch(failed.state.alerts[0][1], /private|detail/);
  assert.equal(empty.state.restoring, false);
  assert.equal(failed.state.restoring, false);
});

for (const mode of ['success', 'backend-reject', 'backend-timeout', 'network-error', 'finish-timeout', 'finish-error', 'finish-sync-error', 'response-body-timeout']) {
  test(`matrix purchase ${mode}: terminal UI cleanup and authoritative entitlement`, async () => {
    const h = paymentHarness();
    const normalFetch = h.state.fetch;
    if (mode === 'backend-reject') h.state.fetch = async (url, init) => url.endsWith('/verify')
      ? h.response({ ok: false, granted: false }, 400) : normalFetch(url, init);
    if (mode === 'backend-timeout') h.state.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    if (mode === 'response-body-timeout') h.state.fetch = async () => ({ status: 200, json: never });
    if (mode === 'network-error') h.state.fetch = async () => { throw new Error('network unavailable'); };
    if (mode === 'finish-timeout') h.iap.finishTransaction = never;
    if (mode === 'finish-error') h.iap.finishTransaction = async () => { throw new Error('native failure'); };
    if (mode === 'finish-sync-error') h.iap.finishTransaction = () => { throw new Error('native failure'); };
    const action = track(h.plansAction());
    await flush(); h.emit(h.transaction());
    await h.advance(60_000);
    assert.equal(action.settled, true);
    assert.equal(h.state.busy, null);
    const verified = mode === 'success' || mode.startsWith('finish-');
    assert.equal(h.state.active, verified);
    assert.equal(h.state.refreshes, verified ? 1 : 0);
    if (verified) assert.equal(h.state.alerts[0][0], 'plans.activeTitle');
    if (mode === 'finish-timeout') assert.ok(h.state.diagnostics.some(([event]) => event === 'finish_timeout'));
    if (mode === 'finish-error' || mode === 'finish-sync-error') assert.ok(h.state.diagnostics.some(([event]) => event === 'finish_failed'));
    if (!verified) assert.ok(h.state.diagnostics.some(([event]) => event === 'verify_failed'));
  });
}

for (const mode of ['backend-timeout', 'finish-timeout', 'finish-error', 'backend-reject']) {
  test(`matrix Settings restore ${mode} clears busy without erasing verified entitlement`, async () => {
    const h = paymentHarness();
    h.state.purchases = [h.transaction()];
    const normalFetch = h.state.fetch;
    if (mode === 'backend-timeout') h.state.fetch = (url, init) => url.endsWith('/restore')
      ? new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      : normalFetch(url, init);
    if (mode === 'backend-reject') h.state.fetch = async (url, init) => url.endsWith('/restore')
      ? h.response({ ok: false, entitlement: { active: true }, verifiedTransactionIds: ['test-transaction'] }, 500)
      : normalFetch(url, init);
    if (mode === 'finish-timeout') h.iap.finishTransaction = never;
    if (mode === 'finish-error') h.iap.finishTransaction = async () => { throw new Error('native failure'); };
    const action = track(h.settingsRestore());
    await h.advance(60_000);
    assert.equal(action.settled, true);
    assert.equal(h.state.restoring, false);
    assert.equal(h.state.active, mode.startsWith('finish-'));
    assert.equal(h.state.alerts[0][0], mode.startsWith('finish-')
      ? 'settings.alerts.accessRefreshedTitle' : 'settings.alerts.accessStatusTitle');
    if (mode === 'backend-reject') assert.equal(h.state.finishes.length, 0);
  });
}

test('matrix entitlement refresh hang after valid purchase is bounded and keeps the grant', async () => {
  const h = paymentHarness();
  const normalFetch = h.state.fetch;
  h.state.fetch = async (url, init) => url.endsWith('/quota/status') ? { ok: true, json: never } : normalFetch(url, init);
  const action = track(h.plansAction());
  await flush(); h.emit(h.transaction());
  await h.advance(60_000);
  assert.equal(action.settled, true);
  assert.equal(h.state.busy, null);
  assert.equal(h.state.active, true);
  assert.equal(h.state.statusLoading, false);
  assert.ok(h.state.diagnostics.some(([event]) => event === 'entitlement_refresh_failed'));
});

test('matrix Settings refresh body stall also clears its plan-loading state', async () => {
  const h = paymentHarness();
  h.state.purchases = [h.transaction()];
  const normal = h.state.fetch;
  h.state.fetch = async (url, init) => url.endsWith('/quota/status') ? { ok: true, json: never } : normal(url, init);
  const action = track(h.settingsRestore());
  await h.advance(60_000);
  assert.equal(action.settled, true);
  assert.equal(h.state.restoring, false);
  assert.equal(h.state.planLoading, false);
  assert.equal(h.state.active, true);
});

test('P3 partial listener registration failure removes the first listener before retry', async () => {
  const h = paymentHarness();
  const normal = h.iap.purchaseErrorListener;
  h.iap.purchaseErrorListener = () => { throw new Error('listener unavailable'); };
  await assert.rejects(h.service.loadProducts());
  assert.deepEqual(h.listenerCounts(), { updates: 0, errors: 0 });
  h.iap.purchaseErrorListener = normal;
  await h.service.loadProducts();
  assert.deepEqual(h.listenerCounts(), { updates: 1, errors: 1 });
});

test('matrix guest identity stall is bounded before the purchase sheet', async () => {
  const h = paymentHarness();
  h.auth.getSession = never;
  const identity = h.handler('app/plans.tsx', 'resolvePurchaseIdentity', { isGuest: true,
    ensureGuestIapIdentity: h.load('lib/guestIap.ts').ensureGuestIapIdentity, setGuestAccountId() {} });
  const action = track(h.plansAction('handlePurchase', { resolvePurchaseIdentity: identity }));
  await h.advance(60_000);
  assert.equal(action.settled, true);
  assert.equal(h.state.busy, null);
  assert.equal(h.state.requests.length, 0);
});

test('release diagnostics cover successful purchase/restore without sensitive values', async () => {
  const h = paymentHarness();
  const action = h.plansAction();
  await flush(); h.emit(h.transaction()); await action;
  h.state.purchases = [h.transaction()];
  await h.settingsRestore();
  const events = h.state.diagnostics.map(([event]) => event);
  for (const event of ['purchase_request_start', 'purchase_update_received', 'verify_started', 'verify_succeeded',
    'finish_started', 'finish_succeeded', 'restore_started', 'restore_verified',
    'entitlement_refresh_started', 'entitlement_refresh_succeeded', 'purchase_busy_cleared', 'restore_busy_cleared']) {
    assert.ok(events.includes(event), event);
  }
  assert.doesNotMatch(JSON.stringify(h.state.diagnostics), new RegExp(`${ACCOUNT}|external-test-token|external-test-payload|test-transaction`));
});

test('P4 wrong account and unsigned callbacks never grant or finish', async () => {
  const h = paymentHarness();
  const attempt = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  h.emit({ ...h.transaction(MONTHLY, 'other-account'), appAccountToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  await flush();
  assert.equal(attempt.settled, false);
  assert.equal(h.state.http.filter(x=>!x.url.endsWith('/availability')&&!x.url.endsWith('/authorize')).length, 0);
  h.emit({ ...h.transaction(MONTHLY, 'unsigned'), purchaseToken: null });
  await flush();
  assert.equal(attempt.value.code, 'backend_verification_failed');
  assert.equal(h.state.active, false);
  assert.equal(h.state.finishes.length, 0);
});

test('P4 callback without known identity stays unfinished until safe reconciliation', async () => {
  const h = paymentHarness();
  await h.service.loadProducts();
  const old = h.transaction(ANNUAL, 'deferred-paid');
  h.emit(old); await flush();
  assert.equal(h.state.http.filter(x=>!x.url.endsWith('/availability')&&!x.url.endsWith('/authorize')).length, 0);
  assert.equal(h.state.finishes.length, 0);
  const current = track(h.service.purchase('monthly', 'external-test-token', ACCOUNT));
  await flush();
  assert.equal(current.settled, false);
  assert.equal(h.state.http.filter(({ url }) => url.endsWith('/verify')).length, 1);
  assert.equal(h.state.finishes.length, 1);
  h.error({ code: 'user-cancelled', message: 'User cancelled', productId: MONTHLY });
  await flush(); assert.equal(current.value.code, 'cancelled');
});

test('P4 failed late verification remains recoverable by explicit restore', async () => {
  const h = paymentHarness();
  const first = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await h.advance(120_000); await first;
  const normal = h.state.fetch;
  h.state.fetch = async (url, init) => url.endsWith('/verify') ? h.response({ ok: false }, 503) : normal(url, init);
  const paid = h.transaction();
  h.emit(paid); h.emit(paid); await flush();
  assert.equal(h.state.finishes.length, 0);
  assert.equal(h.state.active, false);
  assert.equal(h.state.http.filter(({ url }) => url.endsWith('/verify')).length, 1);
  h.state.purchases = [paid];
  const restored = await h.service.restore('external-test-token');
  assert.equal(restored.ok, true);
  assert.equal(h.state.active, true);
  assert.equal(h.state.finishes.length, 1);
});

test('P4 restore and purchase do not overlap verification', async () => {
  const h = paymentHarness();
  let completeSync;
  h.iap.syncIOS = () => new Promise((resolve) => { completeSync = resolve; });
  const restore = h.service.restore('external-test-token');
  await flush();
  assert.equal((await h.service.restore('external-test-token')).code, 'purchase_in_progress');
  assert.equal((await h.service.purchase('monthly', 'external-test-token', ACCOUNT)).code, 'purchase_in_progress');
  completeSync(true); await restore;
  assert.equal(h.state.http.filter(({ url }) => url.endsWith('/restore')).length, 1);
});

test('P3 timed-out init completing later cannot add another listener pair', async () => {
  const h = paymentHarness();
  let oldComplete;
  h.iap.initConnection = () => new Promise((resolve) => { oldComplete = resolve; });
  const old = h.service.loadProducts().catch(() => null);
  await h.advance(15_000); await old;
  h.iap.initConnection = async () => true;
  await h.service.loadProducts();
  oldComplete(true); await flush();
  assert.deepEqual(h.listenerCounts(), { updates: 1, errors: 1 });
  h.service.cleanup();
  assert.deepEqual(h.listenerCounts(), { updates: 0, errors: 0 });
});

for (const mode of ['success', 'no-purchase', 'query-error', 'network-error', 'finish-timeout']) {
  test(`matrix Plans restore ${mode} clears actual UI busy`, async () => {
    const h = paymentHarness();
    if (mode === 'success' || mode === 'finish-timeout') h.state.purchases = [h.transaction()];
    if (mode === 'query-error') h.iap.getAvailablePurchases = async () => { throw new Error('query failed'); };
    const normal = h.state.fetch;
    if (mode === 'network-error') h.state.fetch = async (url, init) => url.endsWith('/restore')
      ? Promise.reject(new Error('network unavailable')) : normal(url, init);
    if (mode === 'finish-timeout') h.iap.finishTransaction = never;
    const action = track(h.plansAction('handleRefreshAccess'));
    await h.advance(60_000);
    assert.equal(action.settled, true);
    assert.equal(h.state.busy, null);
    assert.equal(h.state.active, mode === 'success' || mode === 'finish-timeout');
    if (mode.endsWith('error')) assert.equal(h.state.alerts[0][0], 'plans.refreshFailed');
  });
}

for (const mode of ['storekit-error', 'pending', 'unavailable', 'inactive']) {
  test(`matrix purchase ${mode} is terminal without verification`, async () => {
    const h = paymentHarness();
    if (mode === 'unavailable') h.iap.fetchProducts = async () => [];
    if (mode === 'inactive') h.appState.currentState = 'background';
    const action = h.plansAction();
    await flush();
    if (mode === 'storekit-error') h.error({ code: 'purchase-error', message: 'native private detail', productId: MONTHLY });
    if (mode === 'pending') h.error({ code: 'deferred-payment', message: 'Awaiting approval', productId: MONTHLY });
    await action;
    assert.equal(h.state.busy, null);
    assert.equal(h.state.active, false);
    assert.equal(h.state.refreshes, 0);
    assert.equal(h.state.http.filter(x=>!x.url.endsWith('/availability')&&!x.url.endsWith('/authorize')).length, 0);
    if (mode === 'inactive') assert.equal(h.state.requests.length, 0);
  });
}

// ---- Build 65: query-first Restore, best-effort active-time-bounded sync fallback ----
const RESTORE_TOKEN = 'external-test-token';
const restorePosts = (h) => h.state.http.filter(({ url }) => url.endsWith('/api/iap/restore'));
const SIGN_IN_FAILURE = /sign-in was not completed/;
/** Counts native calls and lets a test decide what each StoreKit stage does. */
function restoreProbe(h) {
  const calls = { sync: 0, query: 0 };
  h.iap.getAvailablePurchases = async () => { calls.query += 1; return h.state.purchases; };
  h.iap.syncIOS = async () => { calls.sync += 1; return true; };
  return calls;
}

test('B65-1 query-first: local history skips syncIOS and posts /restore exactly once', async () => {
  const h = paymentHarness();
  const calls = restoreProbe(h);
  h.state.purchases = [transaction()];
  const result = await h.service.restore(RESTORE_TOKEN, ACCOUNT);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'success');
  assert.equal(calls.sync, 0);
  assert.equal(calls.query, 1);
  assert.equal(restorePosts(h).length, 1);
  assert.equal(h.state.finishes.length, 1);
});

test('B65-2 empty first query: syncIOS runs once, the second query finds it, one POST', async () => {
  const h = paymentHarness();
  const calls = restoreProbe(h);
  h.iap.syncIOS = async () => { calls.sync += 1; h.state.purchases = [transaction()]; return true; };
  const result = await h.service.restore(RESTORE_TOKEN, ACCOUNT);
  assert.equal(result.ok, true);
  assert.equal(calls.sync, 1);
  assert.equal(calls.query, 2);
  assert.equal(restorePosts(h).length, 1);
});

test('B65-3 syncIOS hangs: the active-time budget clears busy, re-queries once, no POST, sign-in failure', async () => {
  const h = paymentHarness();
  const calls = restoreProbe(h);
  h.iap.syncIOS = () => { calls.sync += 1; return never(); };
  const attempt = track(h.service.restore(RESTORE_TOKEN, ACCOUNT));
  await h.advance(59_999);
  assert.equal(attempt.settled, false);
  await h.advance(1);
  assert.equal(attempt.settled, true);
  assert.equal(attempt.value.code, 'storekit_error');
  assert.match(attempt.value.message, SIGN_IN_FAILURE);
  assert.notEqual(attempt.value.code, 'offline');
  assert.notEqual(attempt.value.code, 'no_purchase');
  assert.equal(calls.sync, 1);
  assert.equal(calls.query, 2);
  assert.equal(restorePosts(h).length, 0);
  assert.equal(h.appState.listenerCount(), 0, 'the AppState subscription is released');
  h.iap.syncIOS = async () => true; // restoreInFlight was cleared: a new Restore is accepted
  assert.equal((await h.service.restore(RESTORE_TOKEN, ACCOUNT)).code, 'no_purchase');
});

test('B65-3b the wall-clock backstop ends a sync that never becomes active (finite worst case)', async () => {
  const h = paymentHarness();
  restoreProbe(h);
  h.iap.syncIOS = never;
  h.appState.currentState = 'background';
  const attempt = track(h.service.restore(RESTORE_TOKEN, ACCOUNT));
  await h.advance(179_999);
  assert.equal(attempt.settled, false);
  await h.advance(1);
  assert.equal(attempt.settled, true);
  assert.equal(attempt.value.code, 'storekit_error');
  assert.equal(restorePosts(h).length, 0);
});

for (const [name, reject] of [
  ['accountMissing', () => new Error('accountMissing')],
  ['serviceError', () => Object.assign(new Error('Service error'), { code: 'service-error' })],
]) {
  test(`B65-4 syncIOS rejects ${name}: still re-queries; succeeds if the transaction appears`, async () => {
    const h = paymentHarness();
    const calls = restoreProbe(h);
    h.iap.syncIOS = async () => { calls.sync += 1; h.state.purchases = [transaction()]; throw reject(); };
    const result = await h.service.restore(RESTORE_TOKEN, ACCOUNT);
    assert.equal(result.ok, true);
    assert.equal(calls.query, 2);
    assert.equal(restorePosts(h).length, 1);
  });
  test(`B65-4 syncIOS rejects ${name}: otherwise a specific sign-in error, never offline or no_purchase`, async () => {
    const h = paymentHarness();
    const calls = restoreProbe(h);
    h.iap.syncIOS = async () => { calls.sync += 1; throw reject(); };
    const result = await h.service.restore(RESTORE_TOKEN, ACCOUNT);
    assert.equal(result.code, 'storekit_error');
    assert.match(result.message, SIGN_IN_FAILURE);
    assert.equal(calls.query, 2);
    assert.equal(restorePosts(h).length, 0);
  });
}

test('B65-5 inactive/background time does not consume the active budget; active time still does', async () => {
  const h = paymentHarness();
  restoreProbe(h);
  let completeSync;
  h.iap.syncIOS = () => new Promise((resolve) => { completeSync = () => { h.state.purchases = [transaction()]; resolve(true); }; });
  const attempt = track(h.service.restore(RESTORE_TOKEN, ACCOUNT));
  await h.advance(40_000); // 40 s active
  h.appState.setState('inactive'); // the system sign-in alert
  await h.advance(50_000);
  h.appState.setState('background'); // gone to Settings
  await h.advance(40_000); // 130 s wall clock, still under the 180 s backstop
  assert.equal(attempt.settled, false);
  h.appState.setState('active');
  await h.advance(19_000); // 59 s active in total
  assert.equal(attempt.settled, false);
  completeSync();
  await h.advance(0);
  assert.equal(attempt.settled, true);
  assert.equal(attempt.value.ok, true);
  assert.equal(restorePosts(h).length, 1);

  const spent = paymentHarness();
  restoreProbe(spent);
  spent.iap.syncIOS = never;
  const exhausted = track(spent.service.restore(RESTORE_TOKEN, ACCOUNT));
  await spent.advance(40_000);
  spent.appState.setState('inactive');
  await spent.advance(50_000);
  spent.appState.setState('active');
  await spent.advance(19_999);
  assert.equal(exhausted.settled, false);
  await spent.advance(1); // 60 s of active time in total
  assert.equal(exhausted.settled, true);
  assert.equal(exhausted.value.code, 'storekit_error');
});

for (const late of ['resolves', 'rejects']) {
  test(`B65-6 a sync that ${late} after the timeout cannot change the result or POST again`, async () => {
    const h = paymentHarness();
    restoreProbe(h);
    let settleSync;
    h.iap.syncIOS = () => new Promise((resolve, reject) => { settleSync = late === 'resolves' ? () => resolve(true) : () => reject(new Error('accountMissing')); });
    const attempt = track(h.service.restore(RESTORE_TOKEN, ACCOUNT));
    await h.advance(60_000);
    assert.equal(attempt.settled, true);
    const first = attempt.value;
    h.state.purchases = [transaction()]; // the transaction shows up only after Restore has already ended
    settleSync();
    await h.advance(5_000);
    assert.equal(attempt.value, first);
    assert.equal(first.code, 'storekit_error');
    assert.equal(restorePosts(h).length, 0);
    assert.equal(h.state.finishes.length, 0);
  });
}

test('B65-7 duplicate Restore and purchase taps while the fallback waits keep the overlap protection', async () => {
  const h = paymentHarness();
  restoreProbe(h);
  let completeSync;
  h.iap.syncIOS = () => new Promise((resolve) => { completeSync = () => { h.state.purchases = [transaction()]; resolve(true); }; });
  const restore = h.service.restore(RESTORE_TOKEN, ACCOUNT);
  await flush();
  assert.equal((await h.service.restore(RESTORE_TOKEN, ACCOUNT)).code, 'purchase_in_progress');
  assert.equal((await h.service.purchase('monthly', RESTORE_TOKEN, ACCOUNT)).code, 'purchase_in_progress');
  completeSync();
  assert.equal((await restore).ok, true);
  assert.equal(restorePosts(h).length, 1);
});

test('B65-8 account switch during the fallback discards the stale result in Settings and Plans', async () => {
  const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const settings = paymentHarness();
  restoreProbe(settings);
  let finishSettingsSync;
  settings.iap.syncIOS = () => new Promise((resolve) => { finishSettingsSync = () => { settings.state.purchases = [transaction()]; resolve(true); }; });
  const settingsAction = track(settings.settingsRestore());
  await flush();
  settings.restoreIdentity.setIdentity(OTHER);
  finishSettingsSync();
  await settings.advance(1_000);
  assert.equal(settingsAction.settled, true);
  assert.equal(settings.state.alerts.length, 0, 'Settings shows nothing for the superseded account');

  const plans = paymentHarness();
  restoreProbe(plans);
  let finishPlansSync;
  plans.iap.syncIOS = () => new Promise((resolve) => { finishPlansSync = () => { plans.state.purchases = [transaction()]; resolve(true); }; });
  const plansAction = track(plans.plansAction('handleRefreshAccess'));
  await flush();
  plans.actionIdentity.setIdentity(OTHER);
  finishPlansSync();
  await plans.advance(1_000);
  assert.equal(plansAction.settled, true);
  assert.equal(plans.state.alerts.length, 0, 'Plans shows nothing for the superseded account');
});

test('B65-9 sync succeeds and the second query is still empty: existing no_purchase behaviour', async () => {
  const h = paymentHarness();
  const calls = restoreProbe(h);
  const result = await h.service.restore(RESTORE_TOKEN, ACCOUNT);
  assert.equal(result.code, 'no_purchase');
  assert.equal(calls.sync, 1);
  assert.equal(calls.query, 2);
  assert.equal(restorePosts(h).length, 1);
  assert.equal(h.state.finishes.length, 0);
});

for (const path of ['query-first', 'sync-fallback']) {
  test(`B65-10 backend iap_already_linked (${path}): ownership rejection is preserved and nothing is finished`, async () => {
    const h = paymentHarness();
    const calls = restoreProbe(h);
    if (path === 'sync-fallback') h.iap.syncIOS = async () => { calls.sync += 1; h.state.purchases = [transaction()]; return true; };
    else h.state.purchases = [transaction()];
    h.state.fetch = async (url) => (url.endsWith('/restore')
      ? h.response({ ok: true, alreadyLinked: true, restoredCount: 0, entitlement: { active: false, status: 'none' },
        outcomes: [{ transactionId: 'test-transaction', code: 'iap_already_linked', granted: false, safeToFinish: false, retryable: false }] })
      : h.response({ ok: true, entitlement: { active: false, status: 'none' } }));
    const result = await h.service.restore(RESTORE_TOKEN, ACCOUNT);
    assert.equal(result.code, 'already_linked');
    assert.equal(h.state.finishes.length, 0);
    assert.equal(h.state.active, false);
    assert.equal(restorePosts(h).length, 1);
    assert.equal(calls.sync, path === 'sync-fallback' ? 1 : 0);
  });
}

test('B65-11 nothing is finished unless the backend marks it safeToFinish', async () => {
  const h = paymentHarness();
  restoreProbe(h);
  h.state.purchases = [transaction(MONTHLY, 'tx-safe'), transaction(MONTHLY, 'tx-unsafe')];
  h.state.fetch = async (url) => (url.endsWith('/restore')
    ? h.response({ ok: true, entitlement: { active: true, status: 'active', productId: MONTHLY }, restoredCount: 2,
      outcomes: [
        { transactionId: 'tx-safe', code: 'active', granted: true, safeToFinish: true, retryable: false },
        { transactionId: 'tx-unsafe', code: 'iap_temporarily_unavailable', granted: false, safeToFinish: false, retryable: true },
      ] })
    : h.response({ ok: true }));
  await h.service.restore(RESTORE_TOKEN, ACCOUNT);
  assert.deepEqual(h.state.finishes.map(({ purchase }) => purchase.transactionId), ['tx-safe']);
});
