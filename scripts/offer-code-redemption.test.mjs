import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ACCOUNT, MONTHLY, flush, paymentHarness, track } from './helpers/payment-harness.mjs';

/**
 * In-app "Have an offer code? Redeem" entry (Apple's native offer-code sheet).
 *
 * Behavior is exercised against the REAL lib/subscriptions.ts, lib/subscriptionReconciliation.ts and the real
 * Plans/Settings handlers (payment harness); only native StoreKit/HTTP/clock are stubbed. Source guards then pin the
 * release gate, the platform rule, and that redemption never becomes a second entitlement path.
 */
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const plansSource = read('../app/plans.tsx');
const settingsSource = read('../app/(tabs)/settings.tsx');
const subscriptionsSource = read('../lib/subscriptions.ts');
const gateSource = read('../lib/offerCodes.ts');

function withSheet(h, impl) {
  h.state.sheetCalls = 0;
  h.iap.presentCodeRedemptionSheetIOS = async () => { h.state.sheetCalls += 1; return impl ? impl() : true; };
}
const diagNames = (h) => h.state.diagnostics.map(([name]) => name);

test('OC1: presents Apple\'s sheet through expo-iap and reports presented', async () => {
  const h = paymentHarness();
  withSheet(h);
  const result = await h.service.presentOfferCodeRedemption();
  assert.equal(result, 'presented');
  assert.equal(h.state.sheetCalls, 1);
  assert.equal(h.state.initCalls, 1, 'uses the shared StoreKit connection, so the transaction listener is attached');
  assert.deepEqual(h.listenerCounts(), { updates: 1, errors: 1 });
  assert.ok(diagNames(h).includes('offer_code_sheet_requested'));
  assert.equal(h.state.requests.length, 0, 'never starts a requestPurchase');
});

test('OC2: never requests the sheet when the app is not foreground-active', async () => {
  const h = paymentHarness();
  withSheet(h);
  h.appState.setState('background');
  assert.equal(await h.service.presentOfferCodeRedemption(), 'presentation_unavailable');
  assert.equal(h.state.sheetCalls, 0);
});

test('OC3: a native failure maps to storekit_error (no throw)', async () => {
  const h = paymentHarness();
  withSheet(h, () => { throw Object.assign(new Error('boom'), { code: 'E_UNKNOWN' }); });
  assert.equal(await h.service.presentOfferCodeRedemption(), 'storekit_error');
});

test('OC4: the wait is bounded by foreground-active time only; running past the bound is not an error', async () => {
  const h = paymentHarness();
  withSheet(h, () => new Promise(() => {}));
  const observed = track(h.service.presentOfferCodeRedemption());
  await flush();
  h.appState.setState('inactive'); // Apple's sheet is up
  await h.advance(300_000);
  assert.equal(observed.settled, false, 'time spent inside Apple\'s sheet does not count');
  h.appState.setState('active');
  await h.advance(60_000);
  assert.equal(observed.settled, true);
  assert.equal(observed.value, 'presented');
});

test('OC5: a redeemed (token-less) transaction is deferred to reconciliation and restore sends it to the backend', async () => {
  const h = paymentHarness();
  withSheet(h);
  let activationSignals = 0;
  h.service.subscribeActivationPending(() => { activationSignals += 1; });
  await h.service.presentOfferCodeRedemption();
  // Apple's sheet cannot attach appAccountToken; the transaction carries the offer instead.
  const redeemed = { ...h.transaction(MONTHLY, 'offer-code-tx'), appAccountToken: null,
    offerIOS: { id: 'YOUMIDY30', type: 'code', paymentMode: 'pay-as-you-go' } };
  h.emit(redeemed);
  await flush();
  assert.ok(activationSignals >= 1, 'listener hands it to the shared reconciliation path');
  assert.equal(h.state.finishes.length, 0, 'never finished before the backend accepts it');
  h.state.purchases = [redeemed];
  const restored = await h.service.restore('external-test-token', ACCOUNT, { silent: true });
  const call = h.state.http.find(({ url }) => url.endsWith('/api/iap/restore'));
  assert.ok(call, 'restore posts to the backend');
  const body = JSON.parse(call.init.body);
  assert.equal(body.purchases[0].transactionId, 'offer-code-tx');
  assert.equal(body.purchases[0].signedTransactionInfo, 'external-test-payload', 'backend gets the Apple-signed JWS (offer fields inside)');
  assert.equal(restored.code, 'success');
  assert.equal(h.state.finishes.length, 1, 'finished only after the backend granted it');
});

test('OC6: reconciliation trigger offer_code_redeemed keeps a bounded retry going when delivery is still in flight', async () => {
  const h = paymentHarness();
  const { SubscriptionReconciliation } = h.load('lib/subscriptionReconciliation.ts');
  const calls = [];
  const service = {
    reconcileSilently: async () => { calls.push('reconcile'); return { ok: false, code: 'no_purchase', message: '' }; },
    getEntitlement: async () => ({ ok: true }),
  };
  const r = new SubscriptionReconciliation(service, async () => null);
  r.setSession('external-test-token', ACCOUNT);
  await r.request('offer_code_redeemed');
  assert.equal(calls.length, 1);
  await h.advance(5_000);
  assert.equal(calls.length, 2, 'a first no_purchase right after the sheet is retried, not treated as final');
});

function plansRedeem(h, { available = true, sheet = 'presented' } = {}) {
  const triggers = [];
  h.state.sheetResult = sheet;
  return { triggers, run: () => h.plansAction('handleRedeemOfferCode', {
    isOfferCodeRedemptionAvailable: () => available,
    subscriptionReconciliation: { request: async (trigger) => { triggers.push(trigger); return null; } },
    subscriptionService: { presentOfferCodeRedemption: async () => { h.state.sheetCalls = (h.state.sheetCalls ?? 0) + 1; return h.state.sheetResult; } },
  }) };
}

test('OC7: Plans redeem → sheet → shared reconciliation → backend status refresh; busy clears', async () => {
  const h = paymentHarness();
  const { triggers, run } = plansRedeem(h);
  await run();
  assert.equal(h.state.sheetCalls, 1);
  assert.deepEqual(triggers, ['offer_code_redeemed']);
  assert.ok(h.state.refreshes >= 1, 'access is re-read from the backend, never granted locally');
  assert.equal(h.state.busy, null);
  assert.equal(h.state.alerts.length, 0);
});

test('OC8: Plans redeem shows a localized alert when the sheet cannot open, and does nothing when the gate is off', async () => {
  const h = paymentHarness();
  const failing = plansRedeem(h, { sheet: 'storekit_error' });
  await failing.run();
  assert.deepEqual(h.state.alerts.at(-1), ['plans.appStoreUnavailable', 'plans.redeemCodeFailed']);
  assert.deepEqual(failing.triggers, []);
  assert.equal(h.state.busy, null);
  const h2 = paymentHarness();
  const off = plansRedeem(h2, { available: false });
  await off.run();
  assert.equal(h2.state.sheetCalls ?? 0, 0);
});

test('OC9: gate — iOS only, off by default, and never on without the live subscription surface', () => {
  const h = paymentHarness();
  const gate = h.load('lib/offerCodes.ts');
  assert.equal(gate.OFFER_CODES_LIVE, false, 'default build: hidden');
  assert.equal(gate.isOfferCodeRedemptionAvailable('ios', true), true);
  assert.equal(gate.isOfferCodeRedemptionAvailable('android', true), false);
  assert.equal(gate.isOfferCodeRedemptionAvailable('web', true), false);
  assert.equal(gate.isOfferCodeRedemptionAvailable('ios', false), false);
  assert.match(gateSource, /OFFER_CODES_LIVE = SUBSCRIPTIONS_LIVE && process\.env\.EXPO_PUBLIC_OFFER_CODES_LIVE === 'true'/);
});

test('OC10: entry points render only behind the gate, on Plans and in signed-in Settings', () => {
  assert.match(plansSource, /\{isOfferCodeRedemptionAvailable\(\) \? \(\s*<SecondaryButton\s*label=\{busy === 'redeem' \? t\('plans\.redeemCodeBusy'\) : t\('plans\.redeemCode'\)\}/);
  assert.match(settingsSource, /\{isOfferCodeRedemptionAvailable\(\) \? \(\s*<SettingRow icon="pricetag-outline" label=\{redeemingCode \? t\('plans\.redeemCodeBusy'\) : t\('plans\.redeemCode'\)\}/);
});

test('OC11: redemption is not a second entitlement path', () => {
  const fn = subscriptionsSource.slice(subscriptionsSource.indexOf('async presentOfferCodeRedemption'), subscriptionsSource.indexOf('async manageSubscriptions'));
  assert.match(fn, /presentCodeRedemptionSheetIOS\(\)/);
  assert.doesNotMatch(fn, /this\.pending|resolve\(|finishTransaction|\/api\/iap|requestPurchase/, 'no local grant, finish, or purchase attempt');
  // The purchase call itself is untouched (see free-trial-ux FT14).
  assert.doesNotMatch(subscriptionsSource, /promotionalOfferJWS|winBackOffer/i);
});

test('OC12: copy exists in all 6 locales and is really translated', async () => {
  const { DICTIONARIES } = await import('../lib/i18nCore.mjs');
  for (const key of ['plans.redeemCode', 'plans.redeemCodeBusy', 'plans.redeemCodeFailed']) {
    const en = DICTIONARIES.en[key];
    assert.ok(en, `en ${key}`);
    for (const locale of ['zh-Hans', 'ja', 'fr', 'es', 'ko']) {
      assert.ok(DICTIONARIES[locale][key], `${locale} ${key}`);
      assert.notEqual(DICTIONARIES[locale][key], en, `${locale} ${key} is untranslated`);
    }
  }
  assert.equal(DICTIONARIES['zh-Hans']['plans.redeemCode'], '有优惠码？兑换');
});

test('OC13: Settings redeem (signed-in) → sheet → shared reconciliation → plan reload; busy clears', async () => {
  const h = paymentHarness();
  const triggers = [];
  let busy = null; let reloads = 0;
  const Guard = h.load('lib/billingRequestIdentity.ts').BillingRequestIdentity;
  const redeemIdentity = new Guard(); redeemIdentity.setIdentity(ACCOUNT);
  await h.handler('app/(tabs)/settings.tsx', 'handleRedeemOfferCode', { ...h.common, redeemIdentity,
    redeemingCode: false, restoringPurchases: false, setRedeemingCode: (v) => { busy = v; },
    isOfferCodeRedemptionAvailable: () => true,
    subscriptionReconciliation: { request: async (trigger) => { triggers.push(trigger); return null; } },
    subscriptionService: { presentOfferCodeRedemption: async () => 'presented' },
    loadPlan: async () => { reloads += 1; return {}; },
  })();
  assert.deepEqual(triggers, ['offer_code_redeemed']);
  assert.equal(reloads, 1);
  assert.equal(busy, false);
  assert.equal(h.state.alerts.length, 0);
});

/** Plans scope wired to the REAL promptOfferCodeSignIn + handleSignIn, recording navigation. */
function plansSignInScope(h, nav) {
  const handleSignIn = h.handler('app/plans.tsx', 'handleSignIn', { exitGuest: async () => { nav.push('exitGuest'); },
    router: { replace: (path) => nav.push(`replace:${path}`) } });
  return { promptOfferCodeSignIn: h.handler('app/plans.tsx', 'promptOfferCodeSignIn', { ...h.common, handleSignIn }) };
}
const pressAlertButton = async (alert, label) => { alert[2].find((b) => b.text === label).onPress(); await flush(); };

test('OC14: a Guest is asked to sign in before Apple\'s sheet opens, and Sign In routes to auth', async () => {
  const h = paymentHarness();
  const nav = [];
  const triggers = [];
  await h.plansAction('handleRedeemOfferCode', { ...plansSignInScope(h, nav), isGuest: true,
    isOfferCodeRedemptionAvailable: () => true,
    subscriptionReconciliation: { request: async (trigger) => { triggers.push(trigger); return null; } },
    subscriptionService: { presentOfferCodeRedemption: async () => { h.state.sheetCalls = (h.state.sheetCalls ?? 0) + 1; return 'presented'; } },
  });
  assert.equal(h.state.sheetCalls ?? 0, 0, 'Apple never charges a Guest who cannot be bound');
  assert.deepEqual(triggers, []);
  assert.equal(h.state.busy, null);
  const alert = h.state.alerts.at(-1);
  assert.deepEqual(alert.slice(0, 2), ['plans.redeemCodeSignInTitle', 'plans.redeemCodeSignInRequired']);
  assert.deepEqual(alert[2].map((b) => b.text), ['common.cancel', 'common.signIn']);
  await pressAlertButton(alert, 'common.signIn');
  assert.deepEqual(nav, ['exitGuest', 'replace:/auth']);
});

test('OC15: no session is treated like a Guest (no sheet, sign-in prompt)', async () => {
  const h = paymentHarness();
  await h.plansAction('handleRedeemOfferCode', { ...plansSignInScope(h, []), session: null,
    isOfferCodeRedemptionAvailable: () => true,
    subscriptionService: { presentOfferCodeRedemption: async () => { h.state.sheetCalls = 1; return 'presented'; } },
  });
  assert.equal(h.state.sheetCalls ?? 0, 0);
  assert.equal(h.state.alerts.at(-1)[1], 'plans.redeemCodeSignInRequired');
});

test('OC16: a backend iap_account_required after the sheet shows the sign-in prompt instead of a refresh', async () => {
  const h = paymentHarness();
  const before = h.state.refreshes ?? 0;
  await h.plansAction('handleRedeemOfferCode', { ...plansSignInScope(h, []),
    isOfferCodeRedemptionAvailable: () => true,
    subscriptionReconciliation: { request: async () => ({ ok: false, code: 'offer_requires_account', message: '' }) },
    subscriptionService: { presentOfferCodeRedemption: async () => 'presented' },
  });
  assert.equal(h.state.alerts.at(-1)[1], 'plans.redeemCodeSignInRequired');
  assert.equal(h.state.refreshes ?? 0, before);
  assert.equal(h.state.busy, null);
});

test('OC17: verify 403 iap_account_required → offer_requires_account, transaction left unfinished and not remembered', async () => {
  const h = paymentHarness();
  const normal = h.state.fetch;
  let reject = true;
  h.state.fetch = async (url, init) => (reject && url.endsWith('/verify')
    ? h.response({ ok: false, error: 'iap_account_required', message: 'Sign in' }, 403) : normal(url, init));
  const attempt = h.service.purchase('monthly', 'external-test-token', ACCOUNT);
  await flush();
  const tx = h.transaction(MONTHLY, 'offer-needs-account');
  h.emit(tx);
  const outcome = await attempt;
  assert.equal(outcome.code, 'offer_requires_account');
  assert.match(outcome.message, /Sign in/);
  assert.equal(h.state.finishes.length, 0, 'kept for binding after sign-in');
  assert.equal(h.state.active, false);
  // Not an ownership verdict: once the account exists the same transaction is verified again and granted.
  reject = false;
  h.state.purchases = [tx];
  const restored = await h.service.restore('external-test-token', ACCOUNT, { silent: true });
  assert.equal(restored.code, 'success');
  assert.equal(h.state.finishes.length, 1);
});

test('OC18: restore outcome iap_account_required → offer_requires_account and nothing finished', async () => {
  const h = paymentHarness();
  h.state.fetch = async (url, init) => {
    if (!url.endsWith('/restore')) return h.response({ ok: true });
    const purchases = JSON.parse(init.body).purchases;
    return h.response({ ok: true, entitlement: null, restoredCount: purchases.length, verifiedTransactionIds: [],
      outcomes: purchases.map((p) => ({ transactionId: p.transactionId, code: 'iap_account_required', granted: false, safeToFinish: false, retryable: false })) });
  };
  h.state.purchases = [{ ...h.transaction(MONTHLY, 'guest-offer-tx'), appAccountToken: null }];
  const restored = await h.service.restore('external-test-token', ACCOUNT, { silent: true });
  assert.equal(restored.code, 'offer_requires_account');
  assert.equal(h.state.finishes.length, 0);
});

test('OC19: sign-in copy exists in all 6 locales, translated, with the exact Chinese prompt', async () => {
  const { DICTIONARIES } = await import('../lib/i18nCore.mjs');
  for (const key of ['plans.redeemCodeSignInTitle', 'plans.redeemCodeSignInRequired']) {
    for (const locale of ['zh-Hans', 'ja', 'fr', 'es', 'ko']) {
      assert.ok(DICTIONARIES[locale][key], `${locale} ${key}`);
      assert.notEqual(DICTIONARIES[locale][key], DICTIONARIES.en[key], `${locale} ${key} is untranslated`);
    }
  }
  assert.equal(DICTIONARIES['zh-Hans']['plans.redeemCodeSignInRequired'], '请先登录再兑换优惠码');
});
