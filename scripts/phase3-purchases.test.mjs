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
const appConfig = JSON.parse(read('app.json'));

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
  'subscription',
  'auto-renew',
  'monthly subscription',
  'cancel anytime',
];

// 1. Approved Consumable SKU remains the only purchase target.
assert.match(purchases, new RegExp(`STUDENT_PASS_PRODUCT_ID = '${productId}'`));
assert.match(purchases, /request: \{ apple: \{ sku: STUDENT_PASS_PRODUCT_ID \} \}/);
assert.match(purchases, /const PRODUCT_QUERY_TYPE = 'in-app'/);
assert.equal(storekit.products[0].productID, productId);
assert.equal(storekit.products[0].type, 'Consumable');

// 2. StoreKit's localized display price wins; the screen does not hard-code USD.
// The simplified upgrade screen shows a single price line driven by the
// StoreKit-localized value, never a literal price string.
assert.match(purchases, /displayPrice: product\.displayPrice/);
assert.match(plans, /product\?\.displayPrice \?\? 'App Store unavailable'/);
assert.doesNotMatch(plans, /\$4\.99|US\$4\.99/);

// 3. Closed sales require an explicit backend true and do not hide active access.
assert.match(purchases, /status\?\.studentPass\?\.isPurchasable === true/);
assert.match(plans, /currentStatus\?\.studentPass\?\.isPurchasable === false/);
assert.match(plans, /New Student Basic purchases are currently unavailable\./);
assert.match(plans, /const activeEntitlement = currentStatus\?\.entitlement\?\.active/);
assert.match(plans, /Your active access remains visible even when new purchases are closed\./);

// 4-5. Active access shows expiry; the verified-grant guard still pins every
// protected paid quota (600/120/90/90/6/10), and the simplified screen surfaces
// the paid limits as plain-language benefits instead of a comparison table.
assert.match(plans, /formatDate\(activeEntitlement\?\.expiresAt\)/);
assert.match(plans, /\(status\.monthlyMinutesLimit \?\? status\.minutesLimit\) === 600/);
assert.match(plans, /status\.dailyMinutesLimit === 120/);
assert.match(plans, /status\.maxRecordingMinutes === 90/);
assert.match(plans, /status\.maxLiveSessionMinutes === 90/);
assert.match(plans, /status\.maxRecordingsPerDay === 6/);
assert.match(plans, /status\.maxProcessingJobsPerDay === 10/);
assert.match(plans, /600 study minutes each month/);
assert.match(plans, /6 recordings every day/);
assert.match(plans, /10 study tasks every day/);

// 6. Both the handler and service prevent concurrent purchase requests.
assert.match(plans, /purchaseLockRef\.current \|\| busy !== null/);
assert.match(plans, /purchaseLockRef\.current = true/);
assert.match(plans, /purchaseLockRef\.current = false/);
assert.match(purchases, /private purchaseInFlight = false/);
assert.match(purchases, /if \(this\.purchaseInFlight\)/);
assert.match(purchases, /code: 'purchase_in_progress'/);

// 7. Apple cancellation clears loading through finally and exits before any failure alert.
const cancelBranch = plans.indexOf("if (result.code === 'cancelled') return;");
const failureAlert = plans.indexOf("Alert.alert('Purchase not completed'");
assert.ok(cancelBranch > 0 && cancelBranch < failureAlert);
assert.match(purchases, /name === ErrorCode\.UserCancelled/);
assert.match(plans, /finally \{\s*purchaseLockRef\.current = false;\s*setBusy\(null\);/);

// 8-10. StoreKit success is verified first; only a verified grant refreshes and confirms active quotas.
const requestIndex = purchases.indexOf('await requestPurchase({');
const verifyIndex = purchases.indexOf('return await this.verifyPurchaseWithBackend(purchase, accessToken!)');
const backendGrantIndex = purchases.indexOf('status >= 200 && status < 300 && payload?.ok && payload.granted');
const serviceSuccessIndex = purchases.indexOf("code: 'success'", backendGrantIndex);
assert.ok(requestIndex > 0 && requestIndex < verifyIndex);
assert.ok(verifyIndex < backendGrantIndex && backendGrantIndex < serviceSuccessIndex);
assert.match(plans, /if \(!result\.ok\) \{[\s\S]*Purchase not completed[\s\S]*return;/);
assert.match(plans, /const refreshedStatus = await loadStatus\(\);/);
assert.match(plans, /refreshedStatus && confirmsStudentBasicGrant\(refreshedStatus\)/);
assert.match(plans, /Apple payment was verified, but updated access could not be confirmed/);
assert.doesNotMatch(plans, /Student Basic active'[^]*result\.ok/);

// 11. Refresh Access is backend-first and refreshes quota/status before reporting success.
const entitlementLookup = purchases.indexOf('initial = await this.getBackendEntitlement(accessToken)');
assert.ok(entitlementLookup > 0);
assert.match(purchases, /\/api\/iap\/entitlement/);
assert.doesNotMatch(purchases, /\/api\/iap\/restore/);
assert.match(plans, /const result = await purchaseService\.restoreStudentPass\(accessToken\);[\s\S]*const refreshedStatus = await loadStatus\(\);/);
assert.match(plans, /Refresh Access/);

// 12. Status is keyed to Supabase user.id and stale requests are discarded.
assert.match(plans, /const accountId = user\?\.id \?\? null/);
assert.match(plans, /planStatusAccountId === accountId \? planStatus : null/);
assert.match(plans, /activeAccountRef\.current !== requestedAccountId/);
assert.match(plans, /setPlanStatus\(null\);[\s\S]*setPlanStatusAccountId\(null\);/);
assert.doesNotMatch(purchases, /AsyncStorage/);

// 13. Consumable access refresh never promises an Apple restore.
assert.doesNotMatch(`${plans}\n${settings}`, /Restore Purchases/i);
assert.doesNotMatch(purchases, /getAvailablePurchases|getActiveSubscriptions|discoverStudentPassTransactions/);
assert.match(purchases, /Consumable purchases are not restored from App Store history\./);

// 14. Required product language is present and prohibited paywall language is absent.
assert.match(plans, /30 days of premium lecture support/);
assert.match(plans, /One-time payment\. Does not renew automatically\./);
for (const forbidden of forbiddenPaywallCopy) {
  assert.doesNotMatch(plans.toLowerCase(), new RegExp(forbidden), `paywall omits prohibited copy: ${forbidden}`);
}

// Error and lifecycle coverage.
assert.match(purchases, /case 'product_unavailable'/);
assert.match(purchases, /case 'sales_closed'/);
assert.match(purchases, /case 'offline'/);
assert.match(purchases, /case 'session_expired'/);
assert.match(purchases, /case 'transaction_already_processed'/);
assert.match(purchases, /case 'backend_verification_failed'/);
assert.match(plans, /AppState\.addEventListener\('change'/);
assert.match(plans, /useFocusEffect/);
assert.match(planStatus, /Network unavailable\. Check your connection and try again\./);
assert.doesNotMatch(purchases, /console\.(log|warn|error)/);

// Existing normalization and protected configuration remain intact.
assert.match(planStatus, /return normalizePlanStatus\(payload\.plan\)/);
assert.match(planStatus, /minutesLimit: quota\?\.monthly_minutes \?\? plan\.minutesLimit/);
assert.match(planStatus, /maxProcessingJobsPerDay:[\s\S]*quota\?\.processing_jobs_per_day/);
for (const oldProductId of oldProductIds) {
  assert.doesNotMatch(read('storekit/YoumiLens.storekit'), new RegExp(oldProductId));
  assert.doesNotMatch(plans, new RegExp(oldProductId));
}
assert.equal(storekit.nonRenewingSubscriptions.length, 0);
assert.equal(storekit.subscriptionGroups.length, 0);
assert.equal(storekit.products.length, 2);
assert.equal(storekit.products[0].displayPrice, '4.99');
assert.equal(storekit.products[1].productID, legacyProductId);
assert.equal(storekit.products[1].type, 'NonConsumable');
assert.equal(appConfig.expo.version, '0.1.4');
assert.equal(appConfig.expo.ios.buildNumber, '19');

console.log('Phase 3 purchase hardening tests passed.');
