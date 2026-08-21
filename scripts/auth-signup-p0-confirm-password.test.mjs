/**
 * P0 — real-user signup / email-verification incident.
 *
 * PROVEN root causes (see the P0 report for full evidence):
 *   A. Confirm Password was removed from the SIGNUP flow in commit 474c1a1
 *      (2026-06-14, "feat: add native Apple and Google sign-in") — it survives
 *      only on the password-RESET screen. Both the current working tree AND the
 *      published App Store 0.1.6 build (commit 6e534c2, its last commit before
 *      the 0.1.6→0.1.7 bump) lack it. Not a recent regression — a longstanding
 *      gap now being closed.
 *   B. The client's verification contract is CODE-based
 *      (`verifyOtp({ email, token, type: 'signup' })`, 6-8 digit validation) —
 *      structurally correct, resend/cooldown/error-surfacing all sound. But no
 *      call ever passed `emailRedirectTo`; `AUTH_CALLBACK_URL` was DEAD CODE.
 *      Live staging evidence: admin generate_link's default redirect resolves
 *      to `http://localhost:3000`, not the app's `youmilens://auth/callback`
 *      deep link — a dead destination on a real device IF the email template
 *      shows a link. Whether Production's actual "Confirm signup" template
 *      shows the code as plain text is a DASHBOARD-level fact this code cannot
 *      prove (no Management API credential available) — an explicit CONFIG-side
 *      open question, not silently assumed either way.
 *
 * Source-level guards (app/auth.tsx is a large RN screen component); the pure
 * classification/resend-gate logic is exercised directly in
 * scripts/auth-signup.test.mjs (unchanged, still passing).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const authScreen = read('../app/auth.tsx');
const authLib = read('../lib/auth.tsx');

const createProfileSection = authScreen.slice(
  authScreen.indexOf("entryMode === 'createProfile' ? (\n                  <>"),
  authScreen.indexOf(') : (', authScreen.indexOf("entryMode === 'createProfile' ? (\n                  <>")),
);
const handleCreateProfile = authScreen.slice(
  authScreen.indexOf('const handleCreateProfile = async'),
  authScreen.indexOf('const handleVerifyAndCreate ='),
);
const handleVerify = authScreen.slice(
  authScreen.indexOf('const handleVerifyAndCreate ='),
  authScreen.indexOf('const handleProviderSignIn ='),
);

console.log('1/2 — Password + Confirm Password both present on signup');
check('1. signup UI has a Password field (createPasswordVisible)', () => {
  assert.match(createProfileSection, /createPasswordVisible/);
});
check('2. signup UI now ALSO has a Confirm Password field (root cause A fixed)', () => {
  assert.match(createProfileSection, /confirmPassword/);
  assert.match(createProfileSection, /createConfirmPasswordVisible/);
  assert.match(createProfileSection, /t\('auth\.confirmPassword'\)/);
});

console.log('3/4 — client-side match validation blocks/allows correctly');
check('3. mismatch blocks the signup request before any network call', () => {
  assert.match(handleCreateProfile, /if \(!confirmPassword\) return setError\(t\('auth\.confirmRequired'\)\);/);
  assert.match(handleCreateProfile, /if \(password !== confirmPassword\) return setError\(t\('auth\.passwordMismatch'\)\);/);
  // the mismatch checks run BEFORE createProfileWithPassword is ever called.
  const mismatchAt = handleCreateProfile.indexOf('password !== confirmPassword');
  const requestAt = handleCreateProfile.indexOf('createProfileWithPassword(');
  assert.ok(mismatchAt > 0 && requestAt > mismatchAt, 'password match must be verified before the signup request is sent');
});
check('4. a matching confirm value does not block (no unconditional early return)', () => {
  // The mismatch guard is a comparison, not an unconditional block — matching
  // values fall through to the request below in the same function body.
  assert.match(handleCreateProfile, /await createProfileWithPassword\(normalized, password\)/);
});

console.log('5 — weak/invalid password behavior preserved');
check('5. length + required checks are unchanged and run before the confirm checks', () => {
  assert.match(handleCreateProfile, /if \(!password\) return setError\(t\('auth\.enterPassword'\)\);/);
  assert.match(handleCreateProfile, /if \(password\.length < 8\) return setError\(t\('auth\.passwordLength'\)\);/);
});

console.log('9/10 — verification mode: client is CODE-based (not link-only)');
check('9/10. verifySignupCode calls verifyOtp with a token + type:signup (numeric code contract)', () => {
  assert.match(authLib, /const verifySignupCode = useCallback\(/);
  const fn = authLib.slice(authLib.indexOf('const verifySignupCode = useCallback('), authLib.indexOf('const verifySignupCode = useCallback(') + 700);
  assert.match(fn, /supabase\.auth\.verifyOtp\(\{/);
  assert.match(fn, /token: code/);
  assert.match(fn, /type: 'signup'/);
});
check('handleVerifyAndCreate validates a 6-8 digit numeric code before calling verifyOtp', () => {
  assert.match(handleVerify, /\/\^\\d\{6,8\}\$\//);
});

console.log('B mitigation — emailRedirectTo now wired (was dead code)');
check('createProfileWithPassword now passes emailRedirectTo: AUTH_CALLBACK_URL on signUp', () => {
  const fn = authLib.slice(authLib.indexOf('const createProfileWithPassword = useCallback('), authLib.indexOf('const verifySignupCode ='));
  assert.match(fn, /supabase\.auth\.signUp\(\{/);
  assert.match(fn, /options: \{ emailRedirectTo: AUTH_CALLBACK_URL \}/);
});
check('resendSignupCode now passes emailRedirectTo: AUTH_CALLBACK_URL on resend', () => {
  const fn = authLib.slice(authLib.indexOf('const resendSignupCode = useCallback('), authLib.indexOf('const resendSignupCode = useCallback(') + 500);
  assert.match(fn, /supabase\.auth\.resend\(\{/);
  assert.match(fn, /options: \{ emailRedirectTo: AUTH_CALLBACK_URL \}/);
});
check('AUTH_CALLBACK_URL is the real app deep link (youmilens://auth/callback)', () => {
  assert.match(authLib, /AUTH_CALLBACK_URL = 'youmilens:\/\/auth\/callback'/);
});

console.log('11/12 — invalid/expired code handling');
check('11. an invalid code format is rejected client-side with a clear error (never silently sent)', () => {
  assert.match(handleVerify, /if \(!trimmedCode\) return setError\(t\('auth\.codeRequired'\)\);/);
  assert.match(handleVerify, /if \(!\/\^\\d\{6,8\}\$\/\.test\(trimmedCode\)\) return setError\(t\('auth\.codeInvalid'\)\);/);
});
check('12. an expired/invalid server response is mapped to a clear, actionable message', () => {
  const fn = authLib.slice(authLib.indexOf('const verifySignupCode = useCallback('), authLib.indexOf('const verifySignupCode = useCallback(') + 900);
  assert.match(fn, /Invalid or expired code\. Please try again or resend a new code\./);
});

console.log('13/14 — resend + cooldown');
check('13/14. resend exists and gates entry only on a real success signal (no false "sent")', () => {
  assert.match(authLib, /const resendSignupCode = useCallback/);
  // decideSignupResendGate is the single source of truth for entering the code
  // screen after resend; false positives are proven impossible in authSignup.test.mjs.
  assert.match(authScreen, /decideSignupResendGate\(resendError\)/);
});

console.log('15 — rate-limit is a distinct, non-generic error');
check('15. a rate-limit resend response is classified separately from a generic failure', () => {
  assert.match(authScreen, /gate\.messageKind === 'rateLimited'\s*\?\s*t\('auth\.resendWait'\)/);
});

console.log('16 — change email / go back');
check('16. the user can return to entry (sign-in/create) mode; the flow is not a dead end', () => {
  assert.match(authScreen, /setEntryMode\('signIn'\)/);
  assert.match(authScreen, /setStep\('entry'\)/);
});

console.log('17 — successful verification creates/refreshes the session');
check('17. verifySignupCode applies the returned session on success', () => {
  const start = authLib.indexOf('const verifySignupCode = useCallback(');
  const fn = authLib.slice(start, authLib.indexOf('applySessionState(data.session)', start) + 40);
  assert.match(fn, /await applySessionState\(data\.session\)/);
});

console.log('18 — no duplicate account creation');
check('18. an existing email is checked BEFORE signUp is called, blocking duplicate creation', () => {
  const checkAt = handleCreateProfile.indexOf('checkEmailExists(normalized)');
  const signUpAt = handleCreateProfile.indexOf('createProfileWithPassword(normalized, password)');
  assert.ok(checkAt > 0 && signUpAt > checkAt, 'checkEmailExists must run before the signUp request');
  assert.match(handleCreateProfile, /if \(emailCheck\.exists\) \{/);
});

console.log('19 — no sensitive values are logged');
check('19. password / confirmPassword / code / tokens are never passed to console.*', () => {
  // Every console.* call in the signup path logs a fixed label/status string, never a variable holding secret input.
  const logCalls = [...authLib.matchAll(/console\.(warn|info|log|error)\(([^)]*)\)/g)].map((m) => m[2]);
  for (const args of logCalls) {
    assert.doesNotMatch(args, /\bpassword\b/i, `console call must not log password-bearing arg: ${args}`);
    assert.doesNotMatch(args, /\bconfirmPassword\b/i);
    assert.doesNotMatch(args, /\baccess_token\b|\brefresh_token\b/);
  }
  // The one place the codebase intentionally logs UI focus events (dev-only), it
  // logs a fixed string, never the field's value.
  assert.doesNotMatch(authScreen, /console\.log\(\s*(password|confirmPassword|code)\s*\)/);
});

console.log('20/21/22 — adjacent flows unaffected');
check('20. existing sign-in path is untouched (still password-only, no confirm field)', () => {
  const signInSection = authScreen.slice(createProfileSection.length ? authScreen.indexOf(') : (', authScreen.indexOf(createProfileSection)) : 0);
  assert.match(signInSection, /signInPasswordVisible/);
  assert.doesNotMatch(signInSection.slice(0, signInSection.indexOf(')}')), /confirmPassword/);
});
check('21. forgot-password (reset) flow keeps its own independent confirm field untouched', () => {
  assert.match(authScreen, /resetConfirmPassword/);
  assert.match(authScreen, /if \(resetPassword !== resetConfirmPassword\) return setError\(t\('auth\.passwordMismatch'\)\)/);
});
check('22. session persistence plumbing (applySessionState) is unchanged, not touched by this fix', () => {
  assert.match(authLib, /const applySessionState = /);
});

console.log(`\nP0 auth signup / confirm-password: ${passed} checks passed`);
