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

const productId = 'com.aydenz.youmilensipad.studentbasic30d';
const legacyProductId = 'com.aydenz.youmilensipad.studentpass30d';
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
assert.match(purchases, /const PRODUCT_QUERY_TYPE = 'in-app'/, 'consumable is queried as StoreKit in-app product');
assert.doesNotMatch(purchases, /getActiveSubscriptions/, 'restore does not use auto-renewable subscription API');
assert.match(purchases, /\/api\/iap\/apple\/verify/, 'purchase sends signed transaction to verify endpoint');
assert.ok(
  purchases.indexOf('await requestPurchase({') < purchases.indexOf('return await this.verifyPurchaseWithBackend(purchase, accessToken!)'),
  'purchase flow reaches StoreKit before backend transaction ownership validation',
);
assert.match(purchases, /\/api\/iap\/entitlement/, 'restore checks backend entitlement endpoint');
assert.match(purchases, /status\?: 'active' \| 'expired' \| 'revoked' \| 'refunded' \| 'none'/, 'client models enhanced entitlement status');
assert.match(purchases, /latestEntitlement\?: BackendEntitlementSnapshot \| null/, 'client models latest known entitlement snapshot');
assert.doesNotMatch(purchases, /\/api\/iap\/restore/, 'consumable access refresh does not promise App Store restoration');
assert.match(purchases, /finishTransaction\(\{ purchase, isConsumable: true \}\)/, 'verified consumable transactions finish explicitly');

const firstBackendLookup = purchases.indexOf('const initial = await this.getBackendEntitlement(accessToken)');
assert.ok(firstBackendLookup > 0, 'restore starts with backend entitlement lookup');
assert.doesNotMatch(purchases, /discoverStudentPassTransactions/, 'consumable refresh does not scan StoreKit history');
assert.match(purchases, /unverified_history_unavailable/, 'restore exposes historical recovery limitation');
assert.doesNotMatch(purchases, /AsyncStorage/, 'purchase service does not persist local paid plan');
assert.match(purchases, /Student Basic access refreshed from your Youmi Lens account\./, 'refresh active message is backend-first');
assert.match(purchases, /Your Student Basic access has expired\./, 'refresh expired message is user-safe');
assert.match(purchases, /This purchase was refunded or revoked\./, 'restore revoked message is user-safe');
assert.match(purchases, /No Student Basic access is linked to this Youmi Lens account\./, 'refresh none message is user-safe');
assert.match(
  purchases,
  /This Apple ID has already purchased this pass for another Youmi Lens account\./,
  'purchase and restore explain Apple-ID and Youmi-account ownership mismatch',
);
assert.match(purchases, /ErrorCode\.AlreadyOwned/, 'StoreKit already-owned errors use the account mismatch message');
assert.match(purchases, /ErrorCode\.DuplicatePurchase/, 'StoreKit duplicate-purchase errors use the account mismatch message');
assert.match(purchases, /Consumable purchases are not restored from App Store history\./, 'refresh explains consumable restore limits');
assert.doesNotMatch(purchases, /deleted Youmi Lens account/, 'client does not expose deleted-account binding');

assert.match(plans, /30 days of Student Basic access\./, 'paywall includes required duration copy');
assert.match(plans, /One-time payment\. Does not renew automatically\./, 'paywall includes required payment copy');
assert.match(plans, /Current Free plan usage remaining/, 'paywall shows current free usage');
assert.match(plans, /Server-provided quota limits/, 'paywall shows backend quota limits');
assert.match(plans, /Refresh Access/, 'paywall exposes backend access refresh');
assert.match(plans, /Sign in before purchasing Student Basic/, 'paywall blocks guest purchase');
assert.match(plans, /product\?\.displayPrice/, 'paywall displays StoreKit localized price');
assert.doesNotMatch(plans, /\$4\.99/, 'paywall does not hardcode displayed price');
for (const forbidden of forbiddenPaywallCopy) {
  assert.doesNotMatch(plans.toLowerCase(), new RegExp(forbidden), `paywall omits forbidden copy: ${forbidden}`);
}

assert.match(settings, /Refresh Purchase Access/, 'settings exposes backend access refresh');
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
assert.equal(storekit.products.length, 2, 'StoreKit keeps the active and legacy products');
assert.equal(storekit.products[0].productID, productId, 'StoreKit product ID matches approved Student Pass');
assert.equal(storekit.products[0].type, 'Consumable', 'StoreKit product type is consumable');
assert.equal(storekit.products[0].displayPrice, '4.99', 'StoreKit local test price is 4.99');
assert.equal(storekit.products[1].productID, legacyProductId, 'StoreKit keeps the legacy product for compatibility');
assert.equal(storekit.products[1].type, 'NonConsumable', 'legacy StoreKit product remains non-consumable');

console.log('Phase 3 purchase static tests passed.');
