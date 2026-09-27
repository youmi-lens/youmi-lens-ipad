import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Build 45 — free-trial UX (presentation only).
 *
 * These are source-level architecture guards, the same idiom used elsewhere
 * in this codebase: they prove the SHAPE of the implementation (where the
 * eligibility check lives, that it fails closed, that the purchase call is
 * untouched, that no promotional/win-back machinery was introduced) rather
 * than re-deriving StoreKit behavior, which scripts/subscriptions.test.mjs
 * already covers for the pure normalization/decision functions.
 */
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const subscriptions = stripComments(read('../lib/subscriptions.ts'));
const plans = stripComments(read('../app/plans.tsx'));
const subscriptionCore = stripComments(read('../lib/subscriptionCore.ts'));

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

// =====================================================================
console.log('FT3-FT5 — eligibility drives the UI, and fails closed');
// =====================================================================

check('FT3: eligible + free-trial mode -> trial UI (Plans derives both flags from isTrialAvailable)', () => {
  assert.match(plans, /const monthlyTrialAvailable = SUBSCRIPTIONS_LIVE && isTrialAvailable\(products\.monthly, introEligible\);/);
  assert.match(plans, /const annualTrialAvailable = SUBSCRIPTIONS_LIVE && isTrialAvailable\(products\.annual, introEligible\);/);
});

check('FT4: ineligible/default -> normal price UI (the non-trial branch is real, not dead code)', () => {
  // introEligible starts false — the safe, ineligible-by-default state.
  assert.match(plans, /const \[introEligible, setIntroEligible\] = useState\(false\);/);
  // Both plan cards keep their ORIGINAL price+term rendering as the
  // non-trial branch — this is the exact Build 44 behavior, untouched.
  assert.match(plans, /<PlanPrice loading=\{productLoading\} product=\{products\.monthly\}/);
  assert.match(plans, /<PlanPrice loading=\{productLoading\} product=\{products\.annual\}/);
  assert.match(plans, /<Text style=\{styles\.planTerm\}>\{periodLabel\(products\.monthly, 'monthly', t\)\}<\/Text>/);
});

check('FT5: the eligibility query fails closed and can never block/alter purchase', () => {
  const fn = subscriptions.slice(subscriptions.indexOf('async getIntroOfferEligibility'), subscriptions.indexOf('async loadProducts'));
  assert.match(fn, /catch \(error\) \{[\s\S]{0,160}return false;\s*\}/, 'any failure must resolve to false, never throw');
  assert.match(fn, /const eligible = await boundedPaymentTask\(\(\) => isEligibleForIntroOfferIOS\(SUBSCRIPTION_GROUP_ID\), STOREKIT_OPERATION_TIMEOUT_MS, 'intro_eligibility'\);/);
  // purchase() itself must not read eligibility state at all — a purchase
  // proceeds through the SAME unmodified path regardless of trial UI.
  const purchaseFn = subscriptions.slice(subscriptions.indexOf('async purchase('), subscriptions.indexOf('private requestWithTimeout'));
  assert.doesNotMatch(purchaseFn, /introEligible|getIntroOfferEligibility|IntroOffer/i, 'purchase() must not depend on eligibility in any way');
  // The eligibility query in Plans is fired independently of loadProducts —
  // a rejected eligibility promise cannot fail the product-load effect.
  const effect = plans.slice(plans.indexOf('useEffect(() => {\n    void loadProducts();'), plans.indexOf('return () => subscriptionService.cleanup();') + 40);
  assert.match(effect, /void subscriptionService\.getIntroOfferEligibility\(\)\.then\(setIntroEligible\);/);
});

// =====================================================================
console.log('FT8-FT9 — no hardcoded prices; FT6/FT7 pricing source (see subscriptions.test.mjs for the pure-function proof)');
// =====================================================================

check('FT8/FT9: app/plans.tsx never hardcodes $4.99 or $49.99 — every price comes from StoreKit', () => {
  assert.doesNotMatch(plans, /\$4\.99/);
  assert.doesNotMatch(plans, /\$49\.99/);
  // The only acceptable source of those literals in the whole subscription
  // surface is the pre-existing, protected, PREVIEW-ONLY constant — verify
  // that file is exactly where they live and nowhere else.
  const preview = read('../lib/subscriptionPreview.ts');
  assert.match(preview, /monthly: 'US\$4\.99'/);
  assert.match(preview, /annual: 'US\$49\.99'/);
});

// =====================================================================
console.log('FT10-FT11 — CTA: trial label only when eligible, Subscribe otherwise');
// =====================================================================

check('FT10: CTA reads "Start 1-Month Free Trial" ONLY when the selected plan is trial-eligible', () => {
  assert.match(plans, /label=\{selectedTrialAvailable \? t\('plans\.startFreeTrial'\) : t\('plans\.subscribe'\)\}/);
  const selection = plans.slice(plans.indexOf("const selectedTrialAvailable ="), plans.indexOf("const handlePurchase"));
  assert.match(selection, /selectedPlan === 'monthly' \? monthlyTrialAvailable : annualTrialAvailable/);
});

check('FT11: the ineligible/default CTA is still literally "Subscribe" — unchanged from Build 44', () => {
  assert.match(plans, /t\('plans\.subscribe'\)/);
});

// =====================================================================
console.log('FT12-FT13 — localization: all 6 locales, real translations');
// =====================================================================

const REQUIRED_KEYS = ['freeTrialOneMonth', 'thenPricePerMonth', 'thenPricePerYear', 'startFreeTrial'];
const locales = {
  en: read('../lib/locales/en.mjs'),
  'zh-Hans': read('../lib/locales/zh-Hans.mjs'),
  ja: read('../lib/locales/ja.mjs'),
  fr: read('../lib/locales/fr.mjs'),
  es: read('../lib/locales/es.mjs'),
  ko: read('../lib/locales/ko.mjs'),
};

function extractValue(source, key) {
  const m = source.match(new RegExp(`['"]plans\\.${key}['"]:\\s*(['"])((?:(?!\\1).)*)\\1`));
  return m ? m[2] : null;
}

check('FT12: all 6 locales define all 4 required trial keys', () => {
  for (const [locale, source] of Object.entries(locales)) {
    for (const key of REQUIRED_KEYS) {
      const value = extractValue(source, key);
      assert.ok(value, `${locale} is missing plans.${key}`);
    }
  }
});

check('FT13: no non-English locale silently falls back to the raw English string', () => {
  for (const key of REQUIRED_KEYS) {
    const enValue = extractValue(locales.en, key);
    for (const [locale, source] of Object.entries(locales)) {
      if (locale === 'en') continue;
      const value = extractValue(source, key);
      assert.notEqual(value, enValue, `${locale}.plans.${key} is identical to English — looks like an un-translated fallback`);
    }
  }
});

// =====================================================================
console.log('FT14-FT15 — purchase machinery is untouched; no promotional/win-back logic');
// =====================================================================

check('FT14: the requestPurchase call is byte-for-byte the same shape Build 44 shipped', () => {
  const call = subscriptions.slice(subscriptions.indexOf('requestPurchase({'), subscriptions.indexOf('}).catch('));
  const expected = `requestPurchase({
        type: 'subs',
        request: {
          apple: {
            sku: requestedProductId,
            appAccountToken,
            andDangerouslyFinishTransactionAutomatically: false,
          },
        },
      `;
  assert.equal(call, expected.slice(expected.indexOf('requestPurchase({')));
});

check('FT15: no promotional offer / win-back / offer-code / eligibility-override logic was introduced', () => {
  for (const source of [subscriptions, plans, subscriptionCore]) {
    assert.doesNotMatch(source, /promotionalOfferJWS/);
    assert.doesNotMatch(source, /winBackOffer/i);
    assert.doesNotMatch(source, /offerCode/i);
    assert.doesNotMatch(source, /introductoryOfferEligibility/, 'must not override eligibility — let StoreKit decide, per §8');
  }
});

console.log(`\nfree-trial-ux: ${passed} checks passed`);
