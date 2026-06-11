import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const purchases = read('lib/purchases.ts');
const plans = read('app/plans.tsx');
const settings = read('app/(tabs)/settings.tsx');
const planStatus = read('lib/planStatus.ts');
const storekit = JSON.parse(read('storekit/YoumiLens.storekit'));

const productId = 'com.aydenz.youmilensipad.studentpass30d';
const oldProductIds = [
  'com.aydenz.youmilensipad.basic.monthly',
  'com.aydenz.youmilensipad.plus.monthly',
  'com.aydenz.youmilensipad.pro.monthly',
];
const forbiddenPaywallCopy = [
  'lifetime',
  'forever',
  'unlimited',
  'auto-renew',
  'monthly subscription',
  'cancel anytime',
];

assert.match(purchases, new RegExp(productId), 'purchase service uses Student Pass product');
assert.match(purchases, /fetchProducts\(\{\s*skus:\s*\[STUDENT_PASS_PRODUCT_ID\],[\s\S]*type:\s*PRODUCT_QUERY_TYPE/, 'product fetch uses configured product type');
assert.match(purchases, /const PRODUCT_QUERY_TYPE = 'in-app'/, 'non-consumable is queried as StoreKit in-app product');
assert.doesNotMatch(purchases, /getActiveSubscriptions/, 'restore does not use auto-renewable subscription API');
assert.match(purchases, /\/api\/iap\/apple\/verify/, 'purchase sends signed transaction to verify endpoint');
assert.match(purchases, /\/api\/iap\/entitlement/, 'restore checks backend entitlement endpoint');
assert.match(purchases, /status\?: 'active' \| 'expired' \| 'revoked' \| 'refunded' \| 'none'/, 'client models enhanced entitlement status');
assert.match(purchases, /latestEntitlement\?: BackendEntitlementSnapshot \| null/, 'client models latest known entitlement snapshot');
assert.match(purchases, /\/api\/iap\/restore/, 'recovery sends discovered transactions to restore endpoint');
assert.match(purchases, /finishTransaction\(\{ purchase, isConsumable: false \}\)/, 'transactions finish only through explicit finish path');

const firstBackendLookup = purchases.indexOf('const initial = await this.getBackendEntitlement(accessToken)');
const discovery = purchases.indexOf('const recoveryPurchases = await this.discoverStudentPassTransactions()');
const finalBackendLookup = purchases.indexOf('const finalEntitlement = await this.getBackendEntitlement(accessToken)');
assert.ok(firstBackendLookup > 0, 'restore starts with backend entitlement lookup');
assert.ok(discovery > firstBackendLookup, 'StoreKit discovery is after backend lookup');
assert.ok(finalBackendLookup > discovery, 'restore performs final backend lookup after recovery');

assert.match(purchases, /currentEntitlementIOS\(STUDENT_PASS_PRODUCT_ID\)/, 'recovery attempts StoreKit current entitlement');
assert.match(purchases, /latestTransactionIOS\(STUDENT_PASS_PRODUCT_ID\)/, 'recovery attempts latest transaction');
assert.match(purchases, /getAllTransactionsIOS\(\)/, 'recovery attempts public transaction history export');
assert.match(purchases, /onlyIncludeActiveItemsIOS:\s*false/, 'available purchases fallback is not active-only');
assert.match(purchases, /unverified_history_unavailable/, 'restore exposes historical recovery limitation');
assert.doesNotMatch(purchases, /AsyncStorage/, 'purchase service does not persist local paid plan');
assert.match(purchases, /Active Student Pass restored\./, 'restore active message is user-safe');
assert.match(purchases, /Your Student Pass has expired\./, 'restore expired message is user-safe');
assert.match(purchases, /This purchase was refunded or revoked\./, 'restore revoked message is user-safe');
assert.match(purchases, /No eligible Student Pass was found\./, 'restore none message is user-safe');
assert.match(purchases, /This purchase is linked to another Youmi Lens account\./, 'restore ownership message is user-safe');
assert.match(purchases, /Restore could not recover the purchase\./, 'restore recovery failure message is user-safe');
assert.doesNotMatch(purchases, /deleted Youmi Lens account/, 'client does not expose deleted-account binding');

assert.match(plans, /30 days of premium access/, 'paywall includes required duration copy');
assert.match(plans, /One-time payment\. Does not renew automatically\./, 'paywall includes required payment copy');
assert.match(plans, /Current Free plan usage remaining/, 'paywall shows current free usage');
assert.match(plans, /Server-provided quota limits/, 'paywall shows backend quota limits');
assert.match(plans, /Restore Purchases/, 'paywall exposes restore action');
assert.match(plans, /Sign in before purchasing Student Pass/, 'paywall blocks guest purchase');
assert.match(plans, /product\?\.displayPrice/, 'paywall displays StoreKit localized price');
assert.doesNotMatch(plans, /\$4\.99/, 'paywall does not hardcode displayed price');
for (const forbidden of forbiddenPaywallCopy) {
  assert.doesNotMatch(plans.toLowerCase(), new RegExp(forbidden), `paywall omits forbidden copy: ${forbidden}`);
}

assert.match(settings, /Restore Purchases/, 'settings exposes restore action');
assert.match(settings, /planStatus\.entitlement\?\.active/, 'settings shows entitlement status');
assert.match(settings, /formatDate\(planStatus\.entitlement\?\.expiresAt\)/, 'settings shows entitlement expiry');
assert.match(planStatus, /studentPass\?:/, 'quota status type includes purchase availability');
assert.match(planStatus, /maxProcessingJobsPerDay\?:/, 'quota status type includes processing job limit');
assert.match(planStatus, /studentPassActive\?:/, 'quota status models explicit Student Pass activity');
assert.match(planStatus, /studentPassExpiry\?:/, 'quota status models explicit Student Pass expiry');
assert.match(planStatus, /effectivePlanType\?:/, 'quota status models effective plan type');
assert.match(planStatus, /export function normalizePlanStatus/, 'quota response is normalized before display');
assert.match(planStatus, /if \(plan\.studentPassActive !== true\) return plan/, 'legacy status remains unchanged unless Student Pass is active');
assert.match(planStatus, /planType: plan\.effectivePlanType \|\| 'student_pass'/, 'active Student Pass overrides displayed plan');
assert.match(planStatus, /expiresAt: expiry/, 'active Student Pass expiry is mapped into the existing entitlement UI');
assert.match(planStatus, /minutesLimit: quota\?\.monthly_minutes \?\? plan\.minutesLimit/, 'active Student Pass monthly quota overrides legacy limits');
assert.match(planStatus, /maxProcessingJobsPerDay:[\s\S]*quota\?\.processing_jobs_per_day/, 'active Student Pass processing quota overrides legacy limits');
assert.match(planStatus, /return normalizePlanStatus\(payload\.plan\)/, 'all plan status consumers receive normalized data');

for (const oldProductId of oldProductIds) {
  assert.doesNotMatch(read('storekit/YoumiLens.storekit'), new RegExp(oldProductId), `StoreKit config removed ${oldProductId}`);
  assert.doesNotMatch(plans, new RegExp(oldProductId), `paywall removed ${oldProductId}`);
}

assert.equal(storekit.nonRenewingSubscriptions.length, 0, 'StoreKit has no non-renewing subscriptions');
assert.equal(storekit.subscriptionGroups.length, 0, 'StoreKit has no recurring subscription group');
assert.equal(storekit.products.length, 1, 'StoreKit has one in-app product');
assert.equal(storekit.products[0].productID, productId, 'StoreKit product ID matches approved Student Pass');
assert.equal(storekit.products[0].type, 'NonConsumable', 'StoreKit product type is non-consumable');
assert.equal(storekit.products[0].displayPrice, '4.99', 'StoreKit local test price is 4.99');

console.log('Phase 3 purchase static tests passed.');
