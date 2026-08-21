/**
 * Pure helpers for email/password signup classification and resend gating.
 * Keeps Create Account / Verification transitions free of false “code sent” claims.
 */

export type PasswordSignupClassification =
  | 'authenticated'
  | 'confirmationRequired'
  | 'existingOrObfuscated'
  | 'failed';

export type SignupCodeEntryReason = 'sent' | 'resent' | 'neutral';

export type ResendGateResult = {
  /** Only true when resend returned no error (mailer accepted the request). */
  enterSignupCode: boolean;
  /** Start local cooldown after a successful send or a rate-limit response. */
  startCooldown: boolean;
  messageKind: 'sent' | 'rateLimited' | 'failed';
};

const RESEND_RATE_LIMIT_PATTERN = /only request this|rate limit|too many|security purposes/i;

/** API-facing email: trim + lower-case only (preserves +aliases and domain). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isResendRateLimitError(message: string): boolean {
  return RESEND_RATE_LIMIT_PATTERN.test(message);
}

/**
 * Classify Supabase auth.signUp() outcomes.
 *
 * Never treat “user present + no session” alone as proof that a confirmation
 * email was sent — empty identities is the enumeration-protection fake success.
 */
export function classifyPasswordSignupResult(input: {
  error?: { message?: string } | null;
  user?: { identities?: unknown[] | null } | null;
  session?: unknown | null;
}): PasswordSignupClassification {
  if (input.error) return 'failed';
  if (input.session) return 'authenticated';
  if (!input.user) return 'failed';

  const identities = input.user.identities;
  // Missing/undefined identities: do not claim a new confirmation email was sent.
  if (!Array.isArray(identities)) return 'existingOrObfuscated';
  if (identities.length === 0) return 'existingOrObfuscated';
  return 'confirmationRequired';
}

/**
 * Gate navigation into the Verification Code step after a signup resend attempt.
 * Failures (including rate limit) must not enter as a successful “code sent” state.
 */
export function decideSignupResendGate(resendError: string | null | undefined): ResendGateResult {
  if (!resendError) {
    return { enterSignupCode: true, startCooldown: true, messageKind: 'sent' };
  }
  if (isResendRateLimitError(resendError)) {
    return { enterSignupCode: false, startCooldown: true, messageKind: 'rateLimited' };
  }
  return { enterSignupCode: false, startCooldown: false, messageKind: 'failed' };
}

/** Enter signupCode only after confirmationRequired signup or a successful resend. */
export function canEnterSignupCode(input: {
  classification?: PasswordSignupClassification | null;
  resendSucceeded?: boolean;
}): boolean {
  if (input.resendSucceeded) return true;
  return input.classification === 'confirmationRequired';
}

/**
 * Success banner for the verification step. Never claim “just sent” without
 * a confirmed send/resend in this session.
 */
export function signupCodeSuccessMessageKey(
  reason: SignupCodeEntryReason | null | undefined,
): 'auth.sentCode' | null {
  if (reason === 'sent' || reason === 'resent') return 'auth.sentCode';
  return null;
}

export function signupCodeDetailMessageKey(
  reason: SignupCodeEntryReason | null | undefined,
): 'auth.verifyDetail' | 'auth.verifyDetailNeutral' {
  if (reason === 'sent' || reason === 'resent') return 'auth.verifyDetail';
  return 'auth.verifyDetailNeutral';
}
