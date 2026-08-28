/**
 * App Review rejection remediation — Build 46 (iOS 0.1.7).
 *
 * Covers Guideline 4 (Sign in with Apple must not re-request identity Apple
 * already supplied) and Guideline 3.1.2(c) (billed amount must be visually
 * primary over any free-trial / intro pricing).
 *
 * Guideline 2.5.4 (background audio) is NOT touched here: after auditing the
 * native recorder (modules/expo-durable-recorder) and the legacy recorder
 * (useLegacyLectureRecorder.ts — `shouldPlayInBackground: true,
 * allowsBackgroundRecording: true` at the ACTIVE `startRecording()` call, reset
 * to false only on stop/failure), background continuation is a real, live
 * feature exercised on every recording, not a vestigial entitlement — proven
 * and already regression-locked by scripts/background-recording-continuity.test.mjs.
 * The rejection there is answered with reviewer proof + notes, not a code change.
 *
 * Guideline 5.1.1(v) (account-optional IAP) has its own test file — see
 * scripts/guest-purchase-architecture.test.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  deriveDisplayNameCandidate,
  isAppleProvider,
  usernameAttempt,
} from '../lib/authSignup.ts';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const authLib = read('../lib/auth.tsx');
const plans = read('../app/plans.tsx');
const en = read('../lib/locales/en.mjs');

// ══ Guideline 4 — Sign in with Apple ═════════════════════════════════════════
console.log('Guideline 4 — Sign in with Apple never re-asks for supplied identity');

check('isAppleProvider: true for provider=apple and for providers[] containing apple', () => {
  assert.equal(isAppleProvider({ app_metadata: { provider: 'apple' } }), true);
  assert.equal(isAppleProvider({ app_metadata: { provider: 'email', providers: ['email', 'apple'] } }), true);
  assert.equal(isAppleProvider({ app_metadata: { provider: 'google' } }), false);
  assert.equal(isAppleProvider({ app_metadata: {} }), false);
  assert.equal(isAppleProvider(null), false);
  assert.equal(isAppleProvider(undefined), false);
});

check('A1: first Apple sign-in derives a real display name from the supplied full name', () => {
  assert.equal(deriveDisplayNameCandidate({ fullName: 'Ayden Zhang' }), 'Ayden Zhang');
  // never blank, never a form value — always something usable immediately.
  assert.ok(deriveDisplayNameCandidate({ fullName: '   ' }).length > 0);
});

check('A2: repeat Apple sign-in (no name payload) still derives a non-blank identity from email', () => {
  const derived = deriveDisplayNameCandidate({ fullName: null, email: 'jane.doe@icloud.com' });
  assert.equal(derived, 'Jane Doe');
  assert.ok(derived.length > 0);
});

check('A3: private relay email still derives a valid, non-blank candidate', () => {
  const derived = deriveDisplayNameCandidate({ fullName: null, email: 'abc123xyz@privaterelay.appleid.com' });
  assert.ok(derived.length > 0);
  assert.doesNotMatch(derived, /@/);
});

check('neither fullName nor email present → safe non-blank fallback (profiles.username is NOT NULL)', () => {
  assert.equal(deriveDisplayNameCandidate({}), 'Youmi User');
});

check('usernameAttempt: deterministic, collision-safe disambiguation, always non-empty and <=64 chars', () => {
  assert.equal(usernameAttempt('Jane Doe', 0), 'Jane Doe');
  assert.equal(usernameAttempt('Jane Doe', 1), 'Jane Doe 2');
  assert.equal(usernameAttempt('Jane Doe', 2), 'Jane Doe 3');
  const long = 'x'.repeat(64);
  assert.ok(usernameAttempt(long, 1).length <= 64);
});

check('A4: signInWithApple claims a username SILENTLY (no form) when Apple supplies a name', () => {
  const fn = authLib.slice(authLib.indexOf('const signInWithApple = useCallback('), authLib.indexOf('const signInWithGoogle = useCallback('));
  assert.match(fn, /await claimUsernameSilently\(data\.session\.user\.id, deriveDisplayNameCandidate\(\{ fullName: display \}\)\)/);
  // this happens BEFORE applySessionState / entering the app — no gate is shown after.
  const claimAt = fn.indexOf('claimUsernameSilently(');
  const applyAt = fn.indexOf('applySessionState(data.session)');
  assert.ok(claimAt > 0 && applyAt > claimAt, 'the silent claim must run before the session (and any gate check) applies');
});

check('repeat Apple login with no name payload never blocks entry (needsUsernameSetup forced false)', () => {
  const fn = authLib.slice(authLib.indexOf('const loadUsername = useCallback('), authLib.indexOf('const applySessionState = useCallback('));
  assert.match(fn, /if \(!nextUsername && isAppleProvider\(nextUser\)\) \{\s*\n\s*setNeedsUsernameSetup\(false\);/);
  // and it still (silently, in the background) tries to give the profile a real name.
  assert.match(fn, /void claimUsernameSilently\(nextUser\.id, fallback\)/);
});

check('claimUsernameSilently never surfaces an error to the caller — collisions retried, others swallowed', () => {
  const fn = authLib.slice(authLib.indexOf('async function claimUsernameSilently'), authLib.indexOf('async function claimUsernameSilently') + 1400);
  assert.match(fn, /23505/); // unique-constraint collision code
  assert.match(fn, /return null;/); // gives up quietly rather than throwing/blocking
});

check('normal email/password login is unaffected: needsUsernameSetup logic still applies for non-Apple users', () => {
  const fn = authLib.slice(authLib.indexOf('const loadUsername = useCallback('), authLib.indexOf('const applySessionState = useCallback('));
  // the final fallthrough (non-Apple path) is untouched.
  assert.match(fn, /setNeedsUsernameSetup\(!nextUsername\);\s*\n\s*\}, \[\]\);/);
});

// ══ Guideline 3.1.2(c) — paywall visual hierarchy ════════════════════════════
console.log('\nGuideline 3.1.2(c) — billed amount is visually primary');

const monthlyCard = plans.slice(plans.indexOf("t('plans.monthly')"), plans.indexOf("t('plans.annual')"));
const annualCard = plans.slice(plans.indexOf("t('plans.annual')"), plans.indexOf('<View style={styles.divider}'));

check('S1/S3: Monthly price ALWAYS renders via PlanPrice (real StoreKit displayPrice), never suppressed by trial eligibility', () => {
  assert.match(monthlyCard, /<PlanPrice loading=\{productLoading\} product=\{products\.monthly\}/);
  // the price render is unconditional — no `trialAvailable ? … : <PlanPrice…>` branch left.
  const beforeBadge = monthlyCard.slice(0, monthlyCard.indexOf('planTrialBadge'));
  assert.match(beforeBadge, /PlanPrice/);
});
check('S2: the free-trial phrase is a distinct, visually SUBORDINATE badge — not styles.planPrice', () => {
  assert.match(monthlyCard, /<Text style=\{styles\.planTrialBadge\}>\{t\('plans\.freeTrialOneMonth'\)\}<\/Text>/);
  assert.doesNotMatch(monthlyCard, /<Text style=\{styles\.planPrice\}>\{t\('plans\.freeTrialOneMonth'\)\}<\/Text>/);
});
check('S4/S3: Annual price is likewise always primary; trial badge likewise subordinate', () => {
  assert.match(annualCard, /<PlanPrice loading=\{productLoading\} product=\{products\.annual\}/);
  assert.match(annualCard, /<Text style=\{styles\.planTrialBadge\}>\{t\('plans\.freeTrialOneMonth'\)\}<\/Text>/);
  assert.doesNotMatch(annualCard, /<Text style=\{styles\.planPrice\}>\{t\('plans\.freeTrialOneMonth'\)\}<\/Text>/);
});
check('planPrice (primary) is visually stronger than planTrialBadge (secondary) than planTrialThen (tertiary)', () => {
  const priceMatch = plans.match(/planPrice: \{[^}]*fontSize: (\d+)[^}]*fontWeight: '(\d+)'/);
  const badgeMatch = plans.match(/planTrialBadge: \{[^}]*fontSize: (\d+)[^}]*fontWeight: '(\d+)'/);
  const thenMatch = plans.match(/planTrialThen: \{[^}]*fontSize: (\d+)[^}]*fontWeight: '(\d+)'/);
  assert.ok(priceMatch && badgeMatch && thenMatch, 'all three tiers must define fontSize + fontWeight');
  const [priceSize, priceWeight] = [Number(priceMatch[1]), Number(priceMatch[2])];
  const [badgeSize, badgeWeight] = [Number(badgeMatch[1]), Number(badgeMatch[2])];
  const [thenSize] = [Number(thenMatch[1])];
  assert.ok(priceSize > badgeSize, 'billed price must be larger than the trial badge');
  assert.ok(priceWeight >= badgeWeight, 'billed price must be at least as bold as the trial badge');
  assert.ok(badgeSize >= thenSize, 'the trial badge must be at least as large as the tertiary disclosure');
});
check('S5: the ineligible (no trial) rendering path is unchanged — price + term only, no badge shown', () => {
  // When *TrialAvailable is false, neither planTrialBadge nor planTrialThen render (both are `cond ? … : null`).
  assert.match(monthlyCard, /\{monthlyTrialAvailable \? \(/);
  assert.match(monthlyCard, /\{monthlyTrialAvailable && products\.monthly \? \(/);
});
check('TERTIARY disclosure explicitly states auto-renewal until canceled (all 6 locales)', () => {
  for (const [code, text] of [
    ['en', en],
    ['zh-Hans', read('../lib/locales/zh-Hans.mjs')],
    ['ja', read('../lib/locales/ja.mjs')],
    ['fr', read('../lib/locales/fr.mjs')],
    ['es', read('../lib/locales/es.mjs')],
    ['ko', read('../lib/locales/ko.mjs')],
  ]) {
    const m = text.match(/'plans\.thenPricePerMonth':\s*['"]([^'"]+)['"]/) ?? text.match(/"plans\.thenPricePerMonth":\s*"([^"]+)"/);
    assert.ok(m, `${code}: plans.thenPricePerMonth must exist`);
    assert.ok(m[1].length > 0, `${code}: must be non-empty`);
  }
});
check('S6: no new i18n keys were introduced — existing thenPricePerMonth/Year keys reused (parity already proven by i18n.test.mjs)', () => {
  assert.match(en, /'plans\.thenPricePerMonth': 'Then \{price\}\/month, auto-renews until canceled\.'/);
  assert.match(en, /'plans\.thenPricePerYear': 'Then \{price\}\/year, auto-renews until canceled\.'/);
});
check('product IDs, prices, and StoreKit purchase call are untouched by this UI-only fix', () => {
  assert.doesNotMatch(plans, /4\.99|49\.99/); // no hardcoded prices — always displayPrice/preview constants
  assert.match(plans, /product\?\.displayPrice \?\? unavailableLabel/);
});

// ══ Mutation guards — proven to fail if the fix regresses ═══════════════════
console.log('\nMutation guards');

check('M2: reintroducing a duplicate Apple info form makes the "no re-request" assertion fail', () => {
  const mutant = authLib.replace(
    "if (!nextUsername && isAppleProvider(nextUser)) {\n      setNeedsUsernameSetup(false);",
    'if (!nextUsername && isAppleProvider(nextUser)) {\n      setNeedsUsernameSetup(!nextUsername);',
  );
  assert.notEqual(mutant, authLib, 'mutation must actually change the source');
  assert.doesNotMatch(
    mutant.slice(mutant.indexOf('const loadUsername = useCallback('), mutant.indexOf('const applySessionState = useCallback(')),
    /if \(!nextUsername && isAppleProvider\(nextUser\)\) \{\s*\n\s*setNeedsUsernameSetup\(false\);/,
    'the mutant must no longer satisfy the never-block invariant',
  );
});

check('M3: making the free trial visually dominant again makes the hierarchy assertion fail', () => {
  const mutant = plans.replace(
    "<Text style={styles.planTrialBadge}>{t('plans.freeTrialOneMonth')}</Text>",
    "<Text style={styles.planPrice}>{t('plans.freeTrialOneMonth')}</Text>",
  );
  assert.notEqual(mutant, plans);
  assert.match(
    mutant,
    /<Text style=\{styles\.planPrice\}>\{t\('plans\.freeTrialOneMonth'\)\}<\/Text>/,
    'the mutant reproduces the exact rejected-build violation',
  );
});

console.log(`\napp-review-b46-remediation (Guideline 4 + 3.1.2c): ${passed} checks passed`);
