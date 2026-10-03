import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseAvailablePlan,
  isFreeTrialPaymentMode,
  isTrialAvailable,
  isUuid,
  normalizeSubscriptionCatalog,
  shouldFinishSubscriptionTransaction,
} from '../lib/subscriptionCore.ts';
import {
  LEGACY_STUDENT_ACCESS_PRODUCT_IDS,
  SUBSCRIPTION_GROUP_ID,
  SUBSCRIPTION_PRODUCT_IDS,
  SUBSCRIPTION_PRODUCTS,
  isSubscriptionProductId,
  planForSubscriptionProductId,
  productIdForPlan,
} from '../lib/subscriptionProducts.ts';

const monthly = {
  id: SUBSCRIPTION_PRODUCTS.monthly.productId,
  displayName: 'Student Access Monthly',
  displayPrice: '€4.99',
  subscriptionPeriodNumberIOS: '1',
  subscriptionPeriodUnitIOS: 'month',
};
const annual = {
  id: SUBSCRIPTION_PRODUCTS.annual.productId,
  displayName: 'Student Access Annual',
  displayPrice: '¥7,800',
  subscriptionPeriodNumberIOS: '1',
  subscriptionPeriodUnitIOS: 'year',
};

test('product config: monthly and annual IDs are unique and stable', () => {
  assert.equal(new Set(SUBSCRIPTION_PRODUCT_IDS).size, 2);
  assert.equal(productIdForPlan('monthly'), 'com.aydenz.youmilensipad.student.monthly');
  assert.equal(productIdForPlan('annual'), 'com.aydenz.youmilensipad.student.annual');
  assert.equal(SUBSCRIPTION_GROUP_ID, '22109238');
});

test('product config: legacy consumables are excluded', () => {
  for (const legacy of LEGACY_STUDENT_ACCESS_PRODUCT_IDS) {
    assert.equal(SUBSCRIPTION_PRODUCT_IDS.includes(legacy), false);
    assert.equal(isSubscriptionProductId(legacy), false);
  }
});

test('product config: plan mapping uses IDs, not price strings', () => {
  assert.equal(planForSubscriptionProductId(monthly.id), 'monthly');
  assert.equal(planForSubscriptionProductId(annual.id), 'annual');
  assert.equal(planForSubscriptionProductId('$4.99'), null);
});

test('StoreKit loading: both localized products', () => {
  const catalog = normalizeSubscriptionCatalog([monthly, annual], SUBSCRIPTION_PRODUCTS);
  assert.equal(catalog.monthly?.displayPrice, '€4.99');
  assert.equal(catalog.annual?.displayPrice, '¥7,800');
  assert.equal(catalog.monthly?.periodUnit, 'month');
  assert.equal(catalog.annual?.periodUnit, 'year');
});

test('StoreKit loading: monthly only', () => {
  const catalog = normalizeSubscriptionCatalog([monthly], SUBSCRIPTION_PRODUCTS);
  assert.ok(catalog.monthly);
  assert.equal(catalog.annual, null);
  assert.equal(chooseAvailablePlan('annual', catalog), 'monthly');
});

test('StoreKit loading: annual only', () => {
  const catalog = normalizeSubscriptionCatalog([annual], SUBSCRIPTION_PRODUCTS);
  assert.equal(catalog.monthly, null);
  assert.ok(catalog.annual);
  assert.equal(chooseAvailablePlan('monthly', catalog), 'annual');
});

test('StoreKit loading: no products', () => {
  const catalog = normalizeSubscriptionCatalog([], SUBSCRIPTION_PRODUCTS);
  assert.equal(chooseAvailablePlan('annual', catalog), null);
});

test('StoreKit loading: ignores an unknown SKU', () => {
  const catalog = normalizeSubscriptionCatalog([{ ...monthly, id: 'unknown' }], SUBSCRIPTION_PRODUCTS);
  assert.deepEqual(catalog, { monthly: null, annual: null });
});

test('selection: annual remains the default when available', () => {
  const catalog = normalizeSubscriptionCatalog([monthly, annual], SUBSCRIPTION_PRODUCTS);
  assert.equal(chooseAvailablePlan('annual', catalog), 'annual');
});

test('selection: monthly and annual switches preserve product identity', () => {
  const catalog = normalizeSubscriptionCatalog([monthly, annual], SUBSCRIPTION_PRODUCTS);
  assert.equal(catalog[chooseAvailablePlan('monthly', catalog)]?.productId, monthly.id);
  assert.equal(catalog[chooseAvailablePlan('annual', catalog)]?.productId, annual.id);
});

test('transaction finish requires explicit authorized persistence success', () => {
  assert.equal(shouldFinishSubscriptionTransaction({ ok: true, granted: true, safeToFinish: true }), true);
  assert.equal(shouldFinishSubscriptionTransaction({ ok: true, granted: true }), false);
  for (const reason of ['expired', 'revoked', 'refunded', 'duplicate', 'sales_closed']) {
    assert.equal(shouldFinishSubscriptionTransaction({ ok: true, granted: false, reason }), false);
  }
});
test('transaction finish: retryable, verification, and ownership failures stay unfinished', () => {
  for (const error of ['network', 'iap_verification_failed', 'iap_already_linked', 'iap_deleted_account_binding']) {
    assert.equal(shouldFinishSubscriptionTransaction({ ok: false, error }), false);
  }
});

test('appAccountToken: accepts Supabase UUIDs and rejects arbitrary IDs', () => {
  assert.equal(isUuid('00000000-0000-4000-8000-000000000000'), true);
  assert.equal(isUuid('user-123'), false);
  assert.equal(isUuid(null), false);
});

// ── Build 45: free-trial introductory-offer fields ──────────────────────────

const monthlyWithTrial = {
  ...monthly,
  introductoryPriceIOS: '$0.00',
  introductoryPricePaymentModeIOS: 'free-trial',
  introductoryPriceNumberOfPeriodsIOS: '1',
  introductoryPriceSubscriptionPeriodIOS: { unit: 'MONTH', value: 1 },
};

test('FT1: introductory-offer fields survive normalization unchanged', () => {
  const catalog = normalizeSubscriptionCatalog([monthlyWithTrial, annual], SUBSCRIPTION_PRODUCTS);
  assert.equal(catalog.monthly?.introductoryPriceIOS, '$0.00');
  assert.equal(catalog.monthly?.introductoryPricePaymentModeIOS, 'free-trial');
  assert.equal(catalog.monthly?.introductoryPriceNumberOfPeriodsIOS, '1');
  assert.deepEqual(catalog.monthly?.introductoryPriceSubscriptionPeriodIOS, { unit: 'MONTH', value: 1 });
  // A product with no offer configured normalizes to explicit nulls, not
  // `undefined` — so downstream code can rely on the field always existing.
  assert.equal(catalog.annual?.introductoryPricePaymentModeIOS, null);
});

test('FT2: free-trial payment mode is recognized, other modes are not', () => {
  const catalog = normalizeSubscriptionCatalog([monthlyWithTrial], SUBSCRIPTION_PRODUCTS);
  assert.equal(isFreeTrialPaymentMode(catalog.monthly), true);
  for (const mode of ['pay-as-you-go', 'pay-up-front', 'empty', null, undefined]) {
    const product = { ...catalog.monthly, introductoryPricePaymentModeIOS: mode };
    assert.equal(isFreeTrialPaymentMode(product), false);
  }
  assert.equal(isFreeTrialPaymentMode(null), false);
});

test('FT6/FT7: normalized displayPrice is exactly StoreKit\'s own string — never a literal', () => {
  const catalog = normalizeSubscriptionCatalog([monthlyWithTrial, annual], SUBSCRIPTION_PRODUCTS);
  assert.equal(catalog.monthly.displayPrice, monthlyWithTrial.displayPrice);
  assert.equal(catalog.annual.displayPrice, annual.displayPrice);
  // Prove it is not coincidentally matching a hardcoded USD default: a
  // different localized currency string round-trips unchanged too.
  const jpy = normalizeSubscriptionCatalog([{ ...monthlyWithTrial, displayPrice: '¥650' }], SUBSCRIPTION_PRODUCTS);
  assert.equal(jpy.monthly.displayPrice, '¥650');
});

test('isTrialAvailable requires BOTH eligibility AND free-trial payment mode', () => {
  const catalog = normalizeSubscriptionCatalog([monthlyWithTrial, annual], SUBSCRIPTION_PRODUCTS);
  assert.equal(isTrialAvailable(catalog.monthly, true), true);
  // Mutation guard A: eligible=true alone is NOT sufficient without the
  // product's own free-trial payment mode.
  assert.equal(isTrialAvailable(catalog.annual, true), false, 'eligible=true without free-trial mode must not advertise a trial');
  // Mutation guard B: free-trial mode alone is NOT sufficient without
  // eligibility — this is what "fail closed" means in practice.
  assert.equal(isTrialAvailable(catalog.monthly, false), false, 'free-trial mode without eligibility must not advertise a trial');
  assert.equal(isTrialAvailable(null, true), false);
});


// Do not advertise a one-month offer when Apple reports different terms.
test('one-month trial copy requires the exact StoreKit duration', () => {
  for (const override of [
    { introductoryPriceSubscriptionPeriodIOS: 'week' },
    { introductoryPriceSubscriptionPeriodIOS: null },
    { introductoryPriceNumberOfPeriodsIOS: '2' },
    { introductoryPriceSubscriptionPeriodIOS: { unit: 'month', value: 3 } },
  ]) {
    const catalog = normalizeSubscriptionCatalog([{ ...monthlyWithTrial, ...override }], SUBSCRIPTION_PRODUCTS);
    assert.equal(isTrialAvailable(catalog.monthly, true), false);
  }
  const catalog = normalizeSubscriptionCatalog([{ ...monthlyWithTrial, introductoryPriceSubscriptionPeriodIOS: 'month' }], SUBSCRIPTION_PRODUCTS);
  assert.equal(isTrialAvailable(catalog.monthly, true), true);
});
