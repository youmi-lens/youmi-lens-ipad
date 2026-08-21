/**
 * Auth signup / resend gate regression tests.
 * Run: node --experimental-strip-types scripts/auth-signup.test.mjs
 */
import assert from 'node:assert/strict';

import {
  canEnterSignupCode,
  classifyPasswordSignupResult,
  decideSignupResendGate,
  normalizeEmail,
  signupCodeDetailMessageKey,
  signupCodeSuccessMessageKey,
} from '../lib/authSignup.ts';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// ── Email normalization ──────────────────────────────────────────────────────

check('normalizeEmail trims and lower-cases only', () => {
  assert.equal(normalizeEmail('  Alex+Class@ICloud.COM  '), 'alex+class@icloud.com');
  assert.equal(normalizeEmail('a@b.co'), 'a@b.co');
});

check('normalizeEmail preserves plus aliases and domain content', () => {
  assert.equal(normalizeEmail('User+tag@Gmail.com'), 'user+tag@gmail.com');
});

// ── Signup classification ────────────────────────────────────────────────────

check('A: new user identities non-empty → confirmationRequired', () => {
  assert.equal(
    classifyPasswordSignupResult({
      error: null,
      user: { identities: [{ provider: 'email' }] },
      session: null,
    }),
    'confirmationRequired',
  );
  assert.equal(
    canEnterSignupCode({ classification: 'confirmationRequired' }),
    true,
  );
  assert.equal(signupCodeSuccessMessageKey('sent'), 'auth.sentCode');
});

check('B: identities empty → existingOrObfuscated; no enter without resend', () => {
  assert.equal(
    classifyPasswordSignupResult({
      error: null,
      user: { identities: [] },
      session: null,
    }),
    'existingOrObfuscated',
  );
  assert.equal(canEnterSignupCode({ classification: 'existingOrObfuscated' }), false);
  assert.equal(canEnterSignupCode({ classification: 'existingOrObfuscated', resendSucceeded: true }), true);
  assert.equal(signupCodeSuccessMessageKey(null), null);
});

check('F: identities undefined/null → existingOrObfuscated (conservative)', () => {
  assert.equal(
    classifyPasswordSignupResult({
      error: null,
      user: { identities: undefined },
      session: null,
    }),
    'existingOrObfuscated',
  );
  assert.equal(
    classifyPasswordSignupResult({
      error: null,
      user: { identities: null },
      session: null,
    }),
    'existingOrObfuscated',
  );
  assert.equal(
    classifyPasswordSignupResult({
      error: null,
      user: {},
      session: null,
    }),
    'existingOrObfuscated',
  );
});

check('C: signup error → failed; cannot enter signupCode', () => {
  assert.equal(
    classifyPasswordSignupResult({
      error: { message: 'Signup disabled' },
      user: null,
      session: null,
    }),
    'failed',
  );
  assert.equal(canEnterSignupCode({ classification: 'failed' }), false);
});

check('session immediate → authenticated', () => {
  assert.equal(
    classifyPasswordSignupResult({
      error: null,
      user: { identities: [{ provider: 'email' }] },
      session: { access_token: 'x' },
    }),
    'authenticated',
  );
});

check('missing user without error → failed', () => {
  assert.equal(
    classifyPasswordSignupResult({
      error: null,
      user: null,
      session: null,
    }),
    'failed',
  );
});

// ── Resend gate ──────────────────────────────────────────────────────────────

check('D: resend success → enter signupCode + cooldown + sent', () => {
  const gate = decideSignupResendGate(null);
  assert.deepEqual(gate, {
    enterSignupCode: true,
    startCooldown: true,
    messageKind: 'sent',
  });
  assert.equal(canEnterSignupCode({ resendSucceeded: true }), true);
});

check('E: resend network/generic failure → no enter, no success message', () => {
  const gate = decideSignupResendGate('fetch failed');
  assert.equal(gate.enterSignupCode, false);
  assert.equal(gate.startCooldown, false);
  assert.equal(gate.messageKind, 'failed');
  assert.equal(signupCodeSuccessMessageKey(null), null);
});

check('E: resend rate limit → no enter as success; cooldown yes', () => {
  const gate = decideSignupResendGate('For security purposes, you can only request this after 60 seconds.');
  assert.equal(gate.enterSignupCode, false);
  assert.equal(gate.startCooldown, true);
  assert.equal(gate.messageKind, 'rateLimited');
});

check('SMTP-like generic failure does not claim sent', () => {
  const gate = decideSignupResendGate('Error sending confirmation email');
  assert.equal(gate.enterSignupCode, false);
  assert.equal(gate.messageKind, 'failed');
});

check('neutral verification copy when send not confirmed this session', () => {
  assert.equal(signupCodeDetailMessageKey('neutral'), 'auth.verifyDetailNeutral');
  assert.equal(signupCodeDetailMessageKey(null), 'auth.verifyDetailNeutral');
  assert.equal(signupCodeDetailMessageKey('sent'), 'auth.verifyDetail');
  assert.equal(signupCodeDetailMessageKey('resent'), 'auth.verifyDetail');
});

check('false-success prevention: empty identities never maps to sent banner alone', () => {
  const status = classifyPasswordSignupResult({
    error: null,
    user: { identities: [] },
    session: null,
  });
  assert.equal(status, 'existingOrObfuscated');
  assert.equal(canEnterSignupCode({ classification: status }), false);
  assert.equal(signupCodeSuccessMessageKey(undefined), null);
});

console.log(`\n${passed} auth-signup checks passed`);
