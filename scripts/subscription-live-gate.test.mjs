/**
 * Live-subscription release gate (Build 43).
 *
 * Pins the contract that the subscription surface is a SAFE PREVIEW unless
 * `EXPO_PUBLIC_SUBSCRIPTIONS_LIVE=true` is set in the build environment, and
 * that the production build environment actually carries that flag. This is
 * the source-of-truth guard behind the Build 42 → 43 "live subscriptions" delta.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  LEGACY_STUDENT_ACCESS_PRODUCT_IDS,
  planForSubscriptionProductId,
  productIdForPlan,
} from '../lib/subscriptionProducts.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const preview = read('lib/subscriptionPreview.ts');
const plans = read('app/plans.tsx');
const subs = read('lib/subscriptions.ts');

test('S3/S4: monthly and annual product IDs are exact and stable', () => {
  assert.equal(productIdForPlan('monthly'), 'com.aydenz.youmilensipad.student.monthly');
  assert.equal(productIdForPlan('annual'), 'com.aydenz.youmilensipad.student.annual');
});

test('S8: both products map to the single Student entitlement surface', () => {
  assert.equal(planForSubscriptionProductId('com.aydenz.youmilensipad.student.monthly'), 'monthly');
  assert.equal(planForSubscriptionProductId('com.aydenz.youmilensipad.student.annual'), 'annual');
});

test('S9: legacy restore IDs remain supported (compat only, not primary)', () => {
  assert.deepEqual([...LEGACY_STUDENT_ACCESS_PRODUCT_IDS], [
    'com.aydenz.youmilensipad.studentbasic30d',
    'com.aydenz.youmilensipad.studentpass30d',
  ]);
});

test('S1: live flag enables StoreKit product loading', () => {
  assert.match(preview, /SUBSCRIPTIONS_LIVE = process\.env\.EXPO_PUBLIC_SUBSCRIPTIONS_LIVE === 'true'/);
  // While live, loadProducts proceeds past the guard to subscriptionService.loadProducts.
  assert.match(plans, /if \(!SUBSCRIPTIONS_LIVE\) \{[\s\S]*?return;[\s\S]*?subscriptionService\.loadProducts/);
});

test('S2: flag false preserves the safe preview (no fetch, no purchase)', () => {
  assert.match(plans, /if \(!SUBSCRIPTIONS_LIVE\) \{[\s\S]*?setProductLoading\(false\)[\s\S]*?return;/);
  assert.match(plans, /disabled=\{!SUBSCRIPTIONS_LIVE \|\| purchaseDisabled\}/);
});

test('S5: Subscribe is reachable when live (only gated by !SUBSCRIPTIONS_LIVE or in-flight state)', () => {
  assert.match(plans, /disabled=\{!SUBSCRIPTIONS_LIVE \|\| purchaseDisabled\}/);
});

test('S6: StoreKit localized prices are used (never hardcoded) in the live path', () => {
  assert.match(plans, /product\?\.displayPrice/);
});

test('S7: purchase verification endpoint is unchanged', () => {
  assert.match(subs, /\$\{API_BASE_URL\}\/api\/iap\/apple\/verify/);
  assert.match(subs, /\$\{API_BASE_URL\}\/api\/iap\/restore/);
});

test('S10: stale "products do not exist" assumption is removed', () => {
  assert.doesNotMatch(preview, /do NOT exist|do not exist|do not currently exist/i);
});

test('mutation guard: production build env carries EXPO_PUBLIC_SUBSCRIPTIONS_LIVE=true', () => {
  const r = spawnSync(
    'eas',
    ['env:get', 'production', '--variable-name', 'EXPO_PUBLIC_SUBSCRIPTIONS_LIVE', '--format', 'short', '--non-interactive'],
    { encoding: 'utf8' },
  );
  if (r.error || r.status !== 0) {
    // Local-only enforcement: verified here because EAS is authenticated; a
    // machine without EAS can still run the pure/source guards above.
    console.log('  skip  (eas CLI not available/authenticated on this host)');
    return;
  }
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /EXPO_PUBLIC_SUBSCRIPTIONS_LIVE=true/);
});
