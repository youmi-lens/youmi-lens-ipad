import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseAvailablePlan,
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

test('transaction finish: verified grants and definitive inactive states finish', () => {
  assert.equal(shouldFinishSubscriptionTransaction({ ok: true, granted: true }), true);
  for (const reason of ['expired', 'revoked', 'refunded', 'duplicate']) {
    assert.equal(shouldFinishSubscriptionTransaction({ ok: true, granted: false, reason }), true);
  }
});

test('transaction finish: retryable backend and network failures stay unfinished', () => {
  assert.equal(shouldFinishSubscriptionTransaction({ ok: false, error: 'network' }), false);
  assert.equal(shouldFinishSubscriptionTransaction({ ok: false, error: 'iap_verification_failed' }), false);
});

test('transaction finish: ownership conflicts are definitive', () => {
  assert.equal(shouldFinishSubscriptionTransaction({ error: 'iap_already_linked' }), true);
  assert.equal(shouldFinishSubscriptionTransaction({ error: 'iap_deleted_account_binding' }), true);
});

test('appAccountToken: accepts Supabase UUIDs and rejects arbitrary IDs', () => {
  assert.equal(isUuid('00000000-0000-4000-8000-000000000000'), true);
  assert.equal(isUuid('user-123'), false);
  assert.equal(isUuid(null), false);
});

